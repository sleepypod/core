// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import net, { type Socket } from 'node:net'
import tls from 'node:tls'
import https from 'node:https'
import { WebSocketServer } from 'ws'

// Deliberately load the installed library for loopback-only transport tests, bypassing the unit-suite stub alias.
vi.mock('mqtt', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url)('mqtt') }
})

const settings = vi.hoisted(() => ({ insecure: false }))
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ limit: async () => [{ mqttTlsInsecure: settings.insecure }] }) }) },
  biometricsDb: {},
}))
vi.mock('@/src/streaming/piezoStream', () => ({ onServerFrame: vi.fn() }))
vi.mock('@/src/telemetry/home', () => ({ readHomeTelemetry: vi.fn() }))
import { testConnection } from '../mqttBridge'

let directory: string, key: Buffer, cert: Buffer
const cleanups: (() => Promise<void>)[] = []
beforeAll(() => {
  vi.stubEnv('MQTTJS_SOCKS_PROXY', undefined)
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-mqtt-tls-'))
  const keyPath = join(directory, 'test.key'), certPath = join(directory, 'test.crt')
  // Ephemeral, loopback-only certificate; no fixture key or owner credential is stored in the repository.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' })
  chmodSync(keyPath, 0o600)
  key = readFileSync(keyPath)
  cert = readFileSync(certPath)
})
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  settings.insecure = false
})
afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/** A small local MQTT peer acknowledges CONNECT; no Pod, broker credentials or household topics are used. */
async function broker(protocol: 'mqtt' | 'mqtts' | 'wss') {
  let connections = 0, connectPackets = 0
  const sockets = new Set<Socket>()
  const acknowledge = (socket: Socket) => {
    socket.once('data', (packet) => {
      if (packet[0] === 0x10) {
        connectPackets++
        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]))
      }
    })
  }
  const server = protocol === 'mqtt'
    ? net.createServer(acknowledge)
    : protocol === 'mqtts' ? tls.createServer({ key, cert }, acknowledge) : https.createServer({ key, cert })
  server.on('connection', (socket: Socket) => {
    connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  server.on('tlsClientError', () => {})
  const websocket = protocol === 'wss' ? new WebSocketServer({ server: server as https.Server, path: '/mqtt' }) : null
  websocket?.on('connection', (socket) => {
    socket.once('message', (packet) => {
      if (Buffer.isBuffer(packet) && packet[0] === 0x10) {
        connectPackets++
        socket.send(Buffer.from([0x20, 0x02, 0x00, 0x00]))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    websocket?.clients.forEach(client => client.terminate())
    websocket?.close()
    sockets.forEach(socket => socket.destroy())
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const port = (server.address() as net.AddressInfo).port
  return { url: `${protocol}://127.0.0.1:${port}${protocol === 'wss' ? '/mqtt' : ''}`, connections: () => connections, packets: () => connectPackets }
}

describe('real loopback MQTT transports', () => {
  it('refuses required TLS before opening a plaintext socket', async () => {
    const peer = await broker('mqtt')
    expect(await testConnection({ url: peer.url, tlsEnabled: true, password: 'synthetic-only' })).toMatchObject({ ok: false, error: expect.stringContaining('TLS requires') })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(peer.connections()).toBe(0)
    expect(peer.packets()).toBe(0)
  })
  it('preserves explicitly selected plaintext MQTT', async () => {
    const peer = await broker('mqtt')
    expect(await testConnection({ url: peer.url, tlsEnabled: false })).toEqual({ ok: true })
    expect(peer.packets()).toBe(1)
  })
  it.each(['mqtts', 'wss'] as const)('performs the %s handshake with the explicit self-signed test override', async (protocol) => {
    settings.insecure = true
    const peer = await broker(protocol)
    expect(await testConnection({ url: peer.url, tlsEnabled: true })).toEqual({ ok: true })
    expect(peer.packets()).toBe(1)
  })
  it.each([true, false])('keeps certificate verification enabled for a secure URL with TLS requirement=%s', async (required) => {
    const peer = await broker('mqtts')
    settings.insecure = !required // The override also needs the explicit TLS flag.
    const result = await testConnection({ url: peer.url, tlsEnabled: required })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/certificate|self.signed/i)
    expect(peer.packets()).toBe(0)
  })
})

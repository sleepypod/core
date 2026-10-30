// @vitest-environment node
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net, { type Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { createRoomContextStore } from '../store'
import { createBedroomStore } from '@/src/bedroom/store'

vi.mock('mqtt', async () => ({ default: (await import('node:module')).createRequire(import.meta.url)('mqtt') }))
const runtime = vi.hoisted(() => ({ url: '', store: null as ReturnType<typeof createRoomContextStore> | null,
  bedroom: null as ReturnType<typeof createBedroomStore> | null, submit: vi.fn() }))
vi.mock('@/src/db', () => ({ db: { select: () => ({ from: () => ({ limit: async () => [{ mqttEnabled: true, mqttUrl: runtime.url, mqttHaDiscovery: false }] }) }) } }))
vi.mock('@/src/home-context/instance', () => ({ getRoomContext: () => runtime.store, getRoomContextIfRunning: () => runtime.store }))
vi.mock('@/src/bedroom/instance', () => ({ getBedroom: () => runtime.bedroom, getBedroomIfRunning: () => runtime.bedroom }))
vi.mock('@/src/streaming/piezoStream', () => ({ onServerFrame: () => () => {} }))
vi.mock('@/src/telemetry/home', () => ({ readHomeTelemetry: () => ({}) }))
vi.mock('@/src/controls/instance', () => ({ getControlService: () => ({ submit: runtime.submit }) }))
import { startMqttBridge, shutdownMqttBridge, getBridgeStatus } from '@/src/streaming/mqttBridge'

interface Packet { cmd: string, messageId: number, subscriptions?: { topic: string }[] }
const require = createRequire(import.meta.url)
const packets = createRequire(require.resolve('mqtt'))('mqtt-packet') as {
  parser: () => { parse: (buffer: Buffer) => void, on: (event: string, handler: (packet: Packet) => void) => void }
  generate: (packet: Record<string, unknown>) => Buffer
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await shutdownMqttBridge()
  for (const action of cleanup.splice(0)) await action()
  runtime.store = null
  runtime.bedroom = null
  vi.unstubAllEnvs()
})

it('receives mapped telemetry through the real MQTT library without enabling commands and withdraws it on disconnect', async () => {
  vi.stubEnv('MQTT_COMMANDS_ENABLED', 'false')
  vi.stubEnv('MQTTJS_SOCKS_PROXY', undefined)
  const directory = mkdtempSync(join(tmpdir(), 'room-mqtt-'))
  const database = migratedComfortDatabase(join(directory, 'test.db'))
  let now = 1793000000000
  const store = createRoomContextStore(database, () => now)
  runtime.store = store
  runtime.bedroom = createBedroomStore(database, () => now)
  store.configure({ enabled: true, roomName: 'Fixture', mappings: [{ metric: 'humidity', entityId: 'sensor.fixture_humidity', unit: '%', maxAgeSeconds: 60, timestampAttribute: 'sample_time', timestampFormat: 'iso8601' }] }, 0)
  const peers = new Set<Socket>()
  const subscriptions: string[] = []
  const server = net.createServer((socket) => {
    peers.add(socket)
    const parser = packets.parser()
    socket.on('data', buffer => parser.parse(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)))
    socket.on('error', () => {})
    parser.on('packet', (packet) => {
      if (packet.cmd === 'connect') socket.write(packets.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }))
      if (packet.cmd === 'subscribe') {
        subscriptions.push(...(packet.subscriptions ?? []).map(item => item.topic))
        socket.write(packets.generate({ cmd: 'suback', messageId: packet.messageId, granted: [0] }))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    peers.forEach(peer => peer.destroy())
    await new Promise<void>(resolve => server.close(() => resolve()))
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  runtime.url = `mqtt://127.0.0.1:${(server.address() as net.AddressInfo).port}`
  await startMqttBridge()
  await vi.waitFor(() => expect(store.status().connected).toBe(true))
  const topic = subscriptions.find(value => value.endsWith('/room/report'))
  expect(topic).toBeTruthy()
  expect(subscriptions.some(value => value.endsWith('/cmd/request'))).toBe(false)
  expect(getBridgeStatus().commandsEnabled).toBe(false)
  function send(retain: boolean, patch = {}) {
    const payload = JSON.stringify({ schemaVersion: 1, source: 'home_assistant', revision: 1, metric: 'humidity', entityId: 'sensor.fixture_humidity', unit: '%', available: true, value: 48, measuredAt: now - 1000, reportedAt: now, ...patch })
    peers.forEach(peer => peer.write(packets.generate({ cmd: 'publish', qos: 0, retain, dup: false, topic, payload })))
  }
  send(true)
  // A following PUBLISH is ordered after the retained packet on the same TCP stream.
  send(false, { revision: 999 })
  send(false)
  await vi.waitFor(() => expect(store.signals()).toEqual({ 'room.humidity': 48 }))
  expect(store.history().items).toHaveLength(1)
  now += 6000
  send(false, { measuredAt: now - 7000 })
  send(false, { available: false, value: null, measuredAt: null })
  await vi.waitFor(() => expect(store.status().observations[0].status).toBe('unavailable'))
  expect(store.signals()).toEqual({})
  expect(store.history().items).toHaveLength(2)
  peers.forEach(peer => peer.destroy())
  await vi.waitFor(() => expect(store.status().connected).toBe(false))
  expect(runtime.submit).not.toHaveBeenCalled()
})

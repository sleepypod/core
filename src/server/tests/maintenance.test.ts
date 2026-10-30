import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { requestBrokerRestart } from '../maintenance'

interface Request { requestId: string, invocationId: string, issuedAt: number, expiresAt: number, unit: string }
let directory: string
let socketPath: string
let server: Server
let sockets: Socket[]
let requests: Request[]

async function listen(reply: (socket: Socket, request: Request) => void) {
  server = createServer((socket) => {
    sockets.push(socket)
    let buffer = ''
    socket.on('data', (data) => {
      buffer += data.toString()
      if (!buffer.endsWith('\n')) return
      const request = JSON.parse(buffer) as Request
      requests.push(request)
      reply(socket, request)
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
}

beforeEach(() => {
  directory = mkdtempSync('/tmp/sleepypod-maint-')
  socketPath = join(directory, 'control.sock')
  sockets = []
  requests = []
  vi.stubEnv('INVOCATION_ID', 'a'.repeat(32))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const socket of sockets) socket.destroy()
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})

describe('restricted maintenance transport', () => {
  it.each(['accepted', 'rejected'] as const)('preserves a definite %s reply over the real Unix socket', async (outcome) => {
    await listen((socket, request) => socket.end(`${JSON.stringify({ requestId: request.requestId, outcome, message: 'Fixture receipt' })}\n`))
    expect(await requestBrokerRestart('sleepypod.service', socketPath)).toEqual({ ok: outcome === 'accepted', message: 'Fixture receipt' })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ version: 1, unit: 'sleepypod.service', invocationId: 'a'.repeat(32) })
    expect(requests[0].expiresAt - requests[0].issuedAt).toBe(5000)
  })

  it('accepts a complete fragmented reply', async () => {
    await listen((socket, request) => {
      const reply = `${JSON.stringify({ requestId: request.requestId, outcome: 'accepted', message: 'Requested' })}\n`
      socket.write(reply.slice(0, 20))
      setImmediate(() => socket.end(reply.slice(20)))
    })
    expect((await requestBrokerRestart('sleepypod.service', socketPath)).ok).toBe(true)
  })

  it.each(['unknown', 'wrong-id', 'truncated', 'oversized', 'multiple', 'invalid'])('keeps %s replies uncertain without retrying', async (kind) => {
    await listen((socket, request) => {
      if (kind === 'truncated') return socket.end('{')
      if (kind === 'oversized') return socket.end('x'.repeat(4097))
      if (kind === 'multiple') return socket.end('{}\n{}\n')
      if (kind === 'invalid') return socket.end('not JSON\n')
      socket.end(`${JSON.stringify({ requestId: kind === 'wrong-id' ? 'another' : request.requestId,
        outcome: kind === 'unknown' ? 'unknown' : 'accepted', message: 'Unconfirmed' })}\n`)
    })
    await expect(requestBrokerRestart('sleepypod.service', socketPath)).rejects.toThrow('could not be confirmed')
    expect(requests).toHaveLength(1)
  })

  it('keeps a lost connection uncertain without replay', async () => {
    await listen(socket => socket.destroy())
    await expect(requestBrokerRestart('sleepypod.service', socketPath)).rejects.toThrow('could not be confirmed')
    expect(requests).toHaveLength(1)
  })

  it('bounds the complete response deadline', async () => {
    let received!: () => void
    const ready = new Promise<void>((resolve) => {
      received = resolve
    })
    await listen(() => received())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const outcome = expect(requestBrokerRestart('sleepypod.service', socketPath)).rejects.toThrow('could not be confirmed')
    await ready
    await vi.advanceTimersByTimeAsync(8000)
    await outcome
    expect(requests).toHaveLength(1)
  })

  it('refuses an absent or invalid service invocation before connecting', async () => {
    await listen(() => {
      throw new Error('Unexpected connection')
    })
    for (const invocation of ['', 'bad', 'a'.repeat(31)]) {
      vi.stubEnv('INVOCATION_ID', invocation)
      expect((await requestBrokerRestart('sleepypod.service', socketPath)).ok).toBe(false)
    }
    expect(requests).toHaveLength(0)
  })
})

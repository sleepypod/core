// @vitest-environment node
/**
 * Tests for the loopback-NATS frame source:
 *   - The reachability probe (real INFO greeting vs silent socket vs refused).
 *   - Fixture payloads from the field capture decoding through the shared decode
 *     path and reaching onFrame, with the piezo int32 conversion applied.
 *   - Subscription subjects, decode-failure counting, silence health-log, stop().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as net from 'node:net'
import fixtures from './fixtures/natsFrames.json'

// Fake @nats-io/transport-node so the source connects to an in-memory client we
// drive by hand. State lives in vi.hoisted so the (hoisted) vi.mock factory can
// see it and the tests can push messages / inspect connect options.
const nats = vi.hoisted(() => {
  interface Sub { subject: string, cb: (err: Error | null, msg: { data: Uint8Array }) => void }
  const state = {
    subs: [] as Sub[],
    connectOpts: null as Record<string, unknown> | null,
    drained: false,
    closedResolve: null as (() => void) | null,
  }
  const makeNc = () => ({
    subscribe(subject: string, opts: { callback: Sub['cb'] }) {
      state.subs.push({ subject, cb: opts.callback })
      return { unsubscribe: () => {} }
    },
    // Status iterator that yields no transitions in these tests.
    status: () => ({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.resolve({ done: true, value: undefined }) }
      },
    }),
    closed: () => new Promise<void>((res) => { state.closedResolve = res }),
    drain: async () => {
      state.drained = true
      state.closedResolve?.()
    },
    close: async () => { state.drained = true },
  })
  const connect = vi.fn(async (opts: Record<string, unknown>) => {
    state.connectOpts = opts
    return makeNc()
  })
  return { state, connect }
})

vi.mock('@nats-io/transport-node', () => ({ connect: nats.connect }))

import { natsReachable, startNatsFrameSource, SUBSCRIBE_SUBJECTS } from '../natsFrameSource'
import { __test__ as piezo } from '../piezoStream'

const decode = piezo.decodeSensorFrames

function fixture(subject: string): Buffer {
  const f = fixtures.frames.find(x => x.subject === subject)
  if (!f) throw new Error(`no fixture for ${subject}`)
  return Buffer.from(f.payloadB64, 'base64')
}

/** Deliver a payload to whichever subscription's wildcard covers `subject`. */
function deliver(subject: string, payload: Uint8Array): void {
  const prefix = (s: string) => s.endsWith('.>') ? s.slice(0, -1) : `${s}.`
  const sub = nats.state.subs.find(s => subject.startsWith(prefix(s.subject)))
  if (!sub) throw new Error(`no subscription matches ${subject}`)
  sub.cb(null, { data: payload })
}

describe('natsReachable', () => {
  const servers: net.Server[] = []
  afterEach(() => {
    for (const s of servers) s.close()
    servers.length = 0
  })

  function listen(onConn: (sock: net.Socket) => void): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer(onConn)
      servers.push(server)
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as net.AddressInfo).port)
      })
    })
  }

  it('is true when the server greets with an INFO line (like nats-server)', async () => {
    const port = await listen(sock => sock.write('INFO {"server_id":"x"}\r\n'))
    expect(await natsReachable({ host: '127.0.0.1', port, timeoutMs: 500 })).toBe(true)
  })

  it('is true when TCP fragments the INFO greeting', async () => {
    const port = await listen((sock) => {
      sock.write('IN')
      setImmediate(() => sock.end('FO {"server_id":"x"}\r\n'))
    })
    expect(await natsReachable({ host: '127.0.0.1', port, timeoutMs: 500 })).toBe(true)
  })

  it('is false for an open port that never greets', async () => {
    const port = await listen(() => { /* accept but stay silent */ })
    expect(await natsReachable({ host: '127.0.0.1', port, timeoutMs: 200 })).toBe(false)
  })

  it('is false when the peer closes before sending a greeting', async () => {
    const port = await listen(sock => sock.end())
    expect(await natsReachable({ host: '127.0.0.1', port, timeoutMs: 500 })).toBe(false)
  })

  it('is false when the connection is refused', async () => {
    // Bind then immediately close to get a port nothing is listening on.
    const port = await listen(() => {})
    const server = servers.pop()
    server?.close()
    expect(await natsReachable({ host: '127.0.0.1', port, timeoutMs: 300 })).toBe(false)
  })
})

describe('startNatsFrameSource', () => {
  beforeEach(() => {
    nats.state.subs.length = 0
    nats.state.connectOpts = null
    nats.state.drained = false
    nats.state.closedResolve = null
    nats.connect.mockClear()
  })

  it('subscribes to the sensor subjects with infinite reconnect', async () => {
    const onFrame = vi.fn()
    await startNatsFrameSource({ decode, onFrame })
    expect(nats.state.subs.map(s => s.subject)).toEqual([...SUBSCRIBE_SUBJECTS])
    expect(nats.state.connectOpts).toMatchObject({
      servers: '127.0.0.1:4222',
      maxReconnectAttempts: -1,
      waitOnFirstConnect: true,
    })
  })

  it('excludes raw.log from the live subscriptions', () => {
    expect(SUBSCRIBE_SUBJECTS).toEqual(['raw.sens.>', 'raw.frz.>'])
    expect(SUBSCRIBE_SUBJECTS as readonly string[]).not.toContain('raw.log')
  })

  it('decodes a capSense fixture through to onFrame and counts it', async () => {
    const onFrame = vi.fn()
    const src = await startNatsFrameSource({ decode, onFrame })
    deliver('raw.sens.capsense', fixture('raw.sens.capsense'))
    expect(onFrame).toHaveBeenCalledTimes(1)
    const frame = onFrame.mock.calls[0][0]
    expect(frame.type).toBe('capSense')
    expect(frame.left).toMatchObject({ out: 3288, status: 'good' })
    expect(src.stats).toMatchObject({ messages: 1, framesDecoded: 1, decodeFailures: 0 })
  })

  it('applies the piezo int32 conversion (2000-byte string → 500 samples)', async () => {
    const onFrame = vi.fn()
    await startNatsFrameSource({ decode, onFrame })
    deliver('raw.sens.piezo', fixture('raw.sens.piezo'))
    const frame = onFrame.mock.calls[0][0]
    expect(frame.type).toBe('piezo-dual')
    expect(Array.isArray(frame.left1)).toBe(true)
    expect(frame.left1).toHaveLength(500)
    expect(frame.left1.every((n: number) => Number.isInteger(n))).toBe(true)
  })

  it('routes a freezer-subject fixture through the raw.frz.> subscription', async () => {
    const onFrame = vi.fn()
    await startNatsFrameSource({ decode, onFrame })
    deliver('raw.frz.health', fixture('raw.frz.health'))
    expect(onFrame.mock.calls[0][0].type).toBe('frzHealth')
  })

  it('passes new/out-of-scope types (blanketReadings) through without throwing', async () => {
    const onFrame = vi.fn()
    await startNatsFrameSource({ decode, onFrame })
    deliver('raw.sens.blanket', fixture('raw.sens.blanket'))
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(onFrame.mock.calls[0][0].type).toBe('blanketReadings')
  })

  it('counts a malformed payload as a decode failure and does not dispatch it', async () => {
    const onFrame = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = await startNatsFrameSource({ decode, onFrame })
    deliver('raw.sens.capsense', new Uint8Array([0x00, 0x01, 0x02]))
    expect(onFrame).not.toHaveBeenCalled()
    expect(src.stats).toMatchObject({ messages: 1, framesDecoded: 0, decodeFailures: 1 })
    vi.restoreAllMocks()
  })

  it('invokes onReady once subscriptions are live', async () => {
    const onReady = vi.fn()
    await startNatsFrameSource({ decode, onFrame: vi.fn(), onReady })
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('drains the connection on stop()', async () => {
    const src = await startNatsFrameSource({ decode, onFrame: vi.fn() })
    await src.stop()
    expect(nats.state.drained).toBe(true)
  })
})

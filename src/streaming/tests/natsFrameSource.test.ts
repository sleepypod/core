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
  interface Sub { subject: string, cb: (err: Error | null, msg: { subject: string, data: Uint8Array }) => void }
  const state = {
    subs: [] as Sub[],
    connectOpts: null as Record<string, unknown> | null,
    drained: false,
    closedResolve: null as ((err?: Error) => void) | null,
    statusEvents: [] as Array<{ type: string }>,
  }
  const makeNc = () => ({
    subscribe(subject: string, opts: { callback: Sub['cb'] }) {
      state.subs.push({ subject, cb: opts.callback })
      return { unsubscribe: () => {} }
    },
    status: () => ({
      [Symbol.asyncIterator]() {
        let index = 0
        return {
          next: () => Promise.resolve(index < state.statusEvents.length
            ? { done: false, value: state.statusEvents[index++] }
            : { done: true, value: undefined }),
        }
      },
    }),
    closed: () => new Promise<Error | undefined>((res) => { state.closedResolve = res }),
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

import { natsReachable, natsSubjectPrefixes, startNatsFrameSource, SUBJECT_PREFIXES } from '../natsFrameSource'
import { __test__ as piezo } from '../piezoStream'

const decode = piezo.decodeSensorFrames

function fixture(subject: string): Buffer {
  const f = fixtures.frames.find(x => x.subject === subject)
  if (!f) throw new Error(`no fixture for ${subject}`)
  return Buffer.from(f.payloadB64, 'base64')
}

/** NATS wildcard match: `*` is one token, a trailing `>` is one or more. */
function matches(pattern: string, subject: string): boolean {
  const p = pattern.split('.')
  const t = subject.split('.')
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return t.length > i
    if (i >= t.length || (p[i] !== '*' && p[i] !== t[i])) return false
  }
  return p.length === t.length
}

/** Deliver a payload to every subscription whose wildcard covers `subject`, like a NATS server. */
function deliver(subject: string, payload: Uint8Array): void {
  const subs = nats.state.subs.filter(s => matches(s.subject, subject))
  if (subs.length === 0) throw new Error(`no subscription matches ${subject}`)
  for (const sub of subs) sub.cb(null, { subject, data: payload })
}

const DISCOVERY = '*.sens.>'

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

  it('is false when the peer sends a non-NATS greeting', async () => {
    const port = await listen(sock => sock.end('HTTP/1.1 200 OK\r\n'))
    expect(await natsReachable({ host: '127.0.0.1', port, timeoutMs: 500 })).toBe(false)
  })

  it('is false when an unterminated INFO greeting exceeds the byte cap', async () => {
    const oversized = Buffer.concat([Buffer.from('INFO '), Buffer.alloc(16 * 1024, 0x20)])
    const port = await listen(sock => sock.end(oversized))
    expect(await natsReachable({ host: '127.0.0.1', port, timeoutMs: 500 })).toBe(false)
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
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    nats.state.subs.length = 0
    nats.state.connectOpts = null
    nats.state.drained = false
    nats.state.closedResolve = null
    nats.state.statusEvents.length = 0
    nats.connect.mockClear()
  })

  it('subscribes to the sensor subjects with infinite reconnect', async () => {
    const onFrame = vi.fn()
    const src = await startNatsFrameSource({ decode, onFrame })
    expect(nats.state.subs.map(s => s.subject)).toEqual(['raw.sens.>', 'raw.frz.>', 'rawmem.sens.>', 'rawmem.frz.>', DISCOVERY])
    expect(src.stats.subjects).toEqual(['raw.sens.>', 'raw.frz.>', 'rawmem.sens.>', 'rawmem.frz.>'])
    expect(nats.state.connectOpts).toMatchObject({
      servers: '127.0.0.1:4222',
      maxReconnectAttempts: -1,
      waitOnFirstConnect: false,
    })
  })

  it('decodes a capSense fixture through to onFrame and counts it', async () => {
    const onFrame = vi.fn()
    const src = await startNatsFrameSource({ decode, onFrame })
    deliver('raw.sens.capsense', fixture('raw.sens.capsense'))
    expect(onFrame).toHaveBeenCalledTimes(1)
    const frame = onFrame.mock.calls[0][0]
    expect(frame.type).toBe('capSense')
    expect(frame.left).toMatchObject({ out: 3288, status: 'good' })
    expect(src.stats).toMatchObject({ messages: 1, framesDecoded: 1, decodeFailures: 0, sources: { 'sens.capsense': 'raw' }, ignoredMessages: 0 })
  })

  it('reads only a pinned prefix, with no startup grace to wait out', async () => {
    const onFrame = vi.fn()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const src = await startNatsFrameSource({ decode, onFrame, prefixes: ['rawmem'] })

    expect(nats.state.subs.map(s => s.subject)).toEqual(['rawmem.sens.>', 'rawmem.frz.>', DISCOVERY])
    deliver('rawmem.sens.bedtemp', fixture('raw.sens.bedtemp'))
    expect(() => deliver('raw.frz.health', fixture('raw.frz.health'))).toThrow('no subscription matches')
    deliver('raw.sens.bedtemp', fixture('raw.sens.bedtemp'))

    expect(onFrame.mock.calls.map(([frame]) => frame.type)).toEqual(['bedTemp'])
    expect(src.stats).toMatchObject({ messages: 1, sources: { 'sens.bedtemp': 'rawmem' }, ignoredMessages: 0 })
  })

  it('records every prefix publishing sensor subjects without feeding frames from discovery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(10_000)
      const onFrame = vi.fn()
      const decodeSpy = vi.fn(decode)
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const src = await startNatsFrameSource({ decode: decodeSpy, onFrame, prefixes: ['raw'] })

      deliver('raw.sens.bedtemp', fixture('raw.sens.bedtemp'))
      deliver('rawmem.sens.bedtemp', fixture('raw.sens.bedtemp'))
      vi.setSystemTime(12_000)
      deliver('rawmem.sens.piezo', fixture('raw.sens.piezo'))

      expect(onFrame).toHaveBeenCalledTimes(1)
      expect(decodeSpy).toHaveBeenCalledTimes(1)
      expect(src.stats.messages).toBe(1)
      expect(src.stats.observedPrefixes).toEqual({
        raw: { messages: 1, lastSeenMs: 10_000 },
        rawmem: { messages: 2, lastSeenMs: 12_000 },
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('bounds how many publishing prefixes discovery remembers', async () => {
    const src = await startNatsFrameSource({ decode, onFrame: vi.fn(), prefixes: ['raw'] })
    for (let i = 0; i < 20; i++) deliver(`p${i}.sens.x`, new Uint8Array())
    expect(Object.keys(src.stats.observedPrefixes)).toHaveLength(16)
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

  it.each(['raw', 'rawmem'])('routes sensor and freezer frames on %s', async (prefix) => {
    const onFrame = vi.fn()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await startNatsFrameSource({ decode, onFrame, fallbackGraceMs: 0 })
    deliver(`${prefix}.sens.bedtemp`, fixture('raw.sens.bedtemp'))
    deliver(`${prefix}.frz.health`, fixture('raw.frz.health'))
    expect(onFrame.mock.calls.map(([frame]) => frame.type)).toEqual(['bedTemp', 'frzHealth'])
    expect(() => deliver(`${prefix}.log`, new Uint8Array())).toThrow('no subscription matches')
  })

  it('holds rawmem back during the startup grace so raw can claim each subject', async () => {
    const onFrame = vi.fn()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const src = await startNatsFrameSource({ decode, onFrame })

    deliver('rawmem.sens.bedtemp', fixture('raw.sens.bedtemp'))

    expect(onFrame).not.toHaveBeenCalled()
    expect(src.stats).toMatchObject({ messages: 0, sources: {}, ignoredMessages: 1 })
  })

  it('feeds each subject from raw when raw publishes it, and from rawmem only otherwise', async () => {
    const onFrame = vi.fn()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = await startNatsFrameSource({ decode, onFrame, fallbackGraceMs: 0 })

    const log = vi.mocked(console.log)
    deliver('raw.sens.bedtemp', fixture('raw.sens.bedtemp'))
    deliver('rawmem.sens.bedtemp', fixture('raw.sens.bedtemp'))
    deliver('raw.sens.bedtemp', fixture('raw.sens.bedtemp'))
    deliver('rawmem.sens.bedtemp', fixture('raw.sens.bedtemp'))
    deliver('rawmem.frz.health', fixture('raw.frz.health'))

    expect(onFrame.mock.calls.map(([frame]) => frame.type)).toEqual(['bedTemp', 'bedTemp', 'frzHealth'])
    expect(src.stats).toMatchObject({
      messages: 3,
      sources: { 'sens.bedtemp': 'raw', 'frz.health': 'rawmem' },
      ignoredMessages: 2,
    })
    expect(log.mock.calls.filter(([message]) => message === '[natsSource] reading %s from %s')).toHaveLength(2)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('[natsSource] ignoring %s — %s.%s already feeds it', 'rawmem.sens.bedtemp', 'raw', 'sens.bedtemp')
  })

  it('hands a subject back to raw when raw starts publishing it', async () => {
    const onFrame = vi.fn()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = await startNatsFrameSource({ decode, onFrame, fallbackGraceMs: 0 })

    deliver('rawmem.sens.bedtemp', fixture('raw.sens.bedtemp'))
    deliver('raw.sens.bedtemp', fixture('raw.sens.bedtemp'))
    deliver('rawmem.sens.bedtemp', fixture('raw.sens.bedtemp'))

    expect(onFrame).toHaveBeenCalledTimes(2)
    expect(src.stats).toMatchObject({ sources: { 'sens.bedtemp': 'raw' }, ignoredMessages: 1 })
  })

  it('lets rawmem take a subject over once raw has been silent on it for a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const onFrame = vi.fn()
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const src = await startNatsFrameSource({ decode, onFrame, fallbackGraceMs: 0 })

      deliver('raw.sens.piezo', fixture('raw.sens.piezo'))
      vi.advanceTimersByTime(59_000)
      deliver('rawmem.sens.piezo', fixture('raw.sens.piezo'))
      expect(onFrame).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(2_000)
      deliver('rawmem.sens.piezo', fixture('raw.sens.piezo'))
      deliver('raw.sens.piezo', fixture('raw.sens.piezo'))

      expect(onFrame).toHaveBeenCalledTimes(3)
      expect(src.stats).toMatchObject({ sources: { 'sens.piezo': 'raw' }, ignoredMessages: 1 })
      expect(log).toHaveBeenCalledWith('[natsSource] reading %s from %s', 'sens.piezo', 'rawmem.sens.piezo')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('does not let an undecodable raw message claim a subject', async () => {
    const onFrame = vi.fn()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = await startNatsFrameSource({ decode, onFrame, fallbackGraceMs: 0 })

    deliver('raw.sens.bedtemp', new Uint8Array([0x00]))
    deliver('rawmem.sens.bedtemp', fixture('raw.sens.bedtemp'))

    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(src.stats.sources).toEqual({ 'sens.bedtemp': 'rawmem' })
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
  })

  it('counts a decoder exception as a decode failure', async () => {
    const onFrame = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = await startNatsFrameSource({
      decode: () => { throw new Error('bad cbor') },
      onFrame,
    })

    deliver('raw.sens.capsense', new Uint8Array([0xFF]))

    expect(onFrame).not.toHaveBeenCalled()
    expect(src.stats).toMatchObject({ messages: 1, framesDecoded: 0, decodeFailures: 1 })
    await src.stop()
    warn.mockRestore()
  })

  it('surfaces subscription errors without counting them as messages', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = await startNatsFrameSource({ decode, onFrame: vi.fn() })

    nats.state.subs[0].cb(new Error('permission denied'), { subject: 'raw.sens.capsense', data: new Uint8Array() })

    expect(src.stats.messages).toBe(0)
    expect(warn).toHaveBeenCalledWith('[natsSource] subscription error:', 'permission denied')
    await src.stop()
    warn.mockRestore()
  })

  it('logs disconnect/reconnect transitions and reports a permanent close', async () => {
    nats.state.statusEvents.push({ type: 'disconnect' }, { type: 'reconnect' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onClose = vi.fn()
    const src = await startNatsFrameSource({ decode, onFrame: vi.fn(), onClose })

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('[natsSource] disconnected from NATS — reconnecting')
      expect(log).toHaveBeenCalledWith('[natsSource] reconnected to NATS')
    })

    const closeError = new Error('connection closed')
    nats.state.closedResolve?.(closeError)
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(closeError))
    expect(error).toHaveBeenCalledWith(
      '[natsSource] NATS connection closed permanently',
      closeError,
    )

    await src.stop()
    log.mockRestore()
    warn.mockRestore()
    error.mockRestore()
  })

  it('names a publishing prefix it does not read when its own subjects stay silent', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const src = await startNatsFrameSource({ decode, onFrame: vi.fn() })
      deliver('rawv2.sens.piezo', fixture('raw.sens.piezo'))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(warn).toHaveBeenCalledWith(
        '[natsSource] firmware publishes under %s, which this reader does not subscribe to — set natsSubjectPrefix to read it',
        'rawv2',
      )
      await src.stop()
    }
    finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('warns once when the subscription stays silent', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const src = await startNatsFrameSource({ decode, onFrame: vi.fn() })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(warn).toHaveBeenCalledWith(
        '[natsSource] no frames received %ds after subscribing — sensor idle or firmware not publishing',
        60,
      )
      await src.stop()
    }
    finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
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

describe('natsSubjectPrefixes', () => {
  it('reads auto when unset and the pin when valid', () => {
    expect(natsSubjectPrefixes(null)).toBe(SUBJECT_PREFIXES)
    expect(natsSubjectPrefixes(undefined)).toBe(SUBJECT_PREFIXES)
    expect(natsSubjectPrefixes('rawmem')).toEqual(['rawmem'])
  })

  it.each(['raw.sens', '*', '>', '', 'x'.repeat(33)])('reads an invalid stored value %j as auto', (stored) => {
    expect(natsSubjectPrefixes(stored)).toBe(SUBJECT_PREFIXES)
  })
})

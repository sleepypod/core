// @vitest-environment node
/**
 * Tests for the WebSocket streaming resource-management surfaces:
 *   - Bounded frame index (issue #324 — was unbounded, ~70MB at 24h)
 *   - Per-client cleanup on disconnect
 *   - Backpressure guard on outbound sends
 *   - Transport-level config (maxPayload)
 *   - Server-side listener fan-out and broadcastFrame gating
 *   - Live file-tailing, subscribe/seek/get_time_range message dispatch,
 *     malformed-record resync, and graceful shutdown.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Encoder } from 'cbor-x'
import { WebSocket as WsClient } from 'ws'

// Set env BEFORE the static import below so module-level constants pick up
// our test values. vi.hoisted runs above all imports.
const tmpRawDir = vi.hoisted(() => {
  const fsh = require('node:fs') as typeof import('node:fs')
  const osh = require('node:os') as typeof import('node:os')
  const pth = require('node:path') as typeof import('node:path')
  const dir = fsh.mkdtempSync(pth.join(osh.tmpdir(), 'piezo-stream-test-'))
  process.env.RAW_DATA_DIR = dir
  process.env.PIEZO_WS_PORT = '0'
  return dir
})

vi.mock('@/src/hardware/dacMonitor.instance', () => {
  const monitor = { setActive: vi.fn(), setIdle: vi.fn() }
  return {
    getDacMonitorIfRunning: vi.fn(() => monitor),
    __monitor: monitor,
  }
})

import {
  __test__,
  broadcastFrame,
  getLatestCapSenseSnapshot,
  onServerFrame,
  startPiezoStreamServer,
  shutdownPiezoStreamServer,
} from '../piezoStream'

const {
  appendFrameIndex,
  cleanupClient,
  sendWithBackpressure,
  frameIndex,
  clientSubscriptions,
  clientDroppedFrames,
  FRAME_INDEX_RETENTION_S,
  MAX_BUFFERED_BYTES,
  WS_MAX_PAYLOAD_BYTES,
  resetFrameIndex,
} = __test__

/**
 * Minimal stand-in for a `ws.WebSocket` — only the members the streaming
 * code touches (readyState, bufferedAmount, send). Keeps tests fast and
 * deterministic without spinning up a real socket.
 */
interface FakeWs {
  readyState: number
  bufferedAmount: number
  sent: string[]
  sendThrows: boolean
  send: (p: string) => void
}

function fakeWs(opts: Partial<FakeWs> = {}): FakeWs {
  const ws: FakeWs = {
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    sent: [],
    sendThrows: false,
    send(p: string) {
      if (this.sendThrows) throw new Error('send failed')
      this.sent.push(p)
    },
    ...opts,
  }
  return ws
}

describe('piezoStream — bounded frame index', () => {
  beforeEach(() => {
    resetFrameIndex()
  })

  it('retains entries within the seek-retention window', () => {
    const base = 1_000_000
    for (let i = 0; i < 5; i++) {
      appendFrameIndex({ ts: base + i, offset: i * 100 })
    }
    expect(frameIndex.length).toBe(5)
    expect(frameIndex[0].ts).toBe(base)
    expect(frameIndex[4].ts).toBe(base + 4)
  })

  it('evicts entries older than FRAME_INDEX_RETENTION_S', () => {
    const base = 1_000_000
    // Push an old entry, then a newer one outside the retention window
    appendFrameIndex({ ts: base, offset: 0 })
    appendFrameIndex({ ts: base + FRAME_INDEX_RETENTION_S + 5, offset: 100 })
    // The old entry must have been evicted
    expect(frameIndex.length).toBe(1)
    expect(frameIndex[0].ts).toBe(base + FRAME_INDEX_RETENTION_S + 5)
  })

  it('stays bounded over a long run (24h at 50fps would have been ~4.3M entries)', () => {
    // Simulate a stream producing one entry per second for ~10x the window.
    // Without bounding, this would hold 10*FRAME_INDEX_RETENTION_S entries.
    const base = 1_000_000
    const total = FRAME_INDEX_RETENTION_S * 10
    for (let i = 0; i < total; i++) {
      appendFrameIndex({ ts: base + i, offset: i * 100 })
    }
    // Must not exceed the retention window (+1 for the just-appended entry).
    expect(frameIndex.length).toBeLessThanOrEqual(FRAME_INDEX_RETENTION_S + 1)
    // Newest entry must still be present.
    expect(frameIndex[frameIndex.length - 1].ts).toBe(base + total - 1)
  })

  it('keeps entries monotonic in ts after eviction', () => {
    const base = 1_000_000
    for (let i = 0; i < 200; i++) {
      appendFrameIndex({ ts: base + i, offset: i * 100 })
    }
    for (let i = 1; i < frameIndex.length; i++) {
      expect(frameIndex[i].ts).toBeGreaterThanOrEqual(frameIndex[i - 1].ts)
    }
  })

  it('does not grow when the same ts is pushed repeatedly (entries still retained within window)', () => {
    const base = 1_000_000
    for (let i = 0; i < 100; i++) {
      appendFrameIndex({ ts: base, offset: i })
    }
    // All entries share the same ts so none can be evicted by the time cutoff,
    // but the caller only ever appends one per parsed frame so this is still
    // bounded by the frame production rate. The test documents that behavior.
    expect(frameIndex.length).toBe(100)
    expect(frameIndex.every(e => e.ts === base)).toBe(true)
  })
})

describe('piezoStream — per-client cleanup', () => {
  beforeEach(() => {
    clientSubscriptions.clear()
    clientDroppedFrames.clear()
  })

  it('removes subscription entry on cleanup', () => {
    const ws = fakeWs() as unknown as Parameters<typeof cleanupClient>[0]
    clientSubscriptions.set(ws, new Set(['piezo-dual']))
    expect(clientSubscriptions.has(ws)).toBe(true)
    cleanupClient(ws)
    expect(clientSubscriptions.has(ws)).toBe(false)
  })

  it('removes dropped-frame counter on cleanup', () => {
    const ws = fakeWs() as unknown as Parameters<typeof cleanupClient>[0]
    clientDroppedFrames.set(ws, 42)
    expect(clientDroppedFrames.has(ws)).toBe(true)
    cleanupClient(ws)
    expect(clientDroppedFrames.has(ws)).toBe(false)
  })

  it('is a no-op for clients that were never tracked', () => {
    const ws = fakeWs() as unknown as Parameters<typeof cleanupClient>[0]
    expect(() => cleanupClient(ws)).not.toThrow()
    expect(clientSubscriptions.has(ws)).toBe(false)
    expect(clientDroppedFrames.has(ws)).toBe(false)
  })
})

describe('piezoStream — backpressure', () => {
  beforeEach(() => {
    clientDroppedFrames.clear()
  })

  it('sends when the client buffer is below the threshold', () => {
    const ws = fakeWs({ bufferedAmount: 0 })
    const ok = sendWithBackpressure(ws as never, 'payload-1')
    expect(ok).toBe(true)
    expect(ws.sent).toEqual(['payload-1'])
    expect(clientDroppedFrames.get(ws as never) ?? 0).toBe(0)
  })

  it('drops the send when the client buffer exceeds the threshold', () => {
    const ws = fakeWs({ bufferedAmount: MAX_BUFFERED_BYTES + 1 })
    const ok = sendWithBackpressure(ws as never, 'payload-1')
    expect(ok).toBe(false)
    expect(ws.sent).toEqual([])
    expect(clientDroppedFrames.get(ws as never)).toBe(1)
  })

  it('pauses the producer for a stalled client (drops repeatedly without unbounded send)', () => {
    const ws = fakeWs({ bufferedAmount: MAX_BUFFERED_BYTES * 2 })
    for (let i = 0; i < 1000; i++) {
      sendWithBackpressure(ws as never, `frame-${i}`)
    }
    // All sends must be dropped — nothing actually transmitted.
    expect(ws.sent.length).toBe(0)
    expect(clientDroppedFrames.get(ws as never)).toBe(1000)
  })

  it('resumes sending when the client buffer drains', () => {
    const ws = fakeWs({ bufferedAmount: MAX_BUFFERED_BYTES + 1 })
    sendWithBackpressure(ws as never, 'dropped')
    expect(ws.sent).toEqual([])
    ws.bufferedAmount = 0
    sendWithBackpressure(ws as never, 'sent')
    expect(ws.sent).toEqual(['sent'])
    expect(clientDroppedFrames.get(ws as never)).toBe(1)
  })

  it('skips closed clients without crashing', () => {
    const ws = fakeWs({ readyState: 3 /* CLOSED */ })
    const ok = sendWithBackpressure(ws as never, 'payload')
    expect(ok).toBe(false)
    expect(ws.sent).toEqual([])
  })

  it('swallows send errors (client vanished between check and send)', () => {
    const ws = fakeWs({ sendThrows: true })
    const ok = sendWithBackpressure(ws as never, 'payload')
    expect(ok).toBe(false)
  })

  it('rejects when bufferedAmount + payload size would exceed the threshold', () => {
    // Payload-size-aware guard: at exactly MAX, any non-empty send would push
    // past the cap. Reject so the buffer never crosses MAX_BUFFERED_BYTES.
    const ws = fakeWs({ bufferedAmount: MAX_BUFFERED_BYTES })
    const ok = sendWithBackpressure(ws as never, 'payload')
    expect(ok).toBe(false)
    expect(ws.sent).toEqual([])
    expect(clientDroppedFrames.get(ws as never)).toBe(1)
  })

  it('allows when bufferedAmount + payload size stays at the threshold', () => {
    const payload = 'payload'
    const payloadSize = Buffer.byteLength(payload)
    const ws = fakeWs({ bufferedAmount: MAX_BUFFERED_BYTES - payloadSize })
    const ok = sendWithBackpressure(ws as never, payload)
    expect(ok).toBe(true)
    expect(ws.sent).toEqual([payload])
  })
})

describe('piezoStream — transport config', () => {
  it('limits inbound WebSocket messages to a small payload', () => {
    // Client messages are subscribe / get_time_range / seek — all tiny JSON.
    // Keep the limit small so a malicious client can't exhaust memory with
    // one oversized message before the framing layer closes the connection.
    expect(WS_MAX_PAYLOAD_BYTES).toBeLessThanOrEqual(4 * 1024)
    expect(WS_MAX_PAYLOAD_BYTES).toBeGreaterThanOrEqual(256)
  })

  it('backpressure threshold is large enough for bursts but small enough to bound memory', () => {
    expect(MAX_BUFFERED_BYTES).toBeGreaterThan(64 * 1024)
    expect(MAX_BUFFERED_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024)
  })
})

// ---------------------------------------------------------------------------
// Outer CBOR record builder — wraps a CBOR-encoded inner blob with the
// {seq, data} map the firmware writes to .RAW files.
// ---------------------------------------------------------------------------

const innerEncoder = new Encoder({ mapsAsObjects: true, useRecords: false })

function encodeSeqValue(seq: number): Buffer {
  if (seq <= 23) return Buffer.from([seq])
  if (seq < 0x100) return Buffer.from([0x18, seq])
  if (seq < 0x10000) {
    const b = Buffer.alloc(3)
    b[0] = 0x19
    b.writeUInt16BE(seq, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = 0x1a
  b.writeUInt32BE(seq, 1)
  return b
}

function encodeByteString(payload: Buffer): Buffer {
  const len = payload.length
  if (len <= 23) return Buffer.concat([Buffer.from([0x40 | len]), payload])
  if (len < 0x100) return Buffer.concat([Buffer.from([0x58, len]), payload])
  if (len < 0x10000) {
    const head = Buffer.alloc(3)
    head[0] = 0x59
    head.writeUInt16BE(len, 1)
    return Buffer.concat([head, payload])
  }
  const head = Buffer.alloc(5)
  head[0] = 0x5a
  head.writeUInt32BE(len, 1)
  return Buffer.concat([head, payload])
}

const encodeSeqValueExposed = encodeSeqValue
const encodeByteStringExposed = encodeByteString

function buildOuterRecord(seq: number, innerFrames: Record<string, unknown>[]): Buffer {
  const inner = innerFrames.length === 0
    ? Buffer.alloc(0)
    : Buffer.concat(innerFrames.map(f => Buffer.from(innerEncoder.encode(f))))
  const seqBytes = encodeSeqValue(seq)
  const dataBytes = encodeByteString(inner)
  return Buffer.concat([
    Buffer.from([0xa2]), // map(2)
    Buffer.from([0x63, 0x73, 0x65, 0x71]), // "seq"
    seqBytes,
    Buffer.from([0x64, 0x64, 0x61, 0x74, 0x61]), // "data"
    dataBytes,
  ])
}

function int32Buffer(values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 4)
  for (let i = 0; i < values.length; i++) b.writeInt32LE(values[i], i * 4)
  return b
}

// ---------------------------------------------------------------------------
// Server-side listener fan-out / broadcastFrame gating
// ---------------------------------------------------------------------------

describe('piezoStream — broadcastFrame and onServerFrame', () => {
  beforeEach(() => {
    clientSubscriptions.clear()
    clientDroppedFrames.clear()
  })

  it('invokes registered server-frame listeners with the frame payload', () => {
    const cb = vi.fn()
    const unsub = onServerFrame(cb)
    broadcastFrame({ type: 'frzHealth', ts: 1, foo: 'bar' })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toMatchObject({ type: 'frzHealth', ts: 1, foo: 'bar' })
    unsub()
  })

  it('unsubscribes via the returned function', () => {
    const cb = vi.fn()
    const unsub = onServerFrame(cb)
    unsub()
    broadcastFrame({ type: 'deviceStatus', ts: 1 })
    expect(cb).not.toHaveBeenCalled()
  })

  it('isolates listener errors so other listeners still fire', () => {
    const a = vi.fn(() => {
      throw new Error('listener boom')
    })
    const b = vi.fn()
    const unsubA = onServerFrame(a)
    const unsubB = onServerFrame(b)
    expect(() => broadcastFrame({ type: 'deviceStatus', ts: 1 })).not.toThrow()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    unsubA()
    unsubB()
  })

  it('returns early without crashing when no server is running and no listeners are registered', () => {
    expect(() => broadcastFrame({ type: 'deviceStatus', ts: 1 })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Live file-tailing + WS protocol — full server lifecycle
// ---------------------------------------------------------------------------

interface ConnectedClient {
  ws: WsClient
  messages: any[]
  close: () => Promise<void>
  waitFor: (predicate: (m: any) => boolean, timeoutMs?: number) => Promise<any>
}

async function connectClient(port: number): Promise<ConnectedClient> {
  const ws = new WsClient(`ws://127.0.0.1:${port}`)
  const messages: any[] = []
  ws.on('message', (data: Buffer) => {
    try {
      messages.push(JSON.parse(data.toString('utf-8')))
    }
    catch {
      messages.push(data.toString('utf-8'))
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    ws,
    messages,
    async close() {
      if (ws.readyState === WsClient.OPEN || ws.readyState === WsClient.CONNECTING) {
        await new Promise<void>((resolve) => {
          ws.once('close', () => resolve())
          ws.close()
        })
      }
    },
    async waitFor(predicate, timeoutMs = 1500) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const hit = messages.find(predicate)
        if (hit) return hit
        await new Promise(r => setTimeout(r, 10))
      }
      throw new Error(`waitFor timed out after ${timeoutMs}ms; messages=${JSON.stringify(messages)}`)
    },
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('waitUntil timed out')
}

describe('piezoStream — server lifecycle and protocol', () => {
  let serverPort = 0

  beforeEach(() => {
    // Wipe tmp dir so each test starts with a clean RAW file set.
    for (const f of fs.readdirSync(tmpRawDir)) {
      fs.rmSync(path.join(tmpRawDir, f), { force: true })
    }
    resetFrameIndex()
    clientSubscriptions.clear()
    clientDroppedFrames.clear()
  })

  afterEach(async () => {
    await shutdownPiezoStreamServer()
  })

  function startAndPort(): number {
    const wss = startPiezoStreamServer()
    const addr = wss.address()
    if (addr === null || typeof addr === 'string') {
      throw new Error('expected AddressInfo from server')
    }
    serverPort = addr.port
    return serverPort
  }

  it('startPiezoStreamServer returns the same instance on repeated calls', () => {
    const a = startPiezoStreamServer()
    const b = startPiezoStreamServer()
    expect(a).toBe(b)
  })

  it('subscribe with no sensors → server acks all sensor types', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'subscribe' }))
    const ack = await client.waitFor(m => m.type === 'subscribed')
    expect(ack.sensors).toContain('piezo-dual')
    expect(ack.sensors.length).toBeGreaterThan(5)
    await client.close()
  })

  it('subscribe with valid sensors → server filters subscription set', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'subscribe', sensors: ['piezo-dual', 'capSense'] }))
    const ack = await client.waitFor(m => m.type === 'subscribed')
    expect(ack.sensors).toEqual(['piezo-dual', 'capSense'])
    await client.close()
  })

  it('subscribe with only invalid sensors → server returns error and does not filter', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'subscribe', sensors: ['not-a-sensor'] }))
    const err = await client.waitFor(m => m.type === 'error')
    expect(err.message).toMatch(/No valid sensor types/)
    await client.close()
  })

  it('unknown message type → server returns error', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'banana' }))
    const err = await client.waitFor(m => m.type === 'error')
    expect(err.message).toMatch(/Unknown message type/)
    await client.close()
  })

  it('invalid JSON → server returns error', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send('not-json{')
    const err = await client.waitFor(m => m.type === 'error')
    expect(err.message).toMatch(/Invalid message format/)
    await client.close()
  })

  it('get_time_range before any frame indexed → returns zeros', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'get_time_range' }))
    const m = await client.waitFor(x => x.type === 'time_range')
    expect(m).toMatchObject({ type: 'time_range', min: 0, max: 0, file: null })
    await client.close()
  })

  it('seek with non-numeric timestamp → returns error', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 'soon' }))
    const err = await client.waitFor(m => m.type === 'error')
    expect(err.message).toMatch(/numeric timestamp/)
    await client.close()
  })

  it('seek before any RAW file is indexed → error + seek_complete', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 1 }))
    await client.waitFor(m => m.type === 'error')
    await client.waitFor(m => m.type === 'seek_complete')
    await client.close()
  })

  it('streams parsed frames to subscribed clients and updates the time-range index', async () => {
    // Pre-populate a RAW file so the streaming loop can pick it up immediately.
    const filePath = path.join(tmpRawDir, 'first.RAW')
    const rec1 = buildOuterRecord(1, [{ type: 'capSense', ts: 100, left: 0, right: 0 }])
    const rec2 = buildOuterRecord(2, [{ type: 'capSense2', ts: 101, left: { values: [1, 2] }, right: { values: [3, 4] } }])
    fs.writeFileSync(filePath, Buffer.concat([rec1, rec2]))

    const port = startAndPort()
    const client = await connectClient(port)

    const cap = await client.waitFor(m => m.type === 'capSense' && m.ts === 100)
    expect(cap.left).toBe(0)
    await client.waitFor(m => m.type === 'capSense2' && m.ts === 101)

    client.ws.send(JSON.stringify({ type: 'get_time_range' }))
    const range = await client.waitFor(m => m.type === 'time_range')
    expect(range.min).toBe(100)
    expect(range.max).toBe(101)
    expect(range.file).toBe('first.RAW')

    await client.close()
  })

  it('decodes piezo-dual buffers into int32 arrays', async () => {
    const filePath = path.join(tmpRawDir, 'piezo.RAW')
    const rec = buildOuterRecord(1, [{
      type: 'piezo-dual',
      ts: 700,
      freq: 50,
      left1: int32Buffer([1, 2, 3]),
      right1: int32Buffer([4, 5, 6]),
    }])
    fs.writeFileSync(filePath, rec)

    const port = startAndPort()
    const client = await connectClient(port)
    const piezo = await client.waitFor(m => m.type === 'piezo-dual', 3000)
    expect(piezo.left1).toEqual([1, 2, 3])
    expect(piezo.right1).toEqual([4, 5, 6])
    expect(piezo.ts).toBe(700)
    expect(piezo.freq).toBe(50)
    await client.close()
  })

  it('seek replays buffered frames from the indexed offset and sends seek_complete', async () => {
    const filePath = path.join(tmpRawDir, 'replay.RAW')
    const records: Buffer[] = []
    for (let i = 0; i < 5; i++) {
      records.push(buildOuterRecord(i + 1, [{
        type: 'capSense',
        ts: 200 + i,
        left: i,
        right: i,
      }]))
    }
    fs.writeFileSync(filePath, Buffer.concat(records))

    const port = startAndPort()
    const client = await connectClient(port)
    // Drain initial live frames before seeking.
    await waitUntil(() => client.messages.filter(m => m.type === 'capSense').length >= 5)

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 200 }))
    const complete = await client.waitFor(m => m.type === 'seek_complete')
    expect(complete).toMatchObject({ type: 'seek_complete' })

    const replayed = client.messages.slice(before).filter(m => m.type === 'capSense')
    expect(replayed.length).toBeGreaterThan(0)
    await client.close()
  })

  it('seek honours the subscription filter — frames outside the set are not replayed', async () => {
    const filePath = path.join(tmpRawDir, 'filter.RAW')
    const recA = buildOuterRecord(1, [{ type: 'capSense', ts: 300, left: 0, right: 0 }])
    const recB = buildOuterRecord(2, [{ type: 'log', ts: 301, level: 1, msg: 'x' }])
    fs.writeFileSync(filePath, Buffer.concat([recA, recB]))

    const port = startAndPort()
    const client = await connectClient(port)
    await waitUntil(() => client.messages.some(m => m.type === 'log'))

    // Subscribe to only capSense, then seek.
    client.ws.send(JSON.stringify({ type: 'subscribe', sensors: ['capSense'] }))
    await client.waitFor(m => m.type === 'subscribed')

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 300 }))
    await client.waitFor(m => m.type === 'seek_complete')
    const replayed = client.messages.slice(before)
    expect(replayed.some(m => m.type === 'log')).toBe(false)
    await client.close()
  })

  it('resyncs past a malformed record and continues streaming subsequent frames', async () => {
    // Two valid records with garbage bytes between them. The garbage starts
    // with a non-0xa2 byte so readRawRecord throws and findNextRecordMarker
    // jumps ahead to the next 0xa2.
    const filePath = path.join(tmpRawDir, 'resync.RAW')
    const good1 = buildOuterRecord(1, [{ type: 'capSense', ts: 400, left: 0, right: 0 }])
    const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00])
    const good2 = buildOuterRecord(2, [{ type: 'capSense', ts: 401, left: 1, right: 1 }])
    fs.writeFileSync(filePath, Buffer.concat([good1, garbage, good2]))

    const port = startAndPort()
    const client = await connectClient(port)

    await client.waitFor(m => m.type === 'capSense' && m.ts === 400)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 401)
    await client.close()
  })

  it('exposes the live capSense2 frame via getLatestCapSenseSnapshot and resets it on file switch', async () => {
    const filePath = path.join(tmpRawDir, 'snapshot-a.RAW')
    const channels = [14.5, 14.4, 13.7, 13.6, 19.4, 19.2, 1.157, 1.157]
    const rec = buildOuterRecord(1, [{ type: 'capSense2', ts: 999, left: channels, right: channels }])
    fs.writeFileSync(filePath, rec)
    const past = Date.now() / 1000 - 60
    fs.utimesSync(filePath, past, past)

    const port = startAndPort()
    const client = await connectClient(port)
    await client.waitFor(m => m.type === 'capSense2' && m.ts === 999, 3000)

    const snap = getLatestCapSenseSnapshot()
    expect(snap).not.toBeNull()
    expect(snap?.type).toBe('capSense2')
    expect(snap?.ts).toBe(999)
    expect(Array.isArray(snap?.left)).toBe(true)
    expect((snap?.left as number[])[0]).toBeCloseTo(14.5)

    // File switch must drop the cached snapshot.
    const newPath = path.join(tmpRawDir, 'snapshot-b.RAW')
    fs.writeFileSync(newPath, buildOuterRecord(1, [{ type: 'log', ts: 1000, level: 1, msg: 'x' }]))
    fs.utimesSync(newPath, Date.now() / 1000, Date.now() / 1000)
    await client.waitFor(m => m.type === 'log' && m.ts === 1000, 3000)

    expect(getLatestCapSenseSnapshot()).toBeNull()
    await client.close()
  })

  it('skips snapshot update when a capSense frame has a malformed payload', async () => {
    const filePath = path.join(tmpRawDir, 'snapshot-bad.RAW')
    // Missing ts → snapshot block's type guard rejects the frame.
    const rec = buildOuterRecord(1, [{ type: 'capSense', left: 1, right: 2 }])
    fs.writeFileSync(filePath, rec)

    const port = startAndPort()
    const client = await connectClient(port)
    await client.waitFor(m => m.type === 'capSense', 3000)
    expect(getLatestCapSenseSnapshot()).toBeNull()
    await client.close()
  })

  it('switches to a newer .RAW file when one appears with a later mtime', async () => {
    // Older file with a single frame.
    const oldPath = path.join(tmpRawDir, 'old.RAW')
    fs.writeFileSync(oldPath, buildOuterRecord(1, [{ type: 'capSense', ts: 500, left: 0, right: 0 }]))
    const past = Date.now() / 1000 - 60
    fs.utimesSync(oldPath, past, past)

    const port = startAndPort()
    const client = await connectClient(port)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 500)

    // Newer file appears.
    const newPath = path.join(tmpRawDir, 'new.RAW')
    fs.writeFileSync(newPath, buildOuterRecord(1, [{ type: 'capSense', ts: 600, left: 9, right: 9 }]))
    fs.utimesSync(newPath, Date.now() / 1000, Date.now() / 1000)

    await client.waitFor(m => m.type === 'capSense' && m.ts === 600, 3000)

    client.ws.send(JSON.stringify({ type: 'get_time_range' }))
    const range = await client.waitFor(m => m.type === 'time_range' && m.file === 'new.RAW')
    expect(range.min).toBe(600)
    await client.close()
  })

  it('broadcastFrame fans out to subscribed live clients only', async () => {
    const port = startAndPort()
    const a = await connectClient(port)
    const b = await connectClient(port)

    a.ws.send(JSON.stringify({ type: 'subscribe', sensors: ['deviceStatus'] }))
    b.ws.send(JSON.stringify({ type: 'subscribe', sensors: ['log'] }))
    await a.waitFor(m => m.type === 'subscribed')
    await b.waitFor(m => m.type === 'subscribed')

    broadcastFrame({ type: 'deviceStatus', ts: 1, water: 'ok' })

    await a.waitFor(m => m.type === 'deviceStatus')
    expect(b.messages.find(m => m.type === 'deviceStatus')).toBeUndefined()
    await a.close()
    await b.close()
  })

  it('cleans up per-client state on disconnect', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'subscribe', sensors: ['piezo-dual'] }))
    await client.waitFor(m => m.type === 'subscribed')
    expect(clientSubscriptions.size).toBeGreaterThan(0)

    await client.close()
    await waitUntil(() => clientSubscriptions.size === 0, 2000)
    expect(clientSubscriptions.size).toBe(0)
    expect(clientDroppedFrames.size).toBe(0)
  })

  it('shutdownPiezoStreamServer is idempotent and safe to call without a running server', async () => {
    // First call with a running server.
    startAndPort()
    await shutdownPiezoStreamServer()
    // Second call with no server — must not throw.
    await expect(shutdownPiezoStreamServer()).resolves.toBeUndefined()
  })

  it('skips empty placeholder records (zero-length byte string)', async () => {
    const filePath = path.join(tmpRawDir, 'empty.RAW')
    // Outer map(2) {seq:1, data:bytes(0)} followed by a real record so the
    // empty-placeholder branch executes and the loop continues.
    const empty = Buffer.from([0xa2, 0x63, 0x73, 0x65, 0x71, 0x01, 0x64, 0x64, 0x61, 0x74, 0x61, 0x40])
    const real = buildOuterRecord(2, [{ type: 'capSense', ts: 800, left: 0, right: 0 }])
    fs.writeFileSync(filePath, Buffer.concat([empty, real]))

    const port = startAndPort()
    const client = await connectClient(port)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 800)
    await client.close()
  })

  it('drops trailing garbage when no 0xa2 marker remains in the buffer', async () => {
    const filePath = path.join(tmpRawDir, 'trail.RAW')
    const good = buildOuterRecord(1, [{ type: 'capSense', ts: 900, left: 0, right: 0 }])
    // Trailing bytes contain NO 0xa2 marker — exercises the "no marker found"
    // branch where the parser drops the rest of the buffer.
    const trailing = Buffer.alloc(64, 0xff)
    fs.writeFileSync(filePath, Buffer.concat([good, trailing]))

    const port = startAndPort()
    const client = await connectClient(port)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 900)
    // Stream should continue working — append a fresh good record and confirm
    // it still gets parsed (the file follower carries on past the resync).
    await new Promise(r => setTimeout(r, 50))
    const more = buildOuterRecord(2, [{ type: 'capSense', ts: 901, left: 1, right: 1 }])
    fs.appendFileSync(filePath, more)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 901, 3000)
    await client.close()
  })

  it('fans frzHealth frames out to onServerFrame listeners (file-decoder path)', async () => {
    const filePath = path.join(tmpRawDir, 'health.RAW')
    const rec = buildOuterRecord(1, [{
      type: 'frzHealth',
      ts: 1000,
      left: { tec: { current: 1 }, pump: { mode: 'pwm', rpm: 0, water: true } },
      right: { tec: { current: 2 }, pump: { mode: 'pwm', rpm: 0, water: true } },
      fan: { top: { rpm: 100 } },
    }])
    fs.writeFileSync(filePath, rec)

    const cb = vi.fn()
    const unsub = onServerFrame(cb)
    try {
      const port = startAndPort()
      const client = await connectClient(port)
      await client.waitFor(m => m.type === 'frzHealth')
      expect(cb).toHaveBeenCalled()
      const arg = cb.mock.calls[0][0] as Record<string, unknown>
      expect(arg.type).toBe('frzHealth')
      expect(arg.ts).toBe(1000)
      await client.close()
    }
    finally {
      unsub()
    }
  })

  it('isolates onServerFrame listener errors during file-decoder fan-out', async () => {
    const filePath = path.join(tmpRawDir, 'err.RAW')
    const rec = buildOuterRecord(1, [{
      type: 'frzHealth',
      ts: 1100,
      left: { tec: { current: 1 }, pump: { mode: 'pwm', rpm: 0, water: true } },
      right: { tec: { current: 2 }, pump: { mode: 'pwm', rpm: 0, water: true } },
      fan: { top: { rpm: 100 } },
    }])
    fs.writeFileSync(filePath, rec)

    const a = vi.fn(() => {
      throw new Error('listener boom')
    })
    const b = vi.fn()
    const unsubA = onServerFrame(a)
    const unsubB = onServerFrame(b)
    try {
      const port = startAndPort()
      const client = await connectClient(port)
      await client.waitFor(m => m.type === 'frzHealth')
      expect(a).toHaveBeenCalled()
      expect(b).toHaveBeenCalled()
      await client.close()
    }
    finally {
      unsubA()
      unsubB()
    }
  })

  it('decodes piezo-dual with left2 / right2 buffers when present', async () => {
    const filePath = path.join(tmpRawDir, 'piezo2.RAW')
    const rec = buildOuterRecord(1, [{
      type: 'piezo-dual',
      ts: 1200,
      freq: 50,
      left1: int32Buffer([1]),
      right1: int32Buffer([2]),
      left2: int32Buffer([3]),
      right2: int32Buffer([4]),
    }])
    fs.writeFileSync(filePath, rec)
    const port = startAndPort()
    const client = await connectClient(port)
    const piezo = await client.waitFor(m => m.type === 'piezo-dual', 3000)
    expect(piezo.left2).toEqual([3])
    expect(piezo.right2).toEqual([4])
    await client.close()
  })

  it('seek replay stops at SEEK_MAX_DURATION_S window', async () => {
    const filePath = path.join(tmpRawDir, 'window.RAW')
    // Frames at ts 5000, 5001, 5050 — seek at 5000 with a 30s window must
    // stop before 5050.
    const recs = [
      buildOuterRecord(1, [{ type: 'capSense', ts: 5000, left: 0, right: 0 }]),
      buildOuterRecord(2, [{ type: 'capSense', ts: 5001, left: 1, right: 1 }]),
      buildOuterRecord(3, [{ type: 'capSense', ts: 5050, left: 9, right: 9 }]),
    ]
    fs.writeFileSync(filePath, Buffer.concat(recs))

    const port = startAndPort()
    const client = await connectClient(port)
    await waitUntil(() => client.messages.filter(m => m.type === 'capSense').length >= 3)

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 5000 }))
    await client.waitFor(m => m.type === 'seek_complete')
    const replayed = client.messages.slice(before).filter(m => m.type === 'capSense')
    // ts=5050 is outside the 30s seek window from 5000 → must not appear in replay.
    expect(replayed.find(m => m.ts === 5050)).toBeUndefined()
    await client.close()
  })

  it('seek treats a target before the earliest indexed frame as the first entry', async () => {
    const filePath = path.join(tmpRawDir, 'before.RAW')
    const rec = buildOuterRecord(1, [{ type: 'capSense', ts: 6000, left: 0, right: 0 }])
    fs.writeFileSync(filePath, rec)
    const port = startAndPort()
    const client = await connectClient(port)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 6000)

    // Target slightly before earliest indexed frame, but within the seek window.
    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 5995 }))
    await client.waitFor(m => m.type === 'seek_complete')
    const replayed = client.messages.slice(before).filter(m => m.type === 'capSense')
    expect(replayed.length).toBeGreaterThan(0)
    await client.close()
  })

  it('handles piezo-dual frames with empty/missing buffers', async () => {
    const filePath = path.join(tmpRawDir, 'empty-piezo.RAW')
    const rec = buildOuterRecord(1, [{
      type: 'piezo-dual',
      ts: 1300,
      freq: 50,
      left1: Buffer.alloc(0),
      right1: Buffer.from([1, 0]), // partial — fewer than 4 bytes
    }])
    fs.writeFileSync(filePath, rec)
    const port = startAndPort()
    const client = await connectClient(port)
    const piezo = await client.waitFor(m => m.type === 'piezo-dual', 3000)
    expect(piezo.left1).toEqual([])
    expect(piezo.right1).toEqual([])
    await client.close()
  })

  it('skips inner CBOR values with no `type` field', async () => {
    const filePath = path.join(tmpRawDir, 'no-type.RAW')
    // First inner has no type — should be skipped silently.
    // Second inner is well-formed — should reach the client.
    const innerNoType = Buffer.from(innerEncoder.encode({ ts: 1400, foo: 'bar' }))
    const innerOk = Buffer.from(innerEncoder.encode({ type: 'capSense', ts: 1401, left: 0, right: 0 }))
    const inner = Buffer.concat([innerNoType, innerOk])
    const rec = Buffer.concat([
      Buffer.from([0xa2]),
      Buffer.from([0x63, 0x73, 0x65, 0x71]),
      encodeSeqValueExposed(1),
      Buffer.from([0x64, 0x64, 0x61, 0x74, 0x61]),
      encodeByteStringExposed(inner),
    ])
    fs.writeFileSync(filePath, rec)
    const port = startAndPort()
    const client = await connectClient(port)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 1401, 3000)
    expect(client.messages.find(m => m.foo === 'bar')).toBeUndefined()
    await client.close()
  })

  it('respects subscription filter during live streaming fan-out', async () => {
    const filePath = path.join(tmpRawDir, 'sub-filter.RAW')
    const recs = [
      buildOuterRecord(1, [{ type: 'capSense', ts: 1500, left: 0, right: 0 }]),
      buildOuterRecord(2, [{ type: 'log', ts: 1501, level: 1, msg: 'hi' }]),
    ]
    fs.writeFileSync(filePath, Buffer.concat(recs))
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'subscribe', sensors: ['log'] }))
    await client.waitFor(m => m.type === 'subscribed')

    await client.waitFor(m => m.type === 'log' && m.ts === 1501, 3000)
    // capSense must NOT have reached the client because it filtered to ['log'].
    expect(client.messages.find(m => m.type === 'capSense')).toBeUndefined()
    await client.close()
  })

  it('handles a partial trailing record by waiting for more bytes (RangeError path)', async () => {
    const filePath = path.join(tmpRawDir, 'partial.RAW')
    const full = buildOuterRecord(1, [{ type: 'capSense', ts: 1600, left: 0, right: 0 }])
    const next = buildOuterRecord(2, [{ type: 'capSense', ts: 1601, left: 1, right: 1 }])
    // Write the first record + half of the second so readRawRecord throws
    // RangeError in the middle of decoding the second record.
    fs.writeFileSync(filePath, Buffer.concat([full, next.subarray(0, Math.floor(next.length / 2))]))

    const port = startAndPort()
    const client = await connectClient(port)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 1600)

    // Now append the rest of the second record. The follower retries on the
    // accumulated buffer and parses it.
    fs.appendFileSync(filePath, next.subarray(Math.floor(next.length / 2)))
    await client.waitFor(m => m.type === 'capSense' && m.ts === 1601, 3000)
    await client.close()
  })

  it('seek skips empty placeholder records during replay', async () => {
    const filePath = path.join(tmpRawDir, 'seek-empty.RAW')
    const real1 = buildOuterRecord(1, [{ type: 'capSense', ts: 1700, left: 0, right: 0 }])
    const placeholder = Buffer.from([0xa2, 0x63, 0x73, 0x65, 0x71, 0x02, 0x64, 0x64, 0x61, 0x74, 0x61, 0x40])
    const real2 = buildOuterRecord(3, [{ type: 'capSense', ts: 1701, left: 1, right: 1 }])
    fs.writeFileSync(filePath, Buffer.concat([real1, placeholder, real2]))

    const port = startAndPort()
    const client = await connectClient(port)
    await waitUntil(() => client.messages.some(m => m.type === 'capSense' && m.ts === 1701))

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 1700 }))
    await client.waitFor(m => m.type === 'seek_complete')
    const replayed = client.messages.slice(before).filter(m => m.type === 'capSense')
    expect(replayed.length).toBeGreaterThan(0)
    await client.close()
  })

  it('seek aborts cleanly if the client closes mid-replay', async () => {
    const filePath = path.join(tmpRawDir, 'mid-close.RAW')
    // Many small frames so the replay loop has multiple iterations to
    // notice the closed socket.
    const recs: Buffer[] = []
    for (let i = 0; i < 100; i++) {
      recs.push(buildOuterRecord(i + 1, [{ type: 'capSense', ts: 1800 + i, left: i, right: i }]))
    }
    fs.writeFileSync(filePath, Buffer.concat(recs))

    const port = startAndPort()
    const client = await connectClient(port)
    await waitUntil(() => client.messages.filter(m => m.type === 'capSense').length >= 100)

    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 1800 }))
    // Close the socket immediately — the replay loop must notice and bail.
    await client.close()
    // Server should not crash on subsequent operations.
    expect(() => broadcastFrame({ type: 'deviceStatus', ts: 1 })).not.toThrow()
  })

  it('seek reports incomplete replay when the client buffer overflows', async () => {
    const filePath = path.join(tmpRawDir, 'over.RAW')
    const recs: Buffer[] = []
    for (let i = 0; i < 5; i++) {
      recs.push(buildOuterRecord(i + 1, [{ type: 'capSense', ts: 1900 + i, left: i, right: i }]))
    }
    fs.writeFileSync(filePath, Buffer.concat(recs))

    const port = startAndPort()
    const client = await connectClient(port)
    // Wait for the file to be indexed (at least one frame).
    await waitUntil(() => client.messages.some(m => m.type === 'capSense'), 3000)

    // Force backpressure on the server-side socket BEFORE issuing the seek so
    // every replay frame is dropped, surfacing the "incomplete + droppedFrames"
    // path in the seek_complete response.
    const wss = startPiezoStreamServer()
    const serverSocket = [...wss.clients][0] as any
    Object.defineProperty(serverSocket, 'bufferedAmount', { get: () => 2 * MAX_BUFFERED_BYTES })

    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 1900 }))
    const complete = await client.waitFor(m => m.type === 'seek_complete', 3000)
    expect(complete).toMatchObject({ type: 'seek_complete', incomplete: true })
    expect(complete.droppedFrames).toBeGreaterThan(0)
    await client.close()
  })

  it('logs dropped frames when a backpressured client disconnects', async () => {
    const filePath = path.join(tmpRawDir, 'drops.RAW')
    const recs: Buffer[] = []
    for (let i = 0; i < 10; i++) {
      recs.push(buildOuterRecord(i + 1, [{ type: 'capSense', ts: 2000 + i, left: i, right: i }]))
    }
    fs.writeFileSync(filePath, Buffer.concat(recs))

    const port = startAndPort()
    const client = await connectClient(port)
    // Wait for the client to register on the server side.
    const wss = startPiezoStreamServer()
    await waitUntil(() => wss.clients.size > 0, 1000)
    const serverSocket = [...wss.clients][0] as any
    Object.defineProperty(serverSocket, 'bufferedAmount', { get: () => 2 * MAX_BUFFERED_BYTES })

    // Wait until at least one drop is recorded for this client.
    await waitUntil(
      () => clientDroppedFrames.get(serverSocket as never) !== undefined
        && (clientDroppedFrames.get(serverSocket as never) as number) > 0,
      3000,
    )

    await client.close()
    await waitUntil(() => clientDroppedFrames.size === 0, 2000)
  })

  it('updates DAC monitor poll rate when clients connect and disconnect', async () => {
    const monitorMod: any = await import('@/src/hardware/dacMonitor.instance')
    const monitor = monitorMod.__monitor
    monitor.setActive.mockClear()
    monitor.setIdle.mockClear()

    const port = startAndPort()
    const client = await connectClient(port)
    await waitUntil(() => monitor.setActive.mock.calls.length > 0, 2000)
    await client.close()
    await waitUntil(() => monitor.setIdle.mock.calls.length > 0, 2000)
    expect(monitor.setActive).toHaveBeenCalled()
    expect(monitor.setIdle).toHaveBeenCalled()
  })
})

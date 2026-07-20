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
import { syncBuiltinESMExports } from 'node:module'
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
  // This suite exercises the legacy `.RAW` tailer. Disable NATS source selection
  // so startPiezoStreamServer starts file tailing immediately instead of probing
  // loopback:4222 across the 60 s grace window. NATS selection has its own suite.
  process.env.PIEZO_NATS_DISABLED = '1'
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
  findLatestRaw,
  getLatestCapSenseSnapshot,
  onServerFrame,
  startPiezoStreamServer,
  shutdownPiezoStreamServer,
} from '../piezoStream'

const {
  appendFrameIndex,
  cleanupClient,
  sendWithBackpressure,
  readRawRecord,
  findIndexEntry,
  decodeSensorFrames,
  int32BufferToArray,
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

  it('evicts entries older than the cutoff but retains the exact boundary', () => {
    const cutoff = 1_000_000
    appendFrameIndex({ ts: cutoff - 1, offset: 0 })
    appendFrameIndex({ ts: cutoff, offset: 100 })

    appendFrameIndex({ ts: cutoff + FRAME_INDEX_RETENTION_S, offset: 200 })

    expect(frameIndex.map(entry => entry.ts)).toEqual([
      cutoff,
      cutoff + FRAME_INDEX_RETENTION_S,
    ])
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
// readRawRecord — direct parser tests (byte-level CBOR framing)
// ---------------------------------------------------------------------------

/** Assemble an outer record from raw parts, bypassing the seq-value helper. */
function outerRecord(seqBytes: Buffer, dataBytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xa2]),
    Buffer.from([0x63, 0x73, 0x65, 0x71]), // "seq"
    seqBytes,
    Buffer.from([0x64, 0x64, 0x61, 0x74, 0x61]), // "data"
    dataBytes,
  ])
}

describe('piezoStream — readRawRecord CBOR parser', () => {
  const innerBlob = Buffer.from(innerEncoder.encode({ type: 'log', ts: 1, msg: 'x' }))

  it('parses a record, returning the exact inner bytes and nextOffset', () => {
    const rec = outerRecord(encodeSeqValue(1), encodeByteString(innerBlob))
    const { data, nextOffset } = readRawRecord(rec, 0)
    expect(nextOffset).toBe(rec.length)
    expect(data).not.toBeNull()
    expect((data as Buffer).equals(innerBlob)).toBe(true)
  })

  it('parses records at a nonzero offset', () => {
    const rec = outerRecord(encodeSeqValue(1), encodeByteString(innerBlob))
    const padded = Buffer.concat([Buffer.alloc(7, 0xee), rec])
    const { data, nextOffset } = readRawRecord(padded, 7)
    expect(nextOffset).toBe(padded.length)
    expect((data as Buffer).equals(innerBlob)).toBe(true)
  })

  it('throws RangeError("Incomplete record") when the buffer is truncated', () => {
    const rec = outerRecord(encodeSeqValue(1), encodeByteString(innerBlob))
    // Truncate at every prefix length — all must signal "wait for more data".
    for (const cut of [0, 1, 4, 5, 9, 10, rec.length - 1]) {
      expect(() => readRawRecord(rec.subarray(0, cut), 0))
        .toThrow(new RangeError('Incomplete record'))
    }
  })

  it('rejects a wrong outer-map marker with the offending byte in the message', () => {
    const rec = outerRecord(encodeSeqValue(1), encodeByteString(innerBlob))
    rec[0] = 0xa3
    expect(() => readRawRecord(rec, 0)).toThrow('Expected outer map 0xa2, got 0xa3')
  })

  it('rejects a record when any single byte of the "seq" key is wrong', () => {
    for (let i = 0; i < 4; i++) {
      const rec = outerRecord(encodeSeqValue(1), encodeByteString(innerBlob))
      rec[1 + i] ^= 0xff
      expect(() => readRawRecord(rec, 0)).toThrow('Expected seq key')
    }
  })

  it('rejects a seq value that is not an unsigned int', () => {
    // 0x20 = major type 1 (negative int) — same length as the inline uint it replaces.
    const rec = outerRecord(Buffer.from([0x20]), encodeByteString(innerBlob))
    expect(() => readRawRecord(rec, 0)).toThrow('seq must be unsigned int, got major type 1')
  })

  it('accepts every seq integer encoding width', () => {
    const seqEncodings: Buffer[] = [
      Buffer.from([0x17]), // inline 23
      Buffer.from([0x18, 0xff]), // 1-byte
      Buffer.from([0x19, 0x01, 0x2c]), // 2-byte (300)
      Buffer.from([0x1a, 0x00, 0x01, 0x11, 0x70]), // 4-byte (70000)
      Buffer.from([0x1b, 0, 0, 0, 0, 0, 0, 0, 1]), // 8-byte
    ]
    for (const seqBytes of seqEncodings) {
      const rec = outerRecord(seqBytes, encodeByteString(innerBlob))
      const { data, nextOffset } = readRawRecord(rec, 0)
      expect(nextOffset).toBe(rec.length)
      expect((data as Buffer).equals(innerBlob)).toBe(true)
    }
  })

  it('rejects an unsupported seq encoding', () => {
    const rec = outerRecord(Buffer.from([0x1c]), encodeByteString(innerBlob))
    expect(() => readRawRecord(rec, 0)).toThrow('Unexpected seq encoding: 0x1c')
  })

  it('rejects a record when any single byte of the "data" key is wrong', () => {
    for (let i = 0; i < 5; i++) {
      const rec = outerRecord(encodeSeqValue(1), encodeByteString(innerBlob))
      rec[6 + i] ^= 0xff // seq value for seq=1 is 1 byte → data key starts at 6
      expect(() => readRawRecord(rec, 0)).toThrow('Expected data key')
    }
  })

  it('accepts every data byte-string length encoding, including the 23-byte inline boundary', () => {
    for (const len of [0x17, 0x18, 300, 70000]) {
      const payload = Buffer.alloc(len, 0xab)
      const rec = outerRecord(encodeSeqValue(1), encodeByteString(payload))
      const { data, nextOffset } = readRawRecord(rec, 0)
      expect(nextOffset).toBe(rec.length)
      expect((data as Buffer).length).toBe(len)
      expect((data as Buffer).equals(payload)).toBe(true)
    }
  })

  it('rejects an unsupported data length encoding', () => {
    // 0x5b = byte string with 8-byte length (ai=27) — parser supports up to ai=26.
    const rec = outerRecord(
      encodeSeqValue(1),
      Buffer.concat([Buffer.from([0x5b, 0, 0, 0, 0, 0, 0, 0, 1]), Buffer.alloc(1)]),
    )
    expect(() => readRawRecord(rec, 0)).toThrow('Unsupported length encoding: 27')
  })

  it('returns data:null (not an empty buffer) for zero-length placeholder records', () => {
    const rec = outerRecord(encodeSeqValue(1), Buffer.from([0x40]))
    const { data, nextOffset } = readRawRecord(rec, 0)
    expect(data).toBeNull()
    expect(nextOffset).toBe(rec.length)
  })
})

describe('piezoStream — decodeSensorFrames', () => {
  it('skips non-object and null inner values without aborting the batch', () => {
    // A primitive before a valid frame: if the type guard regresses, the
    // `'type' in` check throws and the whole batch is lost.
    const inner = Buffer.concat([
      Buffer.from(innerEncoder.encode(42)),
      Buffer.from(innerEncoder.encode(null)),
      Buffer.from(innerEncoder.encode({ type: 'log', ts: 1, msg: 'x' })),
    ])
    expect(decodeSensorFrames(inner)).toEqual([{ type: 'log', ts: 1, msg: 'x' }])
  })

  it('uses epoch seconds for a piezo frame whose firmware timestamp is missing', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_987)
    const inner = Buffer.from(innerEncoder.encode({
      type: 'piezo-dual',
      freq: 50,
      left1: int32Buffer([1]),
      right1: int32Buffer([2]),
    }))

    expect(decodeSensorFrames(inner)).toEqual([{
      type: 'piezo-dual',
      ts: 1_700_000_000,
      freq: 50,
      left1: [1],
      right1: [2],
      left2: undefined,
      right2: undefined,
    }])
    now.mockRestore()
  })

  it('turns missing, empty, and partial int32 buffers into empty arrays', () => {
    expect(int32BufferToArray(undefined)).toEqual([])
    expect(int32BufferToArray(Buffer.alloc(0))).toEqual([])
    expect(int32BufferToArray(Buffer.from([1, 2, 3]))).toEqual([])
  })
})

describe('piezoStream — findIndexEntry binary search', () => {
  beforeEach(() => {
    resetFrameIndex()
  })

  it('returns -1 when nothing is indexed', () => {
    expect(findIndexEntry(123)).toBe(-1)
  })

  it('finds the entry at or just before the target timestamp', () => {
    for (const [i, ts] of [10, 20, 30].entries()) {
      appendFrameIndex({ ts, offset: i * 100 })
    }
    expect(findIndexEntry(5)).toBe(0) // before all → first entry
    expect(findIndexEntry(10)).toBe(0)
    expect(findIndexEntry(20)).toBe(1)
    expect(findIndexEntry(25)).toBe(1)
    expect(findIndexEntry(30)).toBe(2)
    expect(findIndexEntry(99)).toBe(2)
  })

  it('returns the last indexed entry when the earliest timestamp is duplicated', () => {
    appendFrameIndex({ ts: 10, offset: 0 })
    appendFrameIndex({ ts: 10, offset: 100 })
    appendFrameIndex({ ts: 20, offset: 200 })

    expect(findIndexEntry(10)).toBe(1)
  })
})

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

  it('returns early without crashing when no server is running and no listeners are registered', async () => {
    await shutdownPiezoStreamServer()
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
    vi.restoreAllMocks()
  })

  // IMPORTANT: write RAW data only AFTER the client has connected. The tailing
  // loop broadcasts live frames to currently-connected clients only (no
  // backfill) and advances its read offset to EOF on the first tick. Writing
  // before connect races that first tick — under load the loop consumes the
  // file before the socket attaches and the frames are lost for good. Appending
  // post-connect mirrors production (firmware appends while clients stream).
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

  it('does not inspect broadcast frames while the running server has no clients', () => {
    const server = startPiezoStreamServer()
    expect(server.clients.size).toBe(0)

    let typeReads = 0
    const frame: Record<string, unknown> = {
      get type() {
        typeReads++
        throw new Error('zero-client broadcasts must return before reading the frame')
      },
    }

    expect(() => broadcastFrame(frame)).not.toThrow()
    expect(typeReads).toBe(0)
  })

  it('logs the exact server-side WebSocket error without crashing the connection', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const port = startAndPort()
    const client = await connectClient(port)
    const serverSocket = [...startPiezoStreamServer().clients][0]

    serverSocket.emit('error', new Error('socket boom'))

    expect(errorSpy).toHaveBeenCalledWith('[sensorStream] WebSocket error:', 'socket boom')
    expect(client.ws.readyState).toBe(WsClient.OPEN)
    await client.close()
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
    const logSpy = vi.spyOn(console, 'log')
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'subscribe', sensors: ['piezo-dual', 'capSense'] }))
    const ack = await client.waitFor(m => m.type === 'subscribed')
    expect(ack.sensors).toEqual(['piezo-dual', 'capSense'])
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Client subscribed to'), 'piezo-dual, capSense')
    await client.close()
  })

  it('subscribe with an empty sensors array → subscribes to all types', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'subscribe', sensors: [] }))
    const ack = await client.waitFor(m => m.type === 'subscribed')
    expect(ack.sensors).toContain('piezo-dual')
    expect(ack.sensors.length).toBeGreaterThan(5)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Client subscribed to: all'))
    await client.close()
  })

  it('subscribe with only invalid sensors → server returns error and does not filter', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'subscribe', sensors: ['not-a-sensor'] }))
    const err = await client.waitFor(m => m.type === 'error')
    expect(err.message).toMatch(/No valid sensor types/)
    // The valid-types list must be spelled out, comma-separated.
    expect(err.message).toContain('piezo-dual, capSense')
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

  it('seek with a numeric-string timestamp → rejected as non-numeric', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: '123' }))
    const err = await client.waitFor(m => m.type === 'error')
    expect(err.message).toMatch(/numeric timestamp/)
    await client.close()
  })

  it('seek with a non-finite timestamp → rejected as non-numeric', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    // 1e999 parses to Infinity on the server (JSON.stringify can't emit it).
    client.ws.send('{"type":"seek","timestamp":1e999}')
    const err = await client.waitFor(m => m.type === 'error')
    expect(err.message).toMatch(/numeric timestamp/)
    await client.close()
  })

  it('seek when the file is indexed but holds no timestamped frames → "No frames indexed yet"', async () => {
    const filePath = path.join(tmpRawDir, 'no-ts-frames.RAW')
    // `log` frame without ts: the follower switches to the file (indexedFilePath
    // set) but never appends to frameIndex, so seek hits the idx < 0 branch.
    const rec = buildOuterRecord(1, [{ type: 'log', level: 1, msg: 'no-ts' }])

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, rec)
    await client.waitFor(m => m.type === 'log' && m.msg === 'no-ts', 3000)

    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 123 }))
    const err = await client.waitFor(m => m.type === 'error')
    expect(err.message).toMatch(/No frames indexed yet/)
    await client.waitFor(m => m.type === 'seek_complete')
    await client.close()
  })

  it('streams parsed frames to subscribed clients and updates the time-range index', async () => {
    const filePath = path.join(tmpRawDir, 'first.RAW')
    const rec1 = buildOuterRecord(1, [{ type: 'capSense', ts: 100, left: 0, right: 0 }])
    const rec2 = buildOuterRecord(2, [{ type: 'capSense2', ts: 101, left: { values: [1, 2] }, right: { values: [3, 4] } }])

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat([rec1, rec2]))

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

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, rec)
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

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat(records))
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

  it('completes a seek when the file was truncated below a positive indexed offset', async () => {
    const filePath = path.join(tmpRawDir, 'truncated-at-offset.RAW')
    const first = buildOuterRecord(1, [{ type: 'capSense', ts: 250, left: 1, right: 2 }])
    const second = buildOuterRecord(2, [{ type: 'capSense', ts: 251, left: 3, right: 4 }])

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat([first, second]))
    await client.waitFor(m => m.type === 'capSense' && m.ts === 251)

    fs.truncateSync(filePath, 0)
    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 251 }))
    await client.waitFor(m => m.type === 'seek_complete')

    expect(client.messages.slice(before)).toContainEqual({ type: 'seek_complete' })
    await client.close()
  })

  it('sizes a nonzero-offset seek from the remaining bytes without exceeding the cap', async () => {
    const filePath = path.join(tmpRawDir, 'seek-buffer-size.RAW')
    const first = buildOuterRecord(1, [{ type: 'capSense', ts: 252, left: 1, right: 2 }])
    const second = buildOuterRecord(2, [{ type: 'capSense', ts: 253, left: 3, right: 4 }])
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat([first, second]))
    await client.waitFor(m => m.type === 'capSense' && m.ts === 253)

    const startOffset = frameIndex.find(entry => entry.ts === 253)?.offset
    expect(startOffset).toBe(first.length)
    const remainder = 7
    const close = vi.fn(async () => {})
    const read = vi.fn(async (...args: [Buffer, number, number, number]) => ({
      bytesRead: 0,
      buffer: args[0],
    }))
    const open = vi.spyOn(fs.promises, 'open').mockResolvedValue({
      stat: vi.fn(async () => ({ size: (startOffset as number) + remainder })),
      read,
      close,
    } as never)
    const realAlloc = Buffer.alloc.bind(Buffer)
    const alloc = vi.spyOn(Buffer, 'alloc').mockImplementation(
      ((size: number) => realAlloc(Math.min(size, 1024))) as typeof Buffer.alloc,
    )

    try {
      client.ws.send(JSON.stringify({ type: 'seek', timestamp: 253 }))
      await client.waitFor(m => m.type === 'seek_complete')

      expect(alloc).toHaveBeenCalledWith(remainder)
      expect(read).toHaveBeenCalledOnce()
      expect(read.mock.calls[0]?.[2]).toBe(remainder)
      expect(read.mock.calls[0]?.[3]).toBe(startOffset)
      expect(close).toHaveBeenCalledOnce()
    }
    finally {
      alloc.mockRestore()
      open.mockRestore()
      await client.close()
    }
  })

  it('uses the zero-byte early completion even if the requester closes during stat', async () => {
    const filePath = path.join(tmpRawDir, 'seek-zero-byte-close.RAW')
    const record = buildOuterRecord(1, [{ type: 'capSense', ts: 254, left: 1, right: 2 }])
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, record)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 254)

    let resolveStat: (value: { size: number }) => void = () => {}
    const statGate = new Promise<{ size: number }>((resolve) => {
      resolveStat = resolve
    })
    const stat = vi.fn(() => statGate)
    const close = vi.fn(async () => {})
    const open = vi.spyOn(fs.promises, 'open').mockResolvedValue({ stat, close } as never)
    const serverSocket = [...startPiezoStreamServer().clients][0] as any
    const send = vi.spyOn(serverSocket, 'send').mockImplementation(() => {})

    try {
      client.ws.send(JSON.stringify({ type: 'seek', timestamp: 254 }))
      await waitUntil(() => stat.mock.calls.length === 1)
      Object.defineProperty(serverSocket, 'readyState', {
        get: () => WsClient.CLOSED,
        configurable: true,
      })
      resolveStat({ size: 0 })
      await waitUntil(() => send.mock.calls.length > 0)

      expect(send.mock.calls.some(([payload]) =>
        JSON.parse(String(payload)).type === 'seek_complete')).toBe(true)
      expect(close).toHaveBeenCalledOnce()
    }
    finally {
      delete serverSocket.readyState
      send.mockRestore()
      open.mockRestore()
      await client.close()
    }
  })

  it('stops on a zero-byte short read and trims the unread seek-buffer tail', async () => {
    const filePath = path.join(tmpRawDir, 'seek-short-read.RAW')
    const record = buildOuterRecord(1, [{ type: 'capSense', ts: 255, left: 1, right: 2 }])
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, record)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 255)

    const declaredSize = record.length + 8
    const realAlloc = Buffer.alloc.bind(Buffer)
    const seekBuffer = realAlloc(declaredSize)
    const subarray = vi.spyOn(seekBuffer, 'subarray')
    const alloc = vi.spyOn(Buffer, 'alloc').mockImplementation(
      ((size: number) => size === declaredSize ? seekBuffer : realAlloc(size)) as typeof Buffer.alloc,
    )
    let readCount = 0
    const read = vi.fn(async (buffer: Buffer, offset: number) => {
      readCount += 1
      if (readCount === 1) {
        record.copy(buffer, offset)
        return { bytesRead: record.length, buffer }
      }
      if (readCount === 2) return { bytesRead: 0, buffer }
      throw new Error('read loop did not stop after EOF')
    })
    const close = vi.fn(async () => {})
    const open = vi.spyOn(fs.promises, 'open').mockResolvedValue({
      stat: vi.fn(async () => ({ size: declaredSize })),
      read,
      close,
    } as never)

    try {
      const before = client.messages.length
      client.ws.send(JSON.stringify({ type: 'seek', timestamp: 255 }))
      await client.waitFor(m => m.type === 'seek_complete')

      expect(read).toHaveBeenCalledTimes(2)
      expect(subarray).toHaveBeenCalledWith(0, record.length)
      expect(client.messages.slice(before).filter(m => m.type === 'capSense').map(m => m.ts)).toEqual([255])
      expect(close).toHaveBeenCalledOnce()
    }
    finally {
      alloc.mockRestore()
      open.mockRestore()
      await client.close()
    }
  })

  it('closes the seek file handle when a post-open operation fails', async () => {
    const filePath = path.join(tmpRawDir, 'seek-handle-cleanup.RAW')
    const record = buildOuterRecord(1, [{ type: 'capSense', ts: 256, left: 1, right: 2 }])
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, record)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 256)

    const close = vi.fn(async () => {})
    const open = vi.spyOn(fs.promises, 'open').mockResolvedValue({
      stat: vi.fn(async () => { throw new Error('stat failed') }),
      close,
    } as never)

    try {
      client.ws.send(JSON.stringify({ type: 'seek', timestamp: 256 }))
      await waitUntil(() => close.mock.calls.length === 1)
      expect(close).toHaveBeenCalledOnce()
    }
    finally {
      open.mockRestore()
      await client.close()
    }
  })

  it('yields while replaying 500 records and still completes the full seek', async () => {
    const filePath = path.join(tmpRawDir, 'yielding-replay.RAW')
    const records = Array.from({ length: 501 }, (_, i) => buildOuterRecord(i + 1, [{
      type: 'capSense',
      ts: 260,
      left: i,
      right: i,
    }]))

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat(records))
    await waitUntil(() => client.messages.filter(m => m.type === 'capSense').length >= 501, 5000)

    const immediateSpy = vi.spyOn(globalThis, 'setImmediate')
    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 259 }))
    await client.waitFor(m => m.type === 'seek_complete', 5000)

    expect(immediateSpy).toHaveBeenCalled()
    expect(client.messages.slice(before).filter(m => m.type === 'capSense')).toHaveLength(501)
    await client.close()
  })

  it('completes a seek after replaying the valid prefix of a truncated record', async () => {
    const filePath = path.join(tmpRawDir, 'truncated-seek-record.RAW')
    const valid = buildOuterRecord(1, [{ type: 'capSense', ts: 270, left: 1, right: 2 }])
    const truncated = buildOuterRecord(2, [{ type: 'capSense', ts: 271, left: 3, right: 4 }])
    const bytes = Buffer.concat([valid, truncated.subarray(0, Math.floor(truncated.length / 2))])

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, bytes)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 270)

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 270 }))
    await client.waitFor(m => m.type === 'seek_complete')

    expect(client.messages.slice(before).filter(m => m.type === 'capSense').map(m => m.ts)).toEqual([270])
    await client.close()
  })

  it('does not resync through a marker-shaped payload inside an incomplete record', async () => {
    const filePath = path.join(tmpRawDir, 'truncated-seek-marker.RAW')
    const valid = buildOuterRecord(1, [{ type: 'capSense', ts: 272, left: 1, right: 2 }])
    const markerShapedPayload = buildOuterRecord(3, [{
      type: 'capSense', ts: 273, left: 3, right: 4,
    }])
    const declaredLength = markerShapedPayload.length + 20
    expect(declaredLength).toBeLessThan(256)
    const incomplete = Buffer.concat([
      Buffer.from([0xa2, 0x63, 0x73, 0x65, 0x71]),
      encodeSeqValueExposed(2),
      Buffer.from([0x64, 0x64, 0x61, 0x74, 0x61, 0x58, declaredLength]),
      markerShapedPayload,
    ])

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat([valid, incomplete]))
    await client.waitFor(m => m.type === 'capSense' && m.ts === 272)

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 272 }))
    await client.waitFor(m => m.type === 'seek_complete')

    expect(client.messages.slice(before).filter(m => m.type === 'capSense').map(m => m.ts)).toEqual([272])
    await client.close()
  })

  it('seek honours the subscription filter — frames outside the set are not replayed', async () => {
    const filePath = path.join(tmpRawDir, 'filter.RAW')
    const recA = buildOuterRecord(1, [{ type: 'capSense', ts: 300, left: 0, right: 0 }])
    const recB = buildOuterRecord(2, [{ type: 'log', ts: 301, level: 1, msg: 'x' }])

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat([recA, recB]))
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

    const warnSpy = vi.spyOn(console, 'warn')
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat([good1, garbage, good2]))

    await client.waitFor(m => m.type === 'capSense' && m.ts === 400)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 401)
    // The whole file lands in one poll tick, so the skip count is exactly the
    // garbage length — the field engineers grep for this line, keep it exact.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Resync: skipped %d bytes'), garbage.length, expect.any(String))

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 400 }))
    await client.waitFor(m => m.type === 'seek_complete')
    const replayed = client.messages.slice(before).filter(m => m.type === 'capSense').map(m => m.ts)
    expect(replayed).toEqual([400, 401])
    await client.close()
  })

  it('resyncs when the malformed record itself starts with an 0xa2 marker', async () => {
    // 0xa2 followed by a wrong seq key: the parser throws at the record start,
    // and resync must search from the NEXT byte or it would re-find the same
    // marker and never advance.
    const filePath = path.join(tmpRawDir, 'resync-a2.RAW')
    const bad = Buffer.from([0xa2, 0x60, 0x60, 0x60, 0x60])
    const good1 = buildOuterRecord(1, [{ type: 'capSense', ts: 410, left: 0, right: 0 }])
    const good2 = buildOuterRecord(2, [{ type: 'capSense', ts: 411, left: 1, right: 1 }])
    expect(good1.at(-1)).not.toBe(0xa2)

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat([good1, bad, good2]))
    await client.waitFor(m => m.type === 'capSense' && m.ts === 410, 3000)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 411, 3000)

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 410 }))
    await client.waitFor(m => m.type === 'seek_complete', 3000)
    expect(client.messages.slice(before).filter(m => m.type === 'capSense').map(m => m.ts)).toEqual([
      410,
      411,
    ])
    await client.close()
  })

  it('exposes the live capSense2 frame via getLatestCapSenseSnapshot and resets it on file switch', async () => {
    const filePath = path.join(tmpRawDir, 'snapshot-a.RAW')
    const channels = [14.5, 14.4, 13.7, 13.6, 19.4, 19.2, 1.157, 1.157]
    const rec = buildOuterRecord(1, [{ type: 'capSense2', ts: 999, left: channels, right: channels }])
    const past = Date.now() / 1000 - 60

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, rec)
    fs.utimesSync(filePath, past, past)
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

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, rec)
    await client.waitFor(m => m.type === 'capSense', 3000)
    expect(getLatestCapSenseSnapshot()).toBeNull()
    await client.close()
  })

  it('switches to a newer .RAW file when one appears with a later mtime', async () => {
    // Older file with a single frame.
    const oldPath = path.join(tmpRawDir, 'old.RAW')
    const past = Date.now() / 1000 - 60

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(oldPath, buildOuterRecord(1, [{ type: 'capSense', ts: 500, left: 0, right: 0 }]))
    fs.utimesSync(oldPath, past, past)
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

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat([empty, real]))
    await client.waitFor(m => m.type === 'capSense' && m.ts === 800)
    await client.close()
  })

  it('drops trailing garbage when no 0xa2 marker remains in the buffer', async () => {
    const filePath = path.join(tmpRawDir, 'trail.RAW')
    const good = buildOuterRecord(1, [{ type: 'capSense', ts: 900, left: 0, right: 0 }])
    // Trailing bytes contain NO 0xa2 marker — exercises the "no marker found"
    // branch where the parser drops the rest of the buffer.
    const trailing = Buffer.alloc(64, 0xff)

    const warnSpy = vi.spyOn(console, 'warn')
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat([good, trailing]))
    await client.waitFor(m => m.type === 'capSense' && m.ts === 900)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no 0xa2 marker in remaining %d bytes'),
      trailing.length, expect.any(String))

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 900 }))
    await client.waitFor(m => m.type === 'seek_complete')
    expect(client.messages.slice(before).some(m => m.type === 'capSense' && m.ts === 900)).toBe(true)

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

    const cb = vi.fn()
    const unsub = onServerFrame(cb)
    try {
      const port = startAndPort()
      const client = await connectClient(port)
      fs.writeFileSync(filePath, rec)
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

    const a = vi.fn(() => {
      throw new Error('listener boom')
    })
    const b = vi.fn()
    const unsubA = onServerFrame(a)
    const unsubB = onServerFrame(b)
    try {
      const port = startAndPort()
      const client = await connectClient(port)
      fs.writeFileSync(filePath, rec)
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
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, rec)
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

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat(recs))
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
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, rec)
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
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, rec)
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
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, rec)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 1401, 3000)
    expect(client.messages.find(m => m.foo === 'bar')).toBeUndefined()
    await client.close()
  })

  it('respects subscription filter during live streaming fan-out', async () => {
    const filePath = path.join(tmpRawDir, 'sub-filter.RAW')
    // Create the file empty so the follower latches onto it, but withhold the
    // frames until the subscription filter is confirmed. Writing the records up
    // front races the tailing loop against the subscribe message: a tick that
    // fires before the filter is installed fans out capSense under the default
    // (all-types) subscription and the assertion flakes.
    fs.writeFileSync(filePath, Buffer.alloc(0))
    const port = startAndPort()
    const client = await connectClient(port)
    client.ws.send(JSON.stringify({ type: 'subscribe', sensors: ['log'] }))
    await client.waitFor(m => m.type === 'subscribed')

    // Filter is in place — now append both frames. capSense (seq 1) is parsed
    // before log (seq 2) in the same tick, so once log arrives capSense has
    // already been processed and filtered. No wall-clock ordering assumption.
    fs.appendFileSync(filePath, Buffer.concat([
      buildOuterRecord(1, [{ type: 'capSense', ts: 1500, left: 0, right: 0 }]),
      buildOuterRecord(2, [{ type: 'log', ts: 1501, level: 1, msg: 'hi' }]),
    ]))

    await client.waitFor(m => m.type === 'log' && m.ts === 1501, 3000)
    // capSense must NOT have reached the client because it filtered to ['log'].
    expect(client.messages.find(m => m.type === 'capSense')).toBeUndefined()
    await client.close()
  })

  it('handles a partial trailing record by waiting for more bytes (RangeError path)', async () => {
    const filePath = path.join(tmpRawDir, 'partial.RAW')
    const full = buildOuterRecord(1, [{ type: 'capSense', ts: 1600, left: 0, right: 0 }])
    const next = buildOuterRecord(2, [{ type: 'capSense', ts: 1601, left: 1, right: 1 }])

    const port = startAndPort()
    const client = await connectClient(port)
    // Write the first record + half of the second so readRawRecord throws
    // RangeError in the middle of decoding the second record.
    fs.writeFileSync(filePath, Buffer.concat([full, next.subarray(0, Math.floor(next.length / 2))]))
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

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat([real1, placeholder, real2]))
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
    // The 500-record cooperative yield gives the close handshake a chance to
    // finish before the replay loop checks readyState again.
    const recs: Buffer[] = []
    for (let i = 0; i < 600; i++) {
      recs.push(buildOuterRecord(i + 1, [{ type: 'capSense', ts: 1800, left: i, right: i }]))
    }

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat(recs))
    await waitUntil(() => client.messages.filter(m => m.type === 'capSense').length >= 600, 5000)

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

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat(recs))
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

    const port = startAndPort()
    const client = await connectClient(port)
    // Wait for the client to register on the server side.
    const wss = startPiezoStreamServer()
    await waitUntil(() => wss.clients.size > 0, 1000)
    const serverSocket = [...wss.clients][0] as any
    Object.defineProperty(serverSocket, 'bufferedAmount', { get: () => 2 * MAX_BUFFERED_BYTES })

    // Backpressure is in place — now append frames so each live broadcast is
    // dropped against the (mocked) full send buffer.
    fs.writeFileSync(filePath, Buffer.concat(recs))

    // Wait until at least one drop is recorded for this client.
    await waitUntil(
      () => clientDroppedFrames.get(serverSocket as never) !== undefined
        && (clientDroppedFrames.get(serverSocket as never) as number) > 0,
      3000,
    )

    const logSpy = vi.spyOn(console, 'log')
    await client.close()
    await waitUntil(() => clientDroppedFrames.size === 0, 2000)
    // Disconnect log must call out the drop count for field debugging.
    expect(logSpy.mock.calls.some(c => typeof c[0] === 'string'
      && /disconnected \(dropped \d+ frames due to backpressure\)/.test(c[0]))).toBe(true)
  })

  it('seek replays every frame in the window, not a truncated prefix', async () => {
    const filePath = path.join(tmpRawDir, 'full-window.RAW')
    // Six records (~280 bytes total) so a regressed read cap (e.g. 64 bytes)
    // silently truncates the replay.
    const recs: Buffer[] = []
    for (let i = 0; i < 6; i++) {
      recs.push(buildOuterRecord(i + 1, [{ type: 'capSense', ts: 8000 + i, left: i, right: i }]))
    }

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat(recs))
    await waitUntil(() => client.messages.filter(m => m.type === 'capSense').length >= 6)

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 8000 }))
    const complete = await client.waitFor(m => m.type === 'seek_complete')
    const replayed = client.messages.slice(before).filter(m => m.type === 'capSense')
    expect(replayed.map(m => m.ts)).toEqual([8000, 8001, 8002, 8003, 8004, 8005])
    // A clean replay must not carry the incomplete/droppedFrames markers.
    expect(complete.incomplete).toBeUndefined()
    expect(complete.droppedFrames).toBeUndefined()
    await client.close()
  })

  it('seek includes a frame exactly at the window boundary and excludes the next second', async () => {
    const filePath = path.join(tmpRawDir, 'boundary.RAW')
    const recs = [
      buildOuterRecord(1, [{ type: 'capSense', ts: 9500, left: 0, right: 0 }]),
      buildOuterRecord(2, [{ type: 'capSense', ts: 9530, left: 1, right: 1 }]), // == target + 30s
      buildOuterRecord(3, [{ type: 'capSense', ts: 9531, left: 2, right: 2 }]),
    ]

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat(recs))
    await waitUntil(() => client.messages.filter(m => m.type === 'capSense').length >= 3)

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 9500 }))
    await client.waitFor(m => m.type === 'seek_complete')
    const replayed = client.messages.slice(before).filter(m => m.type === 'capSense').map(m => m.ts)
    expect(replayed).toContain(9530)
    expect(replayed).not.toContain(9531)
    await client.close()
  })

  it('seek replay stops for good at the first out-of-window frame', async () => {
    const filePath = path.join(tmpRawDir, 'stop-window.RAW')
    // Non-monotonic tail: an in-window frame AFTER an out-of-window one must
    // not be replayed — the loop is done, not skipping. ts 9035 stays inside
    // FRAME_INDEX_RETENTION_S so the 9000 index entry survives for the seek.
    const recs = [
      buildOuterRecord(1, [{ type: 'capSense', ts: 9000, left: 0, right: 0 }]),
      buildOuterRecord(2, [{ type: 'capSense', ts: 9035, left: 1, right: 1 }]),
      buildOuterRecord(3, [{ type: 'capSense', ts: 9005, left: 2, right: 2 }]),
    ]

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat(recs))
    await waitUntil(() => client.messages.filter(m => m.type === 'capSense').length >= 3)

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 9000 }))
    await client.waitFor(m => m.type === 'seek_complete')
    const replayed = client.messages.slice(before).filter(m => m.type === 'capSense').map(m => m.ts)
    expect(replayed).toEqual([9000])
    await client.close()
  })

  it('delivers a record split across appends exactly once, with a seekable index offset', async () => {
    const filePath = path.join(tmpRawDir, 'split.RAW')
    const rec1 = buildOuterRecord(1, [{ type: 'capSense', ts: 2100, left: 0, right: 0 }])
    const rec2 = buildOuterRecord(2, [{ type: 'capSense', ts: 2101, left: 1, right: 1 }])
    const half = Math.floor(rec2.length / 2)

    const warnSpy = vi.spyOn(console, 'warn')
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat([rec1, rec2.subarray(0, half)]))
    await client.waitFor(m => m.type === 'capSense' && m.ts === 2100)

    fs.appendFileSync(filePath, rec2.subarray(half))
    await client.waitFor(m => m.type === 'capSense' && m.ts === 2101, 3000)

    // Leftover-buffer accounting: the completed first record must not be
    // re-parsed on the second tick, and a clean split produces no resync noise.
    expect(client.messages.filter(m => m.type === 'capSense' && m.ts === 2100).length).toBe(1)
    expect(warnSpy).not.toHaveBeenCalled()

    // The split record's index entry must point at its true file offset —
    // seek to it and verify the replay actually contains it.
    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 2101 }))
    await client.waitFor(m => m.type === 'seek_complete')
    const replayed = client.messages.slice(before).filter(m => m.type === 'capSense')
    expect(replayed.some(m => m.ts === 2101)).toBe(true)
    await client.close()
  })

  it('snapshots Pod 3 scalar capSense frames and logs the RAW file switch', async () => {
    const filePath = path.join(tmpRawDir, 'pod3-cap.RAW')
    const rec = buildOuterRecord(1, [{ type: 'capSense', ts: 2200, left: 5, right: 7 }])

    const logSpy = vi.spyOn(console, 'log')
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, rec)
    await client.waitFor(m => m.type === 'capSense' && m.ts === 2200, 3000)

    const snap = getLatestCapSenseSnapshot()
    expect(snap?.type).toBe('capSense')
    expect(snap?.ts).toBe(2200)
    expect(snap?.left).toEqual([5])
    expect(snap?.right).toEqual([7])
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Switched to RAW file: pod3-cap.RAW'))
    await client.close()
  })

  it('closes the live-tail descriptor when a read fails after open', async () => {
    const filePath = path.join(tmpRawDir, 'live-read-error.RAW')
    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.from([0xa2]))

    // Built-in ESM namespace exports are non-configurable; patch the shared
    // CommonJS fs object that backs piezoStream's live bindings instead.
    const mutableFs = require('node:fs') as typeof fs
    const open = vi.spyOn(mutableFs, 'openSync').mockReturnValue(91)
    const stat = vi.spyOn(mutableFs, 'fstatSync').mockReturnValue({ size: 1 } as never)
    const read = vi.spyOn(mutableFs, 'readSync').mockImplementation(() => {
      throw new Error('read failed')
    })
    const close = vi.spyOn(mutableFs, 'closeSync').mockImplementation(() => {})
    syncBuiltinESMExports()

    try {
      await waitUntil(() => close.mock.calls.some(([fd]) => fd === 91))
      expect(open).toHaveBeenCalled()
      expect(stat).toHaveBeenCalledWith(91)
      expect(read).toHaveBeenCalled()
      expect(close).toHaveBeenCalledWith(91)
    }
    finally {
      close.mockRestore()
      read.mockRestore()
      stat.mockRestore()
      open.mockRestore()
      syncBuiltinESMExports()
      await client.close()
    }
  })

  it('does not fan non-frzHealth file frames out to server-side listeners', async () => {
    const filePath = path.join(tmpRawDir, 'not-health.RAW')
    const rec = buildOuterRecord(1, [{ type: 'capSense', ts: 2300, left: 0, right: 0 }])

    const cb = vi.fn()
    const unsub = onServerFrame(cb)
    try {
      const port = startAndPort()
      const client = await connectClient(port)
      fs.writeFileSync(filePath, rec)
      await client.waitFor(m => m.type === 'capSense' && m.ts === 2300)
      expect(cb).not.toHaveBeenCalled()
      await client.close()
    }
    finally {
      unsub()
    }
  })

  it('shutdown actually closes the listening socket and logs start/stop', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const port = startAndPort()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('WebSocket server listening on port'))

    await shutdownPiezoStreamServer()
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('WebSocket server closed'))

    // The port must refuse new connections after shutdown.
    await expect(new Promise((resolve, reject) => {
      const probe = new WsClient(`ws://127.0.0.1:${port}`)
      probe.once('open', () => resolve('open'))
      probe.once('error', reject)
    })).rejects.toThrow()
  })

  it('terminates active clients and clears their state during shutdown', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    const serverSocket = [...startPiezoStreamServer().clients][0]
    const terminateSpy = vi.spyOn(serverSocket, 'terminate')
    clientSubscriptions.set(serverSocket, new Set(['capSense']))
    clientDroppedFrames.set(serverSocket, 3)

    await shutdownPiezoStreamServer()

    expect(terminateSpy).toHaveBeenCalledOnce()
    expect(clientSubscriptions.size).toBe(0)
    expect(clientDroppedFrames.size).toBe(0)
    await waitUntil(() => client.ws.readyState === WsClient.CLOSED)
    expect(client.ws.readyState).toBe(WsClient.CLOSED)
  })

  it('logs client connect and plain disconnect (no drop suffix for healthy clients)', async () => {
    const logSpy = vi.spyOn(console, 'log')
    const port = startAndPort()
    const client = await connectClient(port)
    await waitUntil(() => logSpy.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('Client connected')))

    await client.close()
    // A client with zero dropped frames gets the plain message, verbatim.
    await waitUntil(() => logSpy.mock.calls.some(
      c => c.length === 1 && c[0] === '[sensorStream] Client disconnected'))
  })

  /** JSON.stringify calls whose argument is a decoded frame of `type`. */
  function frameSerializations(spy: ReturnType<typeof vi.spyOn>, type: string): unknown[] {
    return spy.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'object' && c[0] !== null && (c[0] as any).type === type)
  }

  it('does not yield for a complete replay of exactly 499 records', async () => {
    const filePath = path.join(tmpRawDir, 'yield-before-boundary.RAW')
    const records = Array.from({ length: 499 }, (_, i) => buildOuterRecord(i + 1, [{
      type: 'capSense',
      ts: 2490,
      left: i,
      right: i,
    }]))

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat(records))
    await waitUntil(() => client.messages.filter(m => m.type === 'capSense').length >= 499, 5000)

    const immediateSpy = vi.spyOn(globalThis, 'setImmediate')
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 2489 }))
    await client.waitFor(m => m.type === 'seek_complete', 5000)

    expect(immediateSpy).not.toHaveBeenCalled()
    await client.close()
  }, 20000)

  it('yields exactly once at the 500-record replay boundary', async () => {
    const filePath = path.join(tmpRawDir, 'yield-boundary.RAW')
    // Exactly 500 records: the counter reaches the yield threshold on the last
    // one. An off-by-one boundary never yields; yielding per record yields 500x.
    const records = Array.from({ length: 500 }, (_, i) => buildOuterRecord(i + 1, [{
      type: 'capSense',
      ts: 2500,
      left: i,
      right: i,
    }]))

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat(records))
    await waitUntil(() => client.messages.filter(m => m.type === 'capSense').length >= 500, 5000)

    const immediateSpy = vi.spyOn(globalThis, 'setImmediate')
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 2499 }))
    await client.waitFor(m => m.type === 'seek_complete', 5000)

    expect(immediateSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(immediateSpy.mock.calls.length).toBeLessThan(50)
    await client.close()
  }, 20000)

  it('seek neither serializes nor sends once the requesting client is no longer OPEN', async () => {
    const filePath = path.join(tmpRawDir, 'seek-closed.RAW')
    const recs: Buffer[] = []
    for (let i = 0; i < 500; i++) {
      recs.push(buildOuterRecord(i + 1, [{
        type: 'capSense',
        ts: 2400 + i / 100,
        left: i,
        right: i,
      }]))
    }

    const port = startAndPort()
    const client = await connectClient(port)
    fs.writeFileSync(filePath, Buffer.concat(recs))
    await waitUntil(() => client.messages.filter(m => m.type === 'capSense').length >= 500, 5000)

    // Pin the server-side socket to CLOSED so the replay loop must bail on its
    // first frame and the completion notice must be withheld.
    const serverSocket = [...startPiezoStreamServer().clients][0] as any
    const sendSpy = vi.spyOn(serverSocket, 'send')
    const stringifySpy = vi.spyOn(JSON, 'stringify')
    const immediateSpy = vi.spyOn(globalThis, 'setImmediate')
    let readyStateReads = 0
    Object.defineProperty(serverSocket, 'readyState', {
      get: () => {
        readyStateReads += 1
        return WsClient.CLOSED
      },
      configurable: true,
    })

    try {
      client.ws.send(JSON.stringify({ type: 'seek', timestamp: 2399 }))
      await waitUntil(() => readyStateReads > 0, 3_000)

      expect(frameSerializations(stringifySpy, 'capSense')).toHaveLength(0)
      expect(sendSpy).not.toHaveBeenCalled()
      expect(immediateSpy).not.toHaveBeenCalled()
    }
    finally {
      delete serverSocket.readyState
      await client.close()
    }
  }, 20000)

  it('serializes a live frame once no matter how many clients receive it', async () => {
    const filePath = path.join(tmpRawDir, 'one-serialize.RAW')
    const port = startAndPort()
    const a = await connectClient(port)
    const b = await connectClient(port)

    const stringifySpy = vi.spyOn(JSON, 'stringify')
    fs.writeFileSync(filePath, buildOuterRecord(1, [{
      type: 'capSense', ts: 2700, left: 0, right: 0,
    }]))
    await a.waitFor(m => m.type === 'capSense' && m.ts === 2700, 3000)
    await b.waitFor(m => m.type === 'capSense' && m.ts === 2700, 3000)

    expect(frameSerializations(stringifySpy, 'capSense')).toHaveLength(1)
    await a.close()
    await b.close()
  })

  it('does not serialize a live frame when the only client is not OPEN', async () => {
    const filePath = path.join(tmpRawDir, 'live-closed.RAW')
    // frzHealth reaches server-side listeners regardless of client state, so it
    // marks the tick that already processed the preceding capSense record.
    const bytes = Buffer.concat([
      buildOuterRecord(1, [{ type: 'capSense', ts: 2600, left: 0, right: 0 }]),
      buildOuterRecord(2, [{
        type: 'frzHealth',
        ts: 2601,
        left: { tec: { current: 1 } },
        right: { tec: { current: 2 } },
        fan: { top: { rpm: 100 } },
      }]),
    ])

    const cb = vi.fn()
    const unsub = onServerFrame(cb)
    try {
      const port = startAndPort()
      const client = await connectClient(port)
      const serverSocket = [...startPiezoStreamServer().clients][0] as any
      Object.defineProperty(serverSocket, 'readyState', {
        get: () => WsClient.CLOSED,
        configurable: true,
      })

      const stringifySpy = vi.spyOn(JSON, 'stringify')
      fs.writeFileSync(filePath, bytes)
      await waitUntil(() => cb.mock.calls.length > 0, 3000)

      expect(frameSerializations(stringifySpy, 'capSense')).toHaveLength(0)
      delete serverSocket.readyState
      await client.close()
    }
    finally {
      unsub()
    }
  })

  it('serializes a broadcast frame once no matter how many clients receive it', async () => {
    const port = startAndPort()
    const a = await connectClient(port)
    const b = await connectClient(port)
    await waitUntil(() => startPiezoStreamServer().clients.size === 2)

    const frame = { type: 'deviceStatus', ts: 2800 }
    const stringifySpy = vi.spyOn(JSON, 'stringify')
    broadcastFrame(frame)
    await a.waitFor(m => m.type === 'deviceStatus' && m.ts === 2800)
    await b.waitFor(m => m.type === 'deviceStatus' && m.ts === 2800)

    expect(stringifySpy.mock.calls.filter(c => c[0] === frame)).toHaveLength(1)
    await a.close()
    await b.close()
  })

  it('does not serialize a broadcast frame when the only client is not OPEN', async () => {
    const port = startAndPort()
    const client = await connectClient(port)
    const serverSocket = [...startPiezoStreamServer().clients][0] as any
    Object.defineProperty(serverSocket, 'readyState', {
      get: () => WsClient.CLOSED,
      configurable: true,
    })

    const frame = { type: 'deviceStatus', ts: 2900 }
    const stringifySpy = vi.spyOn(JSON, 'stringify')
    broadcastFrame(frame)

    expect(stringifySpy.mock.calls.filter(c => c[0] === frame)).toHaveLength(0)
    delete serverSocket.readyState
    await client.close()
  })

  it('replays a seek buffer larger than one read chunk without gaps or aborts', async () => {
    const filePath = path.join(tmpRawDir, 'multi-chunk.RAW')
    // >4 MB of payload between the two capSense records forces the chunked read
    // loop to run more than once. A wrong chunk length or read position either
    // aborts the seek outright or hands the parser corrupted bytes.
    const bulk = 'x'.repeat(5 * 1024 * 1024)
    const bytes = Buffer.concat([
      buildOuterRecord(1, [{ type: 'capSense', ts: 3000, left: 0, right: 0 }]),
      buildOuterRecord(2, [{ type: 'log', ts: 3001, level: 1, msg: bulk }]),
      buildOuterRecord(3, [{ type: 'capSense', ts: 3002, left: 1, right: 1 }]),
    ])

    const port = startAndPort()
    const client = await connectClient(port)
    // Filter to capSense so the multi-megabyte log frame is never sent over the
    // socket — the read path is what matters here, not the fan-out.
    client.ws.send(JSON.stringify({ type: 'subscribe', sensors: ['capSense'] }))
    await client.waitFor(m => m.type === 'subscribed')
    fs.writeFileSync(filePath, bytes)
    await waitUntil(() => client.messages.some(m => m.type === 'capSense' && m.ts === 3002), 10000)

    const before = client.messages.length
    client.ws.send(JSON.stringify({ type: 'seek', timestamp: 2999 }))
    await client.waitFor(m => m.type === 'seek_complete', 10000)

    const replayed = client.messages.slice(before).filter(m => m.type === 'capSense').map(m => m.ts)
    expect(replayed).toEqual([3000, 3002])
    await client.close()
  }, 30000)

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

describe('piezoStream — findLatestRaw selection and fallback', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'piezo-find-raw-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('ignores SEQNO.RAW when a real capture exists alongside it', () => {
    fs.writeFileSync(path.join(dir, 'SEQNO.RAW'), 'seqno')
    fs.writeFileSync(path.join(dir, '00D0660E.RAW'), 'real')
    expect(findLatestRaw(dir)).toBe(path.join(dir, '00D0660E.RAW'))
  })

  it('returns null when SEQNO.RAW is the only RAW at top level and no fallback dir exists', () => {
    fs.writeFileSync(path.join(dir, 'SEQNO.RAW'), 'seqno')
    expect(findLatestRaw(dir)).toBeNull()
  })

  it('falls back to <dir>/biometrics when the top-level dir has no usable RAW', () => {
    // Reproduces the pod-5 layout that motivated this fix: SEQNO.RAW symlink
    // sits at /persistent root, real captures land in /persistent/biometrics.
    fs.writeFileSync(path.join(dir, 'SEQNO.RAW'), 'seqno')
    const bio = path.join(dir, 'biometrics')
    fs.mkdirSync(bio)
    fs.writeFileSync(path.join(bio, '00D0660E.RAW'), 'real')
    expect(findLatestRaw(dir)).toBe(path.join(bio, '00D0660E.RAW'))
  })

  it('prefers a top-level RAW over the fallback when both are present', () => {
    // Older firmware still writes captures at the top level; do not migrate
    // away from them just because /persistent/biometrics also exists.
    fs.writeFileSync(path.join(dir, 'top.RAW'), 'top')
    const bio = path.join(dir, 'biometrics')
    fs.mkdirSync(bio)
    fs.writeFileSync(path.join(bio, 'fallback.RAW'), 'fallback')
    expect(findLatestRaw(dir)).toBe(path.join(dir, 'top.RAW'))
  })

  it('returns null when neither the top-level dir nor the fallback has a usable RAW', () => {
    expect(findLatestRaw(dir)).toBeNull()
  })
})

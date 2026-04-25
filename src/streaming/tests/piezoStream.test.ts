/**
 * Tests for the WebSocket streaming resource-management surfaces:
 *   - Bounded frame index (issue #324 — was unbounded, ~70MB at 24h)
 *   - Per-client cleanup on disconnect
 *   - Backpressure guard on outbound sends
 *   - Transport-level config (maxPayload)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { __test__ } from '../piezoStream'

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

  it('allows exactly at the threshold (strict greater-than guard)', () => {
    const ws = fakeWs({ bufferedAmount: MAX_BUFFERED_BYTES })
    const ok = sendWithBackpressure(ws as never, 'payload')
    expect(ok).toBe(true)
    expect(ws.sent).toEqual(['payload'])
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

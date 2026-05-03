/**
 * WebSocket server for streaming raw sensor data to iOS clients.
 *
 * Runs on port 3001 (separate from the Next.js tRPC server on 3000).
 * Reads the newest `.RAW` file from the configured data directory using
 * manual CBOR byte parsing (the same `_read_raw_record` strategy used by
 * the Python piezo-processor sidecar — see modules/piezo-processor/main.py).
 *
 * Streams all sensor types: piezo, capacitance, bed temperature, freezer
 * temperature, freezer health, and firmware logs. Clients can subscribe to
 * specific types to avoid receiving unwanted high-frequency data.
 *
 * Protocol:
 *   Client → Server:
 *     { type: "subscribe", sensors: [...] }  — subscribe to sensor types
 *                                              (default: all types)
 *     { type: "get_time_range" }             — request available scrub range
 *     { type: "seek", timestamp: <ms> }      — seek to a timestamp in the RAW file
 *
 *   Server → Client (sensor frames, filtered by subscription):
 *     { type: "piezo-dual", ts, left1, right1, ... }   — piezo BCG (~1 Hz)
 *     { type: "capSense"|"capSense2", ts, left, right } — presence (~2 Hz)
 *     { type: "bedTemp"|"bedTemp2", ts, ... }           — bed temperature (~0.06 Hz)
 *     { type: "frzTemp", ts, left, right, amb, hs }     — freezer temp (~0.06 Hz)
 *     { type: "frzTherm", ts, left, right }             — thermal control status
 *     { type: "frzHealth", ts, left, right, fan }       — hardware health
 *     { type: "log", ts, level, msg }                   — firmware debug log
 *
 *   Server → Client (control):
 *     { type: "error", message }     — error notification
 *     { type: "subscribed", sensors } — ack for subscribe
 *     { type: "time_range", min, max, file } — available scrub range
 *     { type: "seek_complete" }      — seek replay finished
 */

import { WebSocketServer, WebSocket } from 'ws'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Decoder } from 'cbor-x'
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WS_PORT = Number(process.env.PIEZO_WS_PORT ?? 3001)
const RAW_DATA_DIR = process.env.RAW_DATA_DIR ?? '/persistent'
const FILE_POLL_INTERVAL_MS = 10 // match Python's 10 ms poll for new data
const SEEK_MAX_DURATION_S = 30 // max seconds of data to replay on seek
// Keep frame-index entries within the seek window plus a small margin so the
// index stays bounded on long-running streams (24h at 50fps was ~70MB).
const FRAME_INDEX_RETENTION_S = SEEK_MAX_DURATION_S + 10
// Drop outbound frames for a client whose send buffer exceeds this many bytes.
// Prevents a slow/stalled client from pinning unbounded server memory.
const MAX_BUFFERED_BYTES = 1024 * 1024 // 1 MB
// Cap inbound client messages. All client→server messages are tiny JSON
// (subscribe / get_time_range / seek) — 1 KiB is well above the largest.
const WS_MAX_PAYLOAD_BYTES = 1024

// ---------------------------------------------------------------------------
// In-memory sidecar index: maps timestamps to byte offsets in the current RAW
// file. Built incrementally as frames are parsed during live streaming.
// Reset whenever the active RAW file changes.
// ---------------------------------------------------------------------------

interface FrameIndexEntry {
  /** Frame timestamp (epoch seconds, as stored in the RAW file). */
  ts: number
  /** Byte offset in the RAW file where the outer CBOR record starts. */
  offset: number
}

const frameIndex: FrameIndexEntry[] = []
/** Path of the RAW file that `frameIndex` corresponds to. */
let indexedFilePath: string | null = null

/**
 * Append an entry and evict anything older than the seek-retention window.
 * Seek is capped at `SEEK_MAX_DURATION_S` so older entries are unreachable.
 * Called on every decoded frame — keep the hot path cheap (amortized O(1)).
 */
function appendFrameIndex(entry: FrameIndexEntry): void {
  frameIndex.push(entry)
  const cutoff = entry.ts - FRAME_INDEX_RETENTION_S
  // Drop the prefix of entries older than the cutoff. Entries are monotonic
  // in `ts` because frames are parsed in file order, so a single leading
  // slice is correct. Batch the splice to avoid O(n) shift per push.
  if (frameIndex.length > 0 && frameIndex[0].ts < cutoff) {
    let drop = 0
    while (drop < frameIndex.length && frameIndex[drop].ts < cutoff) drop += 1
    if (drop > 0) frameIndex.splice(0, drop)
  }
}

// ---------------------------------------------------------------------------
// CBOR record reader (TypeScript port of Python _read_raw_record)
// ---------------------------------------------------------------------------

/**
 * Manually parse one outer {seq, data} CBOR record from a Buffer
 * starting at `offset`.
 *
 * Returns `{ data: Buffer | null, nextOffset: number }`.
 * `data` is null for empty placeholder records.
 * Throws `RangeError` when there is not enough data (caller should wait).
 */
function readRawRecord(
  buf: Buffer,
  offset: number
): { data: Buffer | null, nextOffset: number } {
  const end = buf.length
  let pos = offset

  function need(n: number): void {
    if (pos + n > end) throw new RangeError('Incomplete record')
  }

  // Outer map(2)
  need(1)
  if (buf[pos] !== 0xa2) {
    throw new Error(`Expected outer map 0xa2, got 0x${buf[pos].toString(16)}`)
  }
  pos += 1

  // "seq" key (text(3) + "seq")
  need(4)
  if (
    buf[pos] !== 0x63
    || buf[pos + 1] !== 0x73
    || buf[pos + 2] !== 0x65
    || buf[pos + 3] !== 0x71
  ) {
    throw new Error('Expected seq key')
  }
  pos += 4

  // seq value — CBOR unsigned integer (any valid encoding)
  need(1)
  const seqHdr = buf[pos]
  pos += 1
  const seqAi = seqHdr & 0x1f
  const seqMt = seqHdr >> 5
  if (seqMt !== 0) {
    throw new Error(`seq must be unsigned int, got major type ${seqMt}`)
  }
  if (seqAi <= 23) {
    // inline value — no additional bytes
  }
  else if (seqAi === 24) {
    need(1)
    pos += 1
  }
  else if (seqAi === 25) {
    need(2)
    pos += 2
  }
  else if (seqAi === 26) {
    need(4)
    pos += 4
  }
  else if (seqAi === 27) {
    need(8)
    pos += 8
  }
  else {
    throw new Error(`Unexpected seq encoding: 0x${seqHdr.toString(16)}`)
  }

  // "data" key (text(4) + "data")
  need(5)
  if (
    buf[pos] !== 0x64
    || buf[pos + 1] !== 0x64
    || buf[pos + 2] !== 0x61
    || buf[pos + 3] !== 0x74
    || buf[pos + 4] !== 0x61
  ) {
    throw new Error('Expected data key')
  }
  pos += 5

  // data value — byte string
  need(1)
  const bsHdr = buf[pos]
  pos += 1
  const ai = bsHdr & 0x1f
  let length: number
  if (ai <= 23) {
    length = ai
  }
  else if (ai === 24) {
    need(1)
    length = buf[pos]
    pos += 1
  }
  else if (ai === 25) {
    need(2)
    length = buf.readUInt16BE(pos)
    pos += 2
  }
  else if (ai === 26) {
    need(4)
    length = buf.readUInt32BE(pos)
    pos += 4
  }
  else {
    throw new Error(`Unsupported length encoding: ${ai}`)
  }

  need(length)
  const data = length > 0 ? buf.subarray(pos, pos + length) : null
  pos += length

  return { data, nextOffset: pos }
}

/**
 * Find the next outer-record marker (0xa2) at or after `from`. Returns the
 * absolute buffer offset, or -1 if no marker exists in the remaining bytes.
 *
 * Used for resync after a malformed record — fast-forwarding to the next
 * 0xa2 instead of advancing one byte at a time avoids log-spamming every
 * null byte inside a partial piezo payload.
 */
function findNextRecordMarker(buf: Buffer, from: number): number {
  return buf.indexOf(0xa2, from)
}

// ---------------------------------------------------------------------------
// RAW file follower
// ---------------------------------------------------------------------------

function findLatestRaw(dir: string): string | null {
  try {
    const entries = fs.readdirSync(dir)
    const rawFiles = entries
      .filter(e => e.endsWith('.RAW'))
      .map(e => ({
        name: e,
        mtime: fs.statSync(path.join(dir, e)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
    return rawFiles.length > 0 ? path.join(dir, rawFiles[0].name) : null
  }
  catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Sensor types
// ---------------------------------------------------------------------------

/** All sensor record types the firmware emits. */
const ALL_SENSOR_TYPES = [
  'piezo-dual', 'capSense', 'capSense2',
  'bedTemp', 'bedTemp2', 'frzTemp', 'frzTherm', 'frzHealth', 'log',
  'deviceStatus', 'gesture',
] as const

/** Valid sensor type string. Used for subscription filtering. */
type SensorType = typeof ALL_SENSOR_TYPES[number]

// ---------------------------------------------------------------------------
// Sensor frame decoder
// ---------------------------------------------------------------------------

const cborDecoder = new Decoder({ mapsAsObjects: true, useRecords: false })

/** Convert raw byte buffer of little-endian int32s to a JS number array. */
function int32BufferToArray(raw: Buffer | Uint8Array | undefined): number[] {
  if (!raw || raw.length === 0) return []
  // Guard against partial buffers (byteLength not multiple of 4)
  const usableBytes = raw.byteLength - (raw.byteLength % 4)
  if (usableBytes === 0) return []
  const view = new DataView(raw.buffer, raw.byteOffset, usableBytes)
  const nums: number[] = []
  for (let i = 0; i < usableBytes; i += 4) {
    nums.push(view.getInt32(i, true))
  }
  return nums
}

/**
 * Decode CBOR inner data into JSON-serializable sensor frames.
 *
 * The inner data blob from a RAW record can contain multiple concatenated
 * CBOR values (the firmware packs several sensor readings per outer record).
 *
 * For piezo-dual: converts raw byte buffers (int32 arrays) to number arrays.
 * For all other types: normalizes nested firmware structures to flat schemas.
 *
 * Returns an array of decoded frames (may be empty on failure).
 */
function decodeSensorFrames(innerBytes: Buffer): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  try {
    // decodeMultiple handles concatenated CBOR values in a single buffer
    cborDecoder.decodeMultiple(innerBytes, (inner: unknown) => {
      if (!inner || typeof inner !== 'object' || !('type' in (inner as Record<string, unknown>))) return
      const rec = inner as Record<string, unknown>
      const recordType = rec.type as string

      if (recordType === 'piezo-dual') {
        frames.push({
          type: 'piezo-dual',
          ts: rec.ts ?? Math.floor(Date.now() / 1000), // epoch seconds (consistent with firmware)
          freq: rec.freq,
          left1: int32BufferToArray(rec.left1 as Buffer | Uint8Array | undefined),
          right1: int32BufferToArray(rec.right1 as Buffer | Uint8Array | undefined),
          left2: rec.left2 ? int32BufferToArray(rec.left2 as Buffer | Uint8Array) : undefined,
          right2: rec.right2 ? int32BufferToArray(rec.right2 as Buffer | Uint8Array) : undefined,
        })
      }
      else {
        // Pass through as-is — iOS expects the raw nested firmware format.
        // Browser normalizes in useSensorStream handleMessage.
        frames.push(rec)
      }
    })
  }
  catch {
    // Partial decode — return whatever we got
  }
  return frames
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

let wss: WebSocketServer | null = null
let streamingInterval: ReturnType<typeof setInterval> | null = null

/** Per-client sensor subscriptions. undefined = all types (default). */
const clientSubscriptions = new Map<WebSocket, Set<SensorType> | undefined>()
/** Per-client count of frames dropped due to send-buffer backpressure. */
const clientDroppedFrames = new Map<WebSocket, number>()

/**
 * Forget all per-client state. Must be called from the `close` handler so
 * disconnected clients do not pin memory until the next GC cycle.
 */
function cleanupClient(ws: WebSocket): void {
  clientSubscriptions.delete(ws)
  clientDroppedFrames.delete(ws)
}

/**
 * Send `payload` to `client` unless its send buffer already exceeds
 * `MAX_BUFFERED_BYTES`. Returns true if sent, false if skipped. Skipping
 * preserves the live stream for healthy clients when a single slow client
 * would otherwise cause unbounded server memory growth.
 */
function sendWithBackpressure(client: WebSocket, payload: string): boolean {
  if (client.readyState !== WebSocket.OPEN) return false
  // Account for the pending payload — checking bufferedAmount alone lets each
  // send push the buffer past MAX_BUFFERED_BYTES before the next call notices.
  const payloadByteSize = Buffer.byteLength(payload)
  if (client.bufferedAmount + payloadByteSize > MAX_BUFFERED_BYTES) {
    clientDroppedFrames.set(client, (clientDroppedFrames.get(client) ?? 0) + 1)
    return false
  }
  try {
    client.send(payload)
    return true
  }
  catch {
    return false
  }
}

function handleClientMessage(ws: WebSocket, raw: Buffer | string): void {
  try {
    const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'))

    if (msg.type === 'subscribe') {
      // Client specifies which sensor types it wants
      const requested = msg.sensors as string[] | undefined
      if (!Array.isArray(requested) || requested.length === 0) {
        // Empty or missing → subscribe to all (undefined = no filter)
        clientSubscriptions.set(ws, undefined)
        ws.send(JSON.stringify({ type: 'subscribed', sensors: [...ALL_SENSOR_TYPES] }))
        console.log('[sensorStream] Client subscribed to: all')
      }
      else {
        const valid = requested.filter(
          (s): s is SensorType => (ALL_SENSOR_TYPES as readonly string[]).includes(s))
        if (valid.length === 0) {
          ws.send(JSON.stringify({
            type: 'error',
            message: `No valid sensor types in request. Valid types: ${ALL_SENSOR_TYPES.join(', ')}`,
          }))
        }
        else {
          clientSubscriptions.set(ws, new Set(valid))
          ws.send(JSON.stringify({ type: 'subscribed', sensors: valid }))
          console.log('[sensorStream] Client subscribed to: %s', valid.join(', '))
        }
      }
    }
    else if (msg.type === 'get_time_range') {
      if (frameIndex.length === 0) {
        ws.send(JSON.stringify({ type: 'time_range', min: 0, max: 0, file: null }))
      }
      else {
        ws.send(JSON.stringify({
          type: 'time_range',
          min: frameIndex[0].ts,
          max: frameIndex[frameIndex.length - 1].ts,
          file: indexedFilePath ? path.basename(indexedFilePath) : null,
        }))
      }
    }
    else if (msg.type === 'seek') {
      const targetTs = msg.timestamp as number
      if (typeof targetTs !== 'number' || !isFinite(targetTs)) {
        ws.send(JSON.stringify({ type: 'error', message: 'seek requires a numeric timestamp' }))
        return
      }
      handleSeek(ws, targetTs)
    }
    else {
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }))
    }
  }
  catch {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }))
  }
}

// ---------------------------------------------------------------------------
// Seek: binary search + replay from a separate file descriptor
// ---------------------------------------------------------------------------

/**
 * Binary search `frameIndex` for the entry at or just before `targetTs`.
 * Returns the index into `frameIndex`, or -1 if the index is empty.
 * If the target is before the earliest entry, returns 0 (the first index).
 */
function findIndexEntry(targetTs: number): number {
  if (frameIndex.length === 0) return -1
  let lo = 0
  let hi = frameIndex.length - 1

  // Target is before all indexed frames
  if (targetTs < frameIndex[0].ts) return 0

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (frameIndex[mid].ts <= targetTs) {
      lo = mid + 1
    }
    else {
      hi = mid - 1
    }
  }
  // hi is now the largest index where ts <= targetTs
  return hi
}

/**
 * Handle a seek request: read frames from the RAW file starting at the
 * indexed byte offset nearest to `targetTs`, send them to the requesting
 * client only, then send `seek_complete`.
 *
 * Uses a separate file descriptor so the main live-streaming loop is
 * not affected.
 */
function handleSeek(ws: WebSocket, targetTs: number): void {
  if (!indexedFilePath) {
    ws.send(JSON.stringify({ type: 'error', message: 'No RAW file indexed yet' }))
    ws.send(JSON.stringify({ type: 'seek_complete' }))
    return
  }

  const idx = findIndexEntry(targetTs)
  if (idx < 0) {
    ws.send(JSON.stringify({ type: 'error', message: 'No frames indexed yet' }))
    ws.send(JSON.stringify({ type: 'seek_complete' }))
    return
  }

  const startOffset = frameIndex[idx].offset
  const filePath = indexedFilePath

  // Check subscription filter for this client
  const subs = clientSubscriptions.get(ws)

  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const stat = fs.fstatSync(fd)
    const fileSize = stat.size

    // Read from startOffset to end of file, capped at 64 MB to prevent memory exhaustion
    const MAX_SEEK_BUFFER = 64 * 1024 * 1024
    const rawBytesToRead = fileSize - startOffset
    if (rawBytesToRead <= 0) {
      fs.closeSync(fd)
      ws.send(JSON.stringify({ type: 'seek_complete' }))
      return
    }
    const bytesToRead = Math.min(rawBytesToRead, MAX_SEEK_BUFFER)

    const seekBuffer = Buffer.alloc(bytesToRead)
    fs.readSync(fd, seekBuffer, 0, bytesToRead, startOffset)
    fs.closeSync(fd)
    fd = null

    // Parse records and send frames, stopping after SEEK_MAX_DURATION_S
    let bufPos = 0
    const maxTs = targetTs + SEEK_MAX_DURATION_S
    let done = false
    let droppedDuringReplay = 0

    while (bufPos < seekBuffer.length && !done) {
      try {
        const { data, nextOffset } = readRawRecord(seekBuffer, bufPos)
        bufPos = nextOffset

        if (data === null) continue

        const frames = decodeSensorFrames(data)
        for (const frame of frames) {
          // Stop if we've exceeded the seek duration window
          const frameTs = frame.ts as number | undefined
          if (frameTs !== undefined && frameTs > maxTs) {
            done = true
            break
          }

          // Apply subscription filter
          const frameType = frame.type as string
          if (subs && !subs.has(frameType as SensorType)) continue

          if (ws.readyState !== WebSocket.OPEN) {
            done = true
            break
          }
          if (!sendWithBackpressure(ws, JSON.stringify(frame))) {
            droppedDuringReplay += 1
          }
        }
      }
      catch (e) {
        if (e instanceof RangeError) break // incomplete record
        const next = findNextRecordMarker(seekBuffer, bufPos + 1)
        if (next < 0) break // no marker in remaining bytes
        bufPos = next
      }
    }

    if (ws.readyState === WebSocket.OPEN) {
      // Report partial replays so the client can re-seek if needed instead of
      // assuming it received the full window.
      ws.send(JSON.stringify({
        type: 'seek_complete',
        ...(droppedDuringReplay > 0 && { incomplete: true, droppedFrames: droppedDuringReplay }),
      }))
    }
  }
  catch {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      }
      catch { /* ignore */ }
    }
  }
}

/**
 * Adaptive poll rate: tell DacMonitor to poll faster when clients are
 * connected, slower when idle. Lazy-imported to avoid circular deps.
 */
function updatePollRate(): void {
  import('@/src/hardware/dacMonitor.instance')
    .then(({ getDacMonitorIfRunning }) => {
      const monitor = getDacMonitorIfRunning()
      if (!monitor) return
      const clientCount = wss?.clients.size ?? 0
      if (clientCount > 0) {
        monitor.setActive()
      }
      else {
        monitor.setIdle()
      }
    })
    .catch(() => { /* monitor not started yet */ })
}

/**
 * Start the piezo WebSocket streaming server.
 * Called from instrumentation.ts during server startup.
 */
export function startPiezoStreamServer(): WebSocketServer {
  if (wss) return wss

  wss = new WebSocketServer({ port: WS_PORT, maxPayload: WS_MAX_PAYLOAD_BYTES })
  console.log(`[sensorStream] WebSocket server listening on port ${WS_PORT}`)

  // State for file tailing
  let currentPath: string | null = null
  let fileBuffer = Buffer.alloc(0)
  let readOffset = 0 // offset into the actual file (not the buffer)

  wss.on('connection', (ws) => {
    console.log('[sensorStream] Client connected')
    updatePollRate()

    ws.on('message', data => handleClientMessage(ws, data as Buffer | string))

    ws.on('close', () => {
      const dropped = clientDroppedFrames.get(ws) ?? 0
      cleanupClient(ws)
      if (dropped > 0) {
        console.log(`[sensorStream] Client disconnected (dropped ${dropped} frames due to backpressure)`)
      }
      else {
        console.log('[sensorStream] Client disconnected')
      }
      updatePollRate()
    })

    ws.on('error', (err) => {
      console.error('[sensorStream] WebSocket error:', err.message)
    })
  })

  // Periodic file-tailing loop: read new data from the RAW file and broadcast
  streamingInterval = setInterval(() => {
    if (!wss || wss.clients.size === 0) return

    // Find the latest RAW file
    const latest = findLatestRaw(RAW_DATA_DIR)
    if (!latest) return

    // Switch files if a newer one appeared
    if (latest !== currentPath) {
      console.log(`[sensorStream] Switched to RAW file: ${path.basename(latest)}`)
      currentPath = latest
      fileBuffer = Buffer.alloc(0)
      readOffset = 0
      // Reset the sidecar frame index for the new file
      frameIndex.length = 0
      indexedFilePath = latest
    }

    // Read any new bytes appended since last read
    let fd: number | null = null
    try {
      fd = fs.openSync(currentPath, 'r')
      const stat = fs.fstatSync(fd)
      const fileSize = stat.size

      if (fileSize <= readOffset) {
        fs.closeSync(fd)
        return // no new data
      }

      const newBytes = Buffer.alloc(fileSize - readOffset)
      fs.readSync(fd, newBytes, 0, newBytes.length, readOffset)
      fs.closeSync(fd)
      fd = null

      // Absolute file offset corresponding to bufferPos=0 in the combined buffer.
      // The leftover bytes in fileBuffer start at (readOffset - fileBuffer.length)
      // in the file. Compute BEFORE concat so fileBuffer.length is just leftovers.
      const bufferBaseFileOffset = readOffset - fileBuffer.length
      fileBuffer = Buffer.concat([fileBuffer, newBytes])
      readOffset = fileSize

      // Parse as many complete records as possible
      let bufferPos = 0
      while (bufferPos < fileBuffer.length) {
        // Capture the record's starting byte offset in the file (for the index)
        const recordFileOffset = bufferBaseFileOffset + bufferPos
        try {
          const { data, nextOffset } = readRawRecord(fileBuffer, bufferPos)
          bufferPos = nextOffset

          if (data === null) continue // empty placeholder

          const frames = decodeSensorFrames(data)

          for (const frame of frames) {
            const frameType = frame.type as string

            // Record timestamp→offset mapping in the sidecar index
            const ts = frame.ts as number | undefined
            if (ts !== undefined) {
              appendFrameIndex({ ts, offset: recordFileOffset })
            }

            // Broadcast to subscribed clients only
            const server = wss
            if (server) {
              // Pre-serialize once (avoid per-client JSON.stringify)
              let payload: string | null = null

              for (const client of server.clients) {
                if (client.readyState !== WebSocket.OPEN) continue

                // Check subscription filter (default: all types)
                const subs = clientSubscriptions.get(client)
                if (subs && !subs.has(frameType as SensorType)) continue

                // Lazy serialize — only if at least one client needs it
                if (payload === null) payload = JSON.stringify(frame)
                sendWithBackpressure(client, payload)
              }
            }

            // Notify server-side listeners (only frzHealth currently has consumers)
            if (frameType === 'frzHealth' && serverFrameListeners.size > 0) {
              for (const cb of serverFrameListeners) {
                try {
                  cb(frame as Record<string, unknown>)
                }
                catch { /* consumer error */ }
              }
            }
          }
        }
        catch (e) {
          if (e instanceof RangeError) {
            break // incomplete record — wait for more data
          }
          // Malformed record — fast-forward to the next 0xa2 marker. Avoids
          // log-spamming every byte inside a partial piezo payload (the v1
          // 0x00 nulls that motivated this) and recovers in O(remaining bytes).
          const next = findNextRecordMarker(fileBuffer, bufferPos + 1)
          if (next < 0) {
            // No marker in remaining bytes — drop what we have and wait for
            // more data on the next poll.
            console.warn('[sensorStream] Resync: no 0xa2 marker in remaining %d bytes (%s)',
              fileBuffer.length - bufferPos, (e as Error).message)
            bufferPos = fileBuffer.length
            break
          }
          console.warn('[sensorStream] Resync: skipped %d bytes to next record (%s)',
            next - bufferPos, (e as Error).message)
          bufferPos = next
        }
      }

      // Keep only unconsumed bytes in the buffer
      if (bufferPos > 0) {
        fileBuffer = fileBuffer.subarray(bufferPos)
      }
    }
    catch {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        }
        catch { /* ignore */ }
      }
      // Non-fatal — file may be temporarily unavailable
    }
  }, FILE_POLL_INTERVAL_MS)

  return wss
}

// Server-side frame listeners — called for every decoded sensor frame.
// Used by DeviceStateSync to record flow data without circular imports.
type ServerFrameListener = (frame: Record<string, unknown>) => void
const serverFrameListeners = new Set<ServerFrameListener>()

/** Register a callback invoked for every decoded sensor frame. Returns unsubscribe fn. */
export function onServerFrame(cb: ServerFrameListener): () => void {
  serverFrameListeners.add(cb)
  return () => {
    serverFrameListeners.delete(cb)
  }
}

/**
 * Broadcast a JSON message to all connected WS clients that are subscribed
 * to the given sensor type. Used by dacMonitor to push device status frames.
 */
export function broadcastFrame(frame: Record<string, unknown>): void {
  const server = wss
  if (!server || server.clients.size === 0) return

  const frameType = frame.type as string
  let payload: string | null = null

  for (const client of server.clients) {
    if (client.readyState !== WebSocket.OPEN) continue

    const subs = clientSubscriptions.get(client)
    if (subs && !subs.has(frameType as SensorType)) continue

    if (payload === null) payload = JSON.stringify(frame)
    sendWithBackpressure(client, payload)
  }
}

/**
 * Internal hooks exposed for unit tests. Not part of the public API — the
 * `__test__` prefix keeps them out of autocomplete for production callers.
 */
export const __test__ = {
  appendFrameIndex,
  cleanupClient,
  sendWithBackpressure,
  get frameIndex(): readonly FrameIndexEntry[] { return frameIndex },
  clientSubscriptions,
  clientDroppedFrames,
  FRAME_INDEX_RETENTION_S,
  MAX_BUFFERED_BYTES,
  WS_MAX_PAYLOAD_BYTES,
  resetFrameIndex(): void { frameIndex.length = 0 },
}

/**
 * Gracefully shut down the WebSocket server.
 * Called during graceful shutdown in instrumentation.ts.
 */
export async function shutdownPiezoStreamServer(): Promise<void> {
  if (streamingInterval) {
    clearInterval(streamingInterval)
    streamingInterval = null
  }

  const server = wss
  if (server) {
    wss = null
    return new Promise<void>((resolve) => {
      server.close(() => {
        // Drop per-client state explicitly — relying on per-socket close
        // events leaks if any handler failed to fire.
        clientSubscriptions.clear()
        clientDroppedFrames.clear()
        console.log('[sensorStream] WebSocket server closed')
        resolve()
      })
    })
  }
}

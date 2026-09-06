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
import type { FileHandle } from 'node:fs/promises'
import * as path from 'node:path'
import { Decoder } from 'cbor-x'
import { flushCapFrameWindows, recordCapFrame, resetCapFrameWindows } from './capFramePersistence'
import { capSideChannels, capSideStatus } from './normalizeFrame'
import { discoverSensorSource } from './sensorSourceDiscovery'
import { recordSensorSource, recordFirstSensorFrame } from '@/src/lib/serverPerformance'
import { natsReachable, startNatsFrameSource } from './natsFrameSource'
import type { NatsFrameSourceHandle } from './natsFrameSource'
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WS_PORT = Number(process.env.PIEZO_WS_PORT ?? 3001)
const RAW_DATA_DIR = process.env.RAW_DATA_DIR ?? '/persistent'
// Fallback subdirectory probed when RAW_DATA_DIR holds no usable .RAW files.
// New firmware writes captures under /persistent/biometrics; older firmware
// (and the SEQNO.RAW tmpfs symlink) sits at the /persistent root.
const RAW_DATA_FALLBACK_SUBDIR = 'biometrics'
const FILE_POLL_INTERVAL_MS = 25
const RAW_SCAN_INTERVAL_MS = 1_000
const RAW_READ_BYTES = 64 * 1024
const RAW_MAX_BUFFER_BYTES = 1024 * 1024
const RAW_DECODE_BUDGET_MS = 4
const RAW_RECORDS_PER_TICK = 128
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

// ── Source selection (RAW file tailer vs loopback NATS) ──
// New Pod 5 firmware publishes frames to a local NATS server instead of writing
// `.RAW` files. We probe reachability at startup and pick ONE source for the
// process lifetime — never both (duplicate-row risk). See docs/nats-frame-readers.md.
//
// Discovery is local to each Pod. An installed NATS unit or JetStream store
// preserves the startup wait; confirmed RAW-only installations skip it.
// PIEZO_SENSOR_SOURCE=raw|nats overrides auto detection for custom firmware;
// PIEZO_NATS_DISABLED=1 remains a backwards-compatible RAW escape hatch.
const streamGlobal = globalThis as typeof globalThis & { __sleepypodSensorStream?: ReturnType<typeof createStreamState> }
function createStreamState() {
  return {
    frameIndex: [] as FrameIndexEntry[],
    // RAW file associated with the seek index.
    indexedFilePath: null as string | null,
    latestCapSenseSnapshot: null as LatestCapSenseSnapshot | null,
    wss: null as WebSocketServer | null,
    streamingInterval: null as ReturnType<typeof setInterval> | null,
    // Exactly one live source is owned by this server.
    natsSource: null as NatsFrameSourceHandle | null,
    rawStop: null as (() => Promise<void>) | null,
    warnedUnknownTypes: new Set<string>(),
    // undefined subscribes the client to every sensor type.
    clientSubscriptions: new Map<WebSocket, Set<SensorType> | undefined>(),
    clientDroppedFrames: new Map<WebSocket, number>(),
  }
}
const streamState = streamGlobal.__sleepypodSensorStream ??= createStreamState()

const NATS_SOURCE_DISABLED = process.env.PIEZO_NATS_DISABLED === '1'
function natsTiming(value: string | undefined, fallback: number, allowZero: boolean): number {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : fallback
}
const NATS_GRACE_MS = natsTiming(process.env.PIEZO_NATS_GRACE_MS, 60_000, true)
const NATS_PROBE_INTERVAL_MS = natsTiming(process.env.PIEZO_NATS_PROBE_INTERVAL_MS, 5_000, false)

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

/**
 * Last seen capSense / capSense2 frame, kept as a cheap snapshot so
 * server-side consumers (e.g. the virtual occupancy sensor in
 * `src/lib/occupancy.ts`) can read the live channel readings without
 * subscribing to the WebSocket stream from within the same process.
 *
 * Mutated in the live broadcast loop. Cleared on RAW file switch.
 */
export interface LatestCapSenseSnapshot {
  /** Frame type as emitted by firmware. */
  type: 'capSense' | 'capSense2'
  /** Frame timestamp (unix seconds from firmware). */
  ts: number
  /** Wall-clock epoch ms when the snapshot was written. Used for staleness. */
  receivedAtMs: number
  /** Per-side channels — capSense (Pod 3) carries a scalar; capSense2 carries the
   *  raw `[A1,A2,B1,B2,C1,C2,ref1,ref2]` array. */
  left: number | number[]
  right: number | number[]
}

/**
 * Read the most recent capSense / capSense2 frame seen on the live RAW stream.
 * Returns null until the first frame arrives or after the RAW file switches.
 *
 * Consumers should treat a `receivedAtMs` older than ~30s as stale — capSense2
 * frames arrive at ~2 Hz; long gaps mean the sensor or the streamer is down.
 */
export function getLatestCapSenseSnapshot(): LatestCapSenseSnapshot | null {
  return streamState.latestCapSenseSnapshot
}

/**
 * Append an entry and evict anything older than the seek-retention window.
 * Seek is capped at `SEEK_MAX_DURATION_S` so older entries are unreachable.
 * Called on every decoded frame — keep the hot path cheap (amortized O(1)).
 */
function appendFrameIndex(entry: FrameIndexEntry): void {
  streamState.frameIndex.push(entry)
  const cutoff = entry.ts - FRAME_INDEX_RETENTION_S
  // Drop the prefix of entries older than the cutoff. Entries are monotonic
  // in `ts` because frames are parsed in file order, so a single leading
  // slice is correct. Batch the splice to avoid O(n) shift per push.
  if (streamState.frameIndex.length > 0 && streamState.frameIndex[0].ts < cutoff) {
    let drop = 0
    while (drop < streamState.frameIndex.length && streamState.frameIndex[drop].ts < cutoff) drop += 1
    if (drop > 0) streamState.frameIndex.splice(0, drop)
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

function findLatestRawIn(dir: string): string | null {
  try {
    const entries = fs.readdirSync(dir)
    const rawFiles = entries
      .filter(e => e.endsWith('.RAW') && e !== 'SEQNO.RAW')
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

// Probes `dir` first, then `<dir>/<RAW_DATA_FALLBACK_SUBDIR>`. The split exists
// because new firmware moved real captures to /persistent/biometrics while
// /persistent still holds the SEQNO.RAW symlink — without the fallback, the
// streamer would attach to SEQNO and emit CBOR resync errors.
export function findLatestRaw(dir: string): string | null {
  const direct = findLatestRawIn(dir)
  if (direct) return direct
  return findLatestRawIn(path.join(dir, RAW_DATA_FALLBACK_SUBDIR))
}

/** Async counterpart for the hot tailing path. Files can rotate while being
 * inspected; one disappearing entry must not hide all the remaining captures. */
async function findLatestRawAsync(dir: string): Promise<string | null> {
  for (const candidate of [dir, path.join(dir, RAW_DATA_FALLBACK_SUBDIR)]) {
    try {
      const entries = await fs.promises.readdir(candidate)
      let latest: { path: string, mtime: number } | null = null
      for (const entry of entries) {
        if (!entry.endsWith('.RAW') || entry === 'SEQNO.RAW') continue
        const filePath = path.join(candidate, entry)
        try {
          const info = await fs.promises.stat(filePath)
          if (info.isFile() && (!latest || info.mtimeMs > latest.mtime)) {
            latest = { path: filePath, mtime: info.mtimeMs }
          }
        }
        catch { /* Rotated between readdir and stat. */ }
      }
      if (latest) return latest.path
    }
    catch { /* Try the older firmware location. */ }
  }
  return null
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

/**
 * Forget all per-client state. Must be called from the `close` handler so
 * disconnected clients do not pin memory until the next GC cycle.
 */
function cleanupClient(ws: WebSocket): void {
  streamState.clientSubscriptions.delete(ws)
  streamState.clientDroppedFrames.delete(ws)
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
    streamState.clientDroppedFrames.set(client, (streamState.clientDroppedFrames.get(client) ?? 0) + 1)
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
        streamState.clientSubscriptions.set(ws, undefined)
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
          streamState.clientSubscriptions.set(ws, new Set(valid))
          ws.send(JSON.stringify({ type: 'subscribed', sensors: valid }))
          console.log('[sensorStream] Client subscribed to: %s', valid.join(', '))
        }
      }
    }
    else if (msg.type === 'get_time_range') {
      if (streamState.frameIndex.length === 0) {
        ws.send(JSON.stringify({ type: 'time_range', min: 0, max: 0, file: null }))
      }
      else {
        ws.send(JSON.stringify({
          type: 'time_range',
          min: streamState.frameIndex[0].ts,
          max: streamState.frameIndex[streamState.frameIndex.length - 1].ts,
          file: streamState.indexedFilePath ? path.basename(streamState.indexedFilePath) : null,
        }))
      }
    }
    else if (msg.type === 'seek') {
      const targetTs = msg.timestamp as number
      if (typeof targetTs !== 'number' || !isFinite(targetTs)) {
        ws.send(JSON.stringify({ type: 'error', message: 'seek requires a numeric timestamp' }))
        return
      }
      // Fire-and-forget: handleSeek settles internally (errors are caught
      // and reported to the client via seek_complete/error messages).
      void handleSeek(ws, targetTs)
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
 * Binary search `streamState.frameIndex` for the entry at or just before `targetTs`.
 * Returns the index into `streamState.frameIndex`, or -1 if the index is empty.
 * If the target is before the earliest entry, returns 0 (the first index).
 */
function findIndexEntry(targetTs: number): number {
  if (streamState.frameIndex.length === 0) return -1
  let lo = 0
  let hi = streamState.frameIndex.length - 1

  // Target is before all indexed frames
  if (targetTs < streamState.frameIndex[0].ts) return 0

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (streamState.frameIndex[mid].ts <= targetTs) {
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
async function handleSeek(ws: WebSocket, targetTs: number): Promise<void> {
  if (!streamState.indexedFilePath) {
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

  const startOffset = streamState.frameIndex[idx].offset
  const filePath = streamState.indexedFilePath

  // Check subscription filter for this client
  const subs = streamState.clientSubscriptions.get(ws)

  let fh: FileHandle | null = null
  try {
    fh = await fs.promises.open(filePath, 'r')
    const stat = await fh.stat()
    const fileSize = stat.size

    // Read from startOffset to end of file, capped at 64 MB to prevent memory exhaustion
    const MAX_SEEK_BUFFER = 64 * 1024 * 1024
    const rawBytesToRead = fileSize - startOffset
    if (rawBytesToRead <= 0) {
      await fh.close()
      fh = null
      ws.send(JSON.stringify({ type: 'seek_complete' }))
      return
    }
    const bytesToRead = Math.min(rawBytesToRead, MAX_SEEK_BUFFER)

    // Chunked async reads: a single readSync of up to 64 MB blocked the
    // event loop, stalling live streaming for every other client.
    const READ_CHUNK = 4 * 1024 * 1024
    let seekBuffer = Buffer.alloc(bytesToRead)
    let readTotal = 0
    while (readTotal < bytesToRead) {
      const { bytesRead } = await fh.read(
        seekBuffer,
        readTotal,
        Math.min(READ_CHUNK, bytesToRead - readTotal),
        startOffset + readTotal,
      )
      if (bytesRead === 0) break // file shrank (rotation) — parse what we have
      readTotal += bytesRead
    }
    if (readTotal < bytesToRead) seekBuffer = seekBuffer.subarray(0, readTotal)
    await fh.close()
    fh = null

    // Parse records and send frames, stopping after SEEK_MAX_DURATION_S
    let bufPos = 0
    const maxTs = targetTs + SEEK_MAX_DURATION_S
    let done = false
    let droppedDuringReplay = 0
    let recordsSinceYield = 0

    while (bufPos < seekBuffer.length && !done) {
      // Yield to the event loop periodically — the parse of a large replay
      // is CPU-bound and would otherwise block live frames.
      if (++recordsSinceYield >= 500) {
        recordsSinceYield = 0
        await new Promise(resolve => setImmediate(resolve))
      }
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
    if (fh !== null) {
      await fh.close().catch(() => { /* ignore */ })
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
      const clientCount = streamState.wss?.clients.size ?? 0
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
  if (streamState.wss) return streamState.wss

  streamState.wss = new WebSocketServer({ port: WS_PORT, maxPayload: WS_MAX_PAYLOAD_BYTES })
  console.log(`[sensorStream] WebSocket server listening on port ${WS_PORT}`)

  streamState.wss.on('connection', (ws) => {
    console.log('[sensorStream] Client connected')
    updatePollRate()

    ws.on('message', data => handleClientMessage(ws, data as Buffer | string))

    ws.on('close', () => {
      const dropped = streamState.clientDroppedFrames.get(ws) ?? 0
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

  // The WS server is already accepting clients; pick and attach the frame source
  // (RAW file tailer vs loopback NATS) asynchronously so a slow NATS probe never
  // blocks client connections.
  void selectAndStartSource(streamState.wss)

  return streamState.wss
}

/** Select once per server lifetime using this Pod's installation and a live
 * greeting. Unknown installations retain a grace window; known NATS firmware
 * keeps waiting through delayed starts. Sources never ingest concurrently. */
async function selectAndStartSource(expectedServer: WebSocketServer): Promise<void> {
  const override = process.env.PIEZO_SENSOR_SOURCE
  if (NATS_SOURCE_DISABLED || override === 'raw') {
    startRawTailingLoop()
    return
  }
  let discovery = override === 'nats' ? 'nats' : await discoverSensorSource()
  if (streamState.wss !== expectedServer) return
  const deadline = Date.now() + NATS_GRACE_MS
  for (;;) {
    if (streamState.wss !== expectedServer) return
    let reachable = false
    try {
      reachable = await natsReachable()
    }
    catch { /* An unsuccessful probe is not evidence of a different source. */ }
    if (streamState.wss !== expectedServer) return
    if (reachable) {
      if (await startNatsSource(expectedServer)) return
    }
    // A live greeting wins even if the installer evidence said RAW. Conversely,
    // a known NATS installation keeps retrying through delayed firmware starts.
    const remaining = deadline - Date.now()
    if (discovery === 'raw' || (discovery === 'unknown' && remaining <= 0)) break
    await new Promise(resolve => setTimeout(resolve,
      discovery === 'nats' ? NATS_PROBE_INTERVAL_MS : Math.min(NATS_PROBE_INTERVAL_MS, remaining)))
    // A busy boot can time out systemctl even on RAW firmware. Re-check the
    // installation while still undecided; never switch an active frame source.
    if (discovery === 'unknown' && streamState.wss === expectedServer) discovery = await discoverSensorSource()
  }
  if (streamState.wss !== expectedServer) return
  console.log('[sensorStream] selecting RAW source (%s installation)', discovery)
  startRawTailingLoop()
}

/** Connect the loopback-NATS source, feeding decoded frames into the shared dispatch. */
async function startNatsSource(expectedServer: WebSocketServer): Promise<boolean> {
  try {
    const source = await startNatsFrameSource({
      decode: decodeSensorFrames,
      onFrame: (frame) => { if (streamState.wss === expectedServer) dispatchSensorFrame(frame) },
      onReady: () => console.log('[sensorStream] NATS frame source active'),
      onClose: err => console.error('[sensorStream] NATS frame source closed', err ?? ''),
    })
    if (streamState.wss !== expectedServer) {
      // Server shut down while we were connecting — don't leak the connection.
      await source.stop()
      return true
    }
    streamState.natsSource = source
    recordSensorSource('nats')
    return true
  }
  catch (err) {
    console.error('[sensorStream] NATS connect failed; retrying source discovery:', err)
    return false
  }
}

/**
 * Fan one decoded sensor frame out to every downstream consumer: subscribed WS
 * clients, in-process server-side listeners (frzHealth), the live capSense
 * snapshot, and the cap-frame downsampler. Shared by both sources — the `.RAW`
 * tailer and the NATS subscription — so a NATS-only pod feeds the web stream,
 * `cap_sense_frames`, and `cap.*` signals exactly as a `.RAW` pod does. (The
 * tailer additionally maintains the seek index, which is file-offset-specific
 * and stays in its loop.)
 */
function dispatchSensorFrame(frame: Record<string, unknown>): void {
  recordFirstSensorFrame()
  const frameType = frame.type as string

  // New / out-of-scope firmware types (blanketReadings, …) pass through to
  // subscribers but are not ingested — log the first sight of each, once.
  if (!(ALL_SENSOR_TYPES as readonly string[]).includes(frameType)
    && !streamState.warnedUnknownTypes.has(frameType)) {
    streamState.warnedUnknownTypes.add(frameType)
    console.warn('[sensorStream] unknown sensor frame type "%s" — broadcasting but not ingesting', frameType)
  }

  // Broadcast to subscribed clients only. Pre-serialize once (avoid per-client
  // JSON.stringify), and only if at least one client needs it.
  const server = streamState.wss
  if (server) {
    let payload: string | null = null
    for (const client of server.clients) {
      if (client.readyState !== WebSocket.OPEN) continue
      const subs = streamState.clientSubscriptions.get(client)
      if (subs && !subs.has(frameType as SensorType)) continue
      if (payload === null) payload = JSON.stringify(frame)
      sendWithBackpressure(client, payload)
    }
  }

  // Notify server-side listeners (only frzHealth currently has consumers).
  if (frameType === 'frzHealth' && serverFrameListeners.size > 0) {
    for (const cb of serverFrameListeners) {
      try {
        cb(frame)
      }
      catch { /* consumer error */ }
    }
  }

  // Update the live capSense snapshot for in-process readers (virtual occupancy
  // sensor) and downsample into biometrics.db for replay. Firmware sends per-side
  // channels as {values:[...]} on Pod 4/5 and {out,cen,in} on Pod 3 — unwrap to a
  // flat array so both paths see real readings regardless of pod variant. The
  // NATS capSense dialect also tags each side with a `status`; feed it to the
  // downsampler for the statusCounts histogram (legacy .RAW frames carry none).
  if (frameType === 'capSense' || frameType === 'capSense2') {
    const ts = (frame as { ts: unknown }).ts
    const rawLeft = (frame as { left: unknown }).left
    const rawRight = (frame as { right: unknown }).right
    const left = capSideChannels(rawLeft)
    const right = capSideChannels(rawRight)
    if (typeof ts === 'number' && left && right) {
      streamState.latestCapSenseSnapshot = {
        type: frameType,
        ts,
        receivedAtMs: Date.now(),
        left,
        right,
      }
      recordCapFrame('left', left, ts, capSideStatus(rawLeft))
      recordCapFrame('right', right, ts, capSideStatus(rawRight))
    }
  }
}

/**
 * Periodic `.RAW` file-tailing loop: read new data from the newest RAW file and
 * dispatch decoded frames. Runs even with no clients connected — the cap-frame
 * downsampler must keep persisting through unattended nights so the next morning
 * can be replayed. Broadcasting is per-client guarded, so an idle loop does no
 * fan-out.
 */
function startRawTailingLoop(): void {
  if (streamState.streamingInterval) return
  const expectedServer = streamState.wss
  if (!expectedServer) return
  recordSensorSource('raw')
  let currentPath: string | null = null
  let handle: FileHandle | null = null
  let fileBuffer = Buffer.alloc(0)
  let readOffset = 0
  let nextScanAt = 0
  let needsMore = true
  let catchingUp = false
  let moreOnDisk = false
  let stopped = false
  let pending: Promise<void> | null = null
  const active = () => !stopped && streamState.wss === expectedServer
  const reset = () => {
    fileBuffer = Buffer.alloc(0)
    readOffset = 0
    needsMore = true
    moreOnDisk = false
    streamState.frameIndex.length = 0
    streamState.indexedFilePath = currentPath
    streamState.latestCapSenseSnapshot = null
    flushCapFrameWindows()
    resetCapFrameWindows()
  }
  const tick = async () => {
    catchingUp = false
    try {
      if (performance.now() >= nextScanAt) {
        const latest = await findLatestRawAsync(RAW_DATA_DIR)
        if (!active()) return
        nextScanAt = performance.now() + RAW_SCAN_INTERVAL_MS
        let replaced = false
        if (latest && latest === currentPath && handle) {
          const [openInfo, pathInfo] = await Promise.all([handle.stat(), fs.promises.stat(latest)])
          if (!active()) return
          replaced = openInfo.ino !== pathInfo.ino || openInfo.dev !== pathInfo.dev
        }
        if (latest && (latest !== currentPath || replaced)) {
          await handle?.close()
          handle = null
          currentPath = latest
          reset()
          console.log(`[sensorStream] Switched to RAW file: ${path.basename(latest)}`)
        }
      }
      if (!active() || !currentPath) return
      if (!handle) handle = await fs.promises.open(currentPath, 'r')
      if (!active()) return
      if (needsMore) {
        const info = await handle.stat()
        if (!active()) return
        if (info.size < readOffset) reset() // in-place truncation
        const length = Math.min(RAW_READ_BYTES, info.size - readOffset)
        if (length <= 0) return
        const bytes = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(bytes, 0, length, readOffset)
        if (!active()) return
        fileBuffer = Buffer.concat([fileBuffer, bytes.subarray(0, bytesRead)])
        readOffset += bytesRead
        moreOnDisk = info.size > readOffset
      }
      const baseOffset = readOffset - fileBuffer.length
      let pos = 0
      let records = 0
      const deadline = performance.now() + RAW_DECODE_BUDGET_MS
      needsMore = false
      while (pos < fileBuffer.length && records < RAW_RECORDS_PER_TICK && performance.now() < deadline) {
        records++
        const recordOffset = baseOffset + pos
        try {
          const { data, nextOffset } = readRawRecord(fileBuffer, pos)
          pos = nextOffset
          if (data === null) continue
          for (const frame of decodeSensorFrames(data)) {
            if (typeof frame.ts === 'number') appendFrameIndex({ ts: frame.ts, offset: recordOffset })
            dispatchSensorFrame(frame)
          }
        }
        catch (error) {
          if (error instanceof RangeError && fileBuffer.length - pos < RAW_MAX_BUFFER_BYTES) {
            needsMore = true
            break
          }
          // Bound memory even when a damaged CBOR length claims a huge record.
          const next = findNextRecordMarker(fileBuffer, pos + 1)
          pos = next < 0 ? fileBuffer.length : next
        }
      }
      if (pos > 0) fileBuffer = Buffer.from(fileBuffer.subarray(pos))
      if (fileBuffer.length === 0) needsMore = true
      catchingUp = !needsMore || moreOnDisk
      // If complete records remain, the next tick drains them before reading
      // more. This bounds allocation and leaves time for HTTP and DAC polling.
    }
    catch {
      await handle?.close().catch(() => {})
      handle = null
      nextScanAt = 0
    }
  }
  streamState.rawStop = async () => {
    stopped = true
    await pending
    await handle?.close().catch(() => {})
    handle = null
  }
  const schedule = () => {
    // Yield between backlog batches without paying the idle poll interval for
    // every chunk. A rotated file can otherwise take seconds to reach live data.
    streamState.streamingInterval = setTimeout(() => {
      if (!active()) return
      pending = tick().finally(() => {
        pending = null
        if (active()) schedule()
      })
    }, catchingUp ? 0 : FILE_POLL_INTERVAL_MS)
  }
  schedule()
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
 *
 * Also fans out to in-process server-side listeners (onServerFrame) for every
 * frame type. The MQTT bridge subscribes here to mirror deviceStatus frames
 * to HA without waiting on the 30 s timer; previously this path only fired
 * inside the file-decoder loop and was gated to frzHealth, so frames produced
 * by broadcastFrame() (deviceStatus, etc.) never reached server listeners.
 */
export function broadcastFrame(frame: Record<string, unknown>): void {
  if (serverFrameListeners.size > 0) {
    for (const cb of serverFrameListeners) {
      try {
        cb(frame)
      }
      catch { /* consumer error */ }
    }
  }

  const server = streamState.wss
  if (!server || server.clients.size === 0) return

  const frameType = frame.type as string
  let payload: string | null = null

  for (const client of server.clients) {
    if (client.readyState !== WebSocket.OPEN) continue

    const subs = streamState.clientSubscriptions.get(client)
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
  natsTiming,
  appendFrameIndex,
  cleanupClient,
  sendWithBackpressure,
  readRawRecord,
  findIndexEntry,
  int32BufferToArray,
  decodeSensorFrames,
  dispatchSensorFrame,
  warnedUnknownTypes: streamState.warnedUnknownTypes,
  get frameIndex(): readonly FrameIndexEntry[] { return streamState.frameIndex },
  get natsSourceActive(): boolean { return streamState.natsSource !== null },
  clientSubscriptions: streamState.clientSubscriptions,
  clientDroppedFrames: streamState.clientDroppedFrames,
  FRAME_INDEX_RETENTION_S,
  MAX_BUFFERED_BYTES,
  WS_MAX_PAYLOAD_BYTES,
  resetFrameIndex(): void { streamState.frameIndex.length = 0 },
}

/**
 * Gracefully shut down the WebSocket server.
 * Called during graceful shutdown in instrumentation.ts.
 */
export async function shutdownPiezoStreamServer(): Promise<void> {
  // Null streamState.wss first so any in-flight source selection / NATS connect aborts
  // instead of attaching to a server that's going away.
  const server = streamState.wss
  streamState.wss = null

  if (streamState.streamingInterval) {
    clearInterval(streamState.streamingInterval)
    streamState.streamingInterval = null
  }
  if (streamState.rawStop) {
    const stop = streamState.rawStop
    streamState.rawStop = null
    await stop()
  }
  if (streamState.natsSource) {
    const source = streamState.natsSource
    streamState.natsSource = null
    try {
      await source.stop()
    }
    catch { /* already closing */ }
  }
  flushCapFrameWindows()

  if (server) {
    // `server.close()` only fires its callback once every client has
    // disconnected; a still-open socket would hang shutdown forever. Drop
    // them eagerly so close always completes.
    for (const client of server.clients) {
      client.terminate()
    }
    return new Promise<void>((resolve) => {
      server.close(() => {
        // Drop per-client state explicitly — relying on per-socket close
        // events leaks if any handler failed to fire.
        streamState.clientSubscriptions.clear()
        streamState.clientDroppedFrames.clear()
        console.log('[sensorStream] WebSocket server closed')
        resolve()
      })
    })
  }
}

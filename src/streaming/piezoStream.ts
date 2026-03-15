/**
 * WebSocket server for streaming raw piezo sensor data to an iOS client.
 *
 * Runs on port 3001 (separate from the Next.js tRPC server on 3000).
 * Reads the newest `.RAW` file from the configured data directory using
 * manual CBOR byte parsing (the same `_read_raw_record` strategy used by
 * the Python piezo-processor sidecar — see modules/piezo-processor/main.py).
 *
 * Only one iOS client may be connected and processing at a time.
 *
 * Protocol:
 *   Client → Server:
 *     { type: "claim_processing" }   — claim processing ownership
 *     { type: "heartbeat" }          — keep-alive (must arrive within 30 s)
 *     { type: "release_processing" } — voluntarily release ownership
 *
 *   Server → Client:
 *     { type: "piezo-dual", ts, left1, right1, left2?, right2? }  — sensor frame
 *     { type: "error", message }     — error notification
 *     { type: "claimed", since }     — ack for claim_processing
 *     { type: "released" }           — ack for release / heartbeat timeout
 */

import { WebSocketServer, WebSocket } from 'ws'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Decoder } from 'cbor-x'
import { setIosProcessing } from './processingState'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WS_PORT = Number(process.env.PIEZO_WS_PORT ?? 3001)
const RAW_DATA_DIR = process.env.RAW_DATA_DIR ?? '/persistent'
const HEARTBEAT_TIMEOUT_MS = 30_000
const FILE_POLL_INTERVAL_MS = 10 // match Python's 10 ms poll for new data

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

  // seq value — uint32 (0x1a) or uint64 (0x1b)
  need(1)
  const seqHdr = buf[pos]
  pos += 1
  if (seqHdr === 0x1a) {
    need(4)
    pos += 4
  }
  else if (seqHdr === 0x1b) {
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
// Piezo frame decoder
// ---------------------------------------------------------------------------

const cborDecoder = new Decoder()

interface PiezoFrame {
  type: 'piezo-dual'
  ts: number
  left1: number[]
  right1: number[]
  left2?: number[]
  right2?: number[]
}

function decodePiezoFrame(innerBytes: Buffer): PiezoFrame | null {
  try {
    const inner = cborDecoder.decode(innerBytes)
    if (inner?.type !== 'piezo-dual') return null

    // Convert raw byte buffers (int32 arrays) to JS number arrays
    const toNumbers = (raw: Buffer | Uint8Array | undefined): number[] => {
      if (!raw || raw.length === 0) return []
      const view = new DataView(
        raw.buffer,
        raw.byteOffset,
        raw.byteLength
      )
      const nums: number[] = []
      for (let i = 0; i < raw.byteLength; i += 4) {
        nums.push(view.getInt32(i, true)) // little-endian int32
      }
      return nums
    }

    return {
      type: 'piezo-dual',
      ts: Date.now(),
      left1: toNumbers(inner.left1),
      right1: toNumbers(inner.right1),
      left2: inner.left2 ? toNumbers(inner.left2) : undefined,
      right2: inner.right2 ? toNumbers(inner.right2) : undefined,
    }
  }
  catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

let wss: WebSocketServer | null = null
let streamingInterval: ReturnType<typeof setInterval> | null = null

/** The single active processing client (if any). */
let activeClient: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

function resetHeartbeatTimer(): void {
  if (heartbeatTimer) clearTimeout(heartbeatTimer)
  heartbeatTimer = setTimeout(() => {
    console.warn('[piezoStream] iOS heartbeat timeout — releasing processing ownership')
    releaseClient()
  }, HEARTBEAT_TIMEOUT_MS)
}

function releaseClient(): void {
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer)
    heartbeatTimer = null
  }
  if (activeClient) {
    try {
      activeClient.send(JSON.stringify({ type: 'released' }))
    }
    catch { /* client may already be gone */ }
    activeClient = null
  }
  setIosProcessing(false)
}

function handleClientMessage(ws: WebSocket, raw: Buffer | string): void {
  try {
    const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'))

    if (msg.type === 'claim_processing') {
      if (activeClient && activeClient !== ws && activeClient.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: 'Another client is already processing' }))
        return
      }
      activeClient = ws
      setIosProcessing(true)
      resetHeartbeatTimer()
      ws.send(JSON.stringify({ type: 'claimed', since: Date.now() }))
      console.log('[piezoStream] iOS client claimed processing ownership')
    }
    else if (msg.type === 'heartbeat') {
      if (activeClient === ws) {
        resetHeartbeatTimer()
      }
    }
    else if (msg.type === 'release_processing') {
      if (activeClient === ws) {
        releaseClient()
        console.log('[piezoStream] iOS client voluntarily released processing')
      }
    }
  }
  catch {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }))
  }
}

/**
 * Start the piezo WebSocket streaming server.
 * Called from instrumentation.ts during server startup.
 */
export function startPiezoStreamServer(): WebSocketServer {
  if (wss) return wss

  wss = new WebSocketServer({ port: WS_PORT })
  console.log(`[piezoStream] WebSocket server listening on port ${WS_PORT}`)

  // State for file tailing
  let currentPath: string | null = null
  let fileBuffer = Buffer.alloc(0)
  let readOffset = 0 // offset into the actual file (not the buffer)

  wss.on('connection', (ws) => {
    console.log('[piezoStream] Client connected')

    ws.on('message', data => handleClientMessage(ws, data as Buffer | string))

    ws.on('close', () => {
      console.log('[piezoStream] Client disconnected')
      if (activeClient === ws) {
        releaseClient()
      }
    })

    ws.on('error', (err) => {
      console.error('[piezoStream] WebSocket error:', err.message)
      if (activeClient === ws) {
        releaseClient()
      }
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
      console.log(`[piezoStream] Switched to RAW file: ${path.basename(latest)}`)
      currentPath = latest
      fileBuffer = Buffer.alloc(0)
      readOffset = 0
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

      fileBuffer = Buffer.concat([fileBuffer, newBytes])
      readOffset = fileSize

      // Parse as many complete records as possible
      let bufferPos = 0
      while (bufferPos < fileBuffer.length) {
        try {
          const { data, nextOffset } = readRawRecord(fileBuffer, bufferPos)
          bufferPos = nextOffset

          if (data === null) continue // empty placeholder

          const frame = decodePiezoFrame(data)
          if (!frame) continue

          const payload = JSON.stringify(frame)

          const server = wss
          if (server) {
            for (const client of server.clients) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(payload)
              }
            }
          }
        }
        catch (e) {
          if (e instanceof RangeError) {
            break // incomplete record — wait for more data
          }
          // Malformed record — skip forward one byte and try to resync
          console.warn('[piezoStream] Skipping malformed record:', (e as Error).message)
          bufferPos += 1
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

/**
 * Gracefully shut down the WebSocket server.
 * Called during graceful shutdown in instrumentation.ts.
 */
export async function shutdownPiezoStreamServer(): Promise<void> {
  if (streamingInterval) {
    clearInterval(streamingInterval)
    streamingInterval = null
  }

  releaseClient()

  const server = wss
  if (server) {
    wss = null
    return new Promise<void>((resolve) => {
      server.close(() => {
        console.log('[piezoStream] WebSocket server closed')
        resolve()
      })
    })
  }
}

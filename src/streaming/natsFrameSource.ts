/**
 * NATS sensor-frame source — the loopback-NATS counterpart to the `.RAW` file
 * tailer in `piezoStream.ts`.
 *
 * New Pod 5 firmware (~April 2026+) stops writing CBOR `*.RAW` spool files and
 * instead publishes one complete CBOR map per sensor reading to a local NATS
 * server (`nats://127.0.0.1:4222`, JetStream-enabled, no auth on loopback). On
 * those pods the file tailer finds nothing, so the WS live stream, the
 * `latestCapSenseSnapshot`, `cap_sense_frames`, and the `cap.*` automation
 * signals all stay empty. This module is the second `.RAW` consumer: it
 * subscribes to the firmware's `raw.sens.>` / `raw.frz.>` subjects, decodes each
 * message through the SAME decode path the tailer uses, and hands the decoded
 * frame back to `piezoStream` so every downstream consumer is fed identically.
 *
 * The `.RAW` path is never touched — this source is *added alongside* and
 * selected at runtime (see the reachability probe below and the source
 * selection in `piezoStream.startPiezoStreamServer`).
 *
 * Design: docs/nats-frame-readers.md (rollout item 1a — the Node streaming side).
 */

import * as net from 'node:net'
// Type-only import: the runtime client is loaded lazily in `connectNats` so pods
// and tests that never select NATS don't pull in the transport.
import type { NatsConnection, Subscription } from '@nats-io/transport-node'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NATS_HOST = process.env.PIEZO_NATS_HOST ?? '127.0.0.1'
const NATS_PORT = Number(process.env.PIEZO_NATS_PORT ?? 4222)

/**
 * Subjects the firmware publishes sensor frames on. `raw.log` is intentionally
 * excluded — its payload is multiple concatenated CBOR maps (unlike the single
 * map every sensor subject carries) and it has no live consumer; sp-status reads
 * it as a JetStream point-fetch instead.
 */
export const SUBSCRIBE_SUBJECTS = ['raw.sens.>', 'raw.frz.>'] as const

// Never give up reconnecting. On a NATS-only pod there is no `.RAW` file to fall
// back to, so a dropped connection must self-heal rather than strand the stream;
// the firmware republishes live frames on reconnect. (This is the deliberate
// difference from the Python follower, whose dedicated process exits and
// re-probes on failure — the Node process is the shared web server and must not
// exit just because NATS blipped.)
const MAX_RECONNECT_ATTEMPTS = -1
const RECONNECT_TIME_WAIT_MS = 2_000
const PROBE_TIMEOUT_MS = 2_000
const PROBE_MAX_GREETING_BYTES = 16 * 1024
// A live pod ticks capSense at 2 Hz, so a subscription silent this long past
// startup is worth surfacing once — a health signal, not a source-selection input.
const SILENCE_WARN_MS = 60_000

// ---------------------------------------------------------------------------
// Reachability probe (layer 2 — cheap runtime reachability)
// ---------------------------------------------------------------------------

/**
 * True when a real NATS server is listening: it greets every new TCP connection
 * with an `INFO {...}` line *before* the client sends anything. Checking for that
 * greeting distinguishes NATS from a random open port at ~zero cost, and mirrors
 * the Python `nats_reachable` probe so both sources select identically.
 */
export function natsReachable(
  opts: { host?: string, port?: number, timeoutMs?: number } = {},
): Promise<boolean> {
  const host = opts.host ?? NATS_HOST
  const port = opts.port ?? NATS_PORT
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS

  return new Promise<boolean>((resolve) => {
    let settled = false
    let greeting = Buffer.alloc(0)
    const socket = new net.Socket()
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.on('data', (chunk: Buffer) => {
      if (greeting.length + chunk.length > PROBE_MAX_GREETING_BYTES) {
        finish(false)
        return
      }

      greeting = Buffer.concat([greeting, chunk])
      if (greeting.length >= 5 && greeting.toString('latin1', 0, 5) !== 'INFO ') {
        finish(false)
        return
      }

      // TCP may split the INFO control line across any number of packets.
      // Wait for its newline rather than treating the first data event as the
      // complete greeting.
      if (greeting.indexOf(0x0A) !== -1) finish(true)
    })
    socket.once('timeout', () => finish(false)) // connected but silent ⇒ not NATS
    socket.once('error', () => finish(false)) // refused / unreachable
    socket.once('end', () => finish(false)) // clean EOF before a complete INFO line
    socket.once('close', () => finish(false))
    socket.connect({ host, port })
  })
}

// ---------------------------------------------------------------------------
// Frame source
// ---------------------------------------------------------------------------

export interface NatsFrameSourceStats {
  /** Messages received across all subscribed subjects. */
  messages: number
  /** Frames yielded by the decoder (a message may carry >1 for future subjects). */
  framesDecoded: number
  /** Messages whose payload decoded to zero frames (malformed / typeless). */
  decodeFailures: number
}

export interface NatsFrameSourceOptions {
  /**
   * Decode one CBOR message payload into zero or more sensor frames. Injected so
   * this module reuses `piezoStream`'s exact decode path (incl. the piezo-dual
   * int32 conversion) without a circular import. Must not throw.
   */
  decode: (payload: Buffer) => Record<string, unknown>[]
  /** Invoked once per decoded frame — broadcast + persistence live in the caller. */
  onFrame: (frame: Record<string, unknown>) => void
  /** Invoked once the subscriptions are live (first successful connect). */
  onReady?: () => void
  /**
   * Invoked if the connection closes permanently (should not happen under the
   * infinite-reconnect policy, but surfaces an unrecoverable error if it does).
   */
  onClose?: (err?: Error) => void
  host?: string
  port?: number
}

export interface NatsFrameSourceHandle {
  /** Drain subscriptions and close the connection. Idempotent. */
  stop: () => Promise<void>
  readonly stats: NatsFrameSourceStats
}

// Resolve the transport lazily on first use so pods/tests that never select
// NATS don't load it; `vi.mock('@nats-io/transport-node')` intercepts this.
async function connectNats(host: string, port: number): Promise<NatsConnection> {
  const { connect } = await import('@nats-io/transport-node')
  return connect({
    servers: `${host}:${port}`,
    name: 'sleepypod-sensor-stream',
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    reconnectTimeWait: RECONNECT_TIME_WAIT_MS,
    // Bounds the very first handshake so a wedged server can't hang startup;
    // the reachability probe already gated us here so this rarely bites.
    waitOnFirstConnect: true,
  })
}

/**
 * Connect to loopback NATS, subscribe to the sensor subjects, and pump every
 * decoded frame into `onFrame`. Resolves once the subscriptions are established.
 */
export async function startNatsFrameSource(
  opts: NatsFrameSourceOptions,
): Promise<NatsFrameSourceHandle> {
  const host = opts.host ?? NATS_HOST
  const port = opts.port ?? NATS_PORT
  const stats: NatsFrameSourceStats = { messages: 0, framesDecoded: 0, decodeFailures: 0 }

  let stopped = false
  let loggedDecodeFailure = false

  const nc = await connectNats(host, port)
  console.log('[natsSource] connected to NATS at %s:%d — subscribing %s',
    host, port, SUBSCRIBE_SUBJECTS.join(', '))

  const handleMessage = (err: Error | null, data: Uint8Array): void => {
    if (err) {
      // Per-subscription errors (e.g. permission) — surface, keep the others live.
      console.warn('[natsSource] subscription error:', err.message)
      return
    }
    stats.messages += 1
    // View, not copy — cbor-x reads a Uint8Array/Buffer directly.
    const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    let frames: Record<string, unknown>[] = []
    try {
      frames = opts.decode(payload)
    }
    catch {
      frames = []
    }
    if (frames.length === 0) {
      stats.decodeFailures += 1
      if (!loggedDecodeFailure) {
        loggedDecodeFailure = true
        console.warn('[natsSource] dropped a message that decoded to no frames (%d bytes)',
          payload.length)
      }
      return
    }
    for (const frame of frames) {
      stats.framesDecoded += 1
      try {
        opts.onFrame(frame)
      }
      catch { /* a single consumer error must not drop the subscription */ }
    }
  }

  const subs: Subscription[] = SUBSCRIBE_SUBJECTS.map(subject =>
    nc.subscribe(subject, { callback: (err, msg) => handleMessage(err, msg.data) }))

  // Surface a persistently silent subscription once (health signal only).
  const silenceTimer = setTimeout(() => {
    if (!stopped && stats.messages === 0) {
      console.warn('[natsSource] no frames received %ds after subscribing — sensor idle or firmware not publishing',
        Math.round(SILENCE_WARN_MS / 1000))
    }
  }, SILENCE_WARN_MS)
  // Don't let the health timer hold the process open on its own.
  if (typeof silenceTimer.unref === 'function') silenceTimer.unref()

  // Log connection transitions for field debugging — auto-reconnect handles the
  // recovery; this just makes the journal say what happened.
  void (async () => {
    try {
      for await (const status of nc.status()) {
        if (status.type === 'disconnect') {
          console.warn('[natsSource] disconnected from NATS — reconnecting')
        }
        else if (status.type === 'reconnect') {
          console.log('[natsSource] reconnected to NATS')
        }
      }
    }
    catch { /* status iterator ends when the connection closes */ }
  })()

  // Permanent close: with infinite reconnect this only fires on stop() or an
  // unrecoverable error. Report but never exit — the web server stays up.
  void nc.closed().then((err) => {
    if (stopped) return
    console.error('[natsSource] NATS connection closed permanently', err ?? '')
    opts.onClose?.(err instanceof Error ? err : undefined)
  })

  opts.onReady?.()

  return {
    stats,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      clearTimeout(silenceTimer)
      try {
        for (const sub of subs) sub.unsubscribe()
        await nc.drain()
      }
      catch { /* already closing */ }
    },
  }
}

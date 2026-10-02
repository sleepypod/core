/**
 * One stream of tap gestures from two sources.
 *
 * - Status polling (DacMonitor): tap fields in DEVICE_STATUS. Some firmware
 *   leaves out a tap that stops a vibrating alarm (it handles "tap to
 *   dismiss" itself), so a snooze gesture never shows up there.
 * - The sensor stream: firmware that has them writes a `tap-gesture` record
 *   ({side, taps, ts}) for every tap, alarm or not.
 *
 * Once the stream has delivered a tap it is the only source (status taps are
 * then redundant, and incomplete). Before that, a tap reported by both — the
 * status field holds the same firmware time as the record — is handled once.
 */
import type { GestureEvent } from './dacMonitor'

const TAP_TYPES = { 2: 'doubleTap', 3: 'tripleTap', 4: 'quadTap' } as const

/**
 * The sensor stream re-reads the current RAW file from its start after a
 * restart or rotation, replaying up to its full length of old records; a tap
 * older than this is history, not a gesture to act on.
 */
export const TAP_RECORD_MAX_AGE_S = 30

/** How long a handled tap's identity is remembered for de-duplication. */
const SEEN_TTL_MS = 5 * 60 * 1000

/** The gesture a `tap-gesture` sensor frame describes, or null. */
export function tapGestureEvent(frame: Record<string, unknown>, nowMs = Date.now()): GestureEvent | null {
  if (frame.type !== 'tap-gesture') return null
  const side = frame.side
  const taps = frame.taps
  const ts = frame.ts
  if ((side !== 'left' && side !== 'right') || typeof ts !== 'number') return null
  const tapType = TAP_TYPES[taps as keyof typeof TAP_TYPES]
  if (!tapType) return null
  if (Math.abs(nowMs / 1000 - ts) > TAP_RECORD_MAX_AGE_S) return null
  return { side, tapType, timestamp: new Date(ts * 1000), firmwareTime: ts }
}

export class GestureDispatcher {
  private streamSeen = false
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly deliver: (event: GestureEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** A tap detected from status polling. */
  fromStatus = (event: GestureEvent): void => {
    if (this.streamSeen) return
    this.deliverOnce(event)
  }

  /** A tap from a `tap-gesture` sensor record. */
  fromStream = (event: GestureEvent): void => {
    this.streamSeen = true
    this.deliverOnce(event)
  }

  private deliverOnce(event: GestureEvent): void {
    const now = this.now()
    for (const [key, at] of this.seen) {
      if (now - at > SEEN_TTL_MS) this.seen.delete(key)
    }
    if (event.firmwareTime != null) {
      const key = `${event.side}:${event.tapType}:${event.firmwareTime}`
      if (this.seen.has(key)) return
      this.seen.set(key, now)
    }
    this.deliver(event)
  }
}

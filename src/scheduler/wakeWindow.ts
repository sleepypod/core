/**
 * Wake window — an alarm with `wakeWindow` minutes set fires early, the first
 * time its side moves within that many minutes before the set time. The set
 * time is the latest it fires: with no movement it fires then as usual.
 *
 * Movement comes from the sleep-detector's per-minute `movement` rows, so an
 * early fire lands within about a minute of the movement. The detector only
 * writes rows while it holds a session open for an occupied side, so an empty
 * bed never trips it.
 */

import { and, eq, gte, max } from 'drizzle-orm'
import { biometricsDb } from '@/src/db'
import { movement } from '@/src/db/biometrics-schema'

type Side = 'left' | 'right'

/**
 * Per-minute movement score (0–1000) that counts as moving. Lying still scores
 * under ~50 and a small shift ~100–200; turning over or getting up runs into
 * the hundreds.
 */
export const WAKE_MOVEMENT_THRESHOLD = 300

/** How often an open window re-reads movement. Rows land once a minute. */
export const WAKE_POLL_MS = 20_000

/**
 * The set-time job treats the alarm as already fired when an early fire
 * pre-empted an occurrence due within this much of now.
 */
const PREEMPT_MATCH_MS = 5 * 60_000

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
export type DayOfWeek = typeof DAYS[number]

/**
 * The weekly slot `minutesBefore` ahead of day/hour/minute, wrapping across
 * midnight and the week (a 06:10 Monday alarm with a 20 minute window opens
 * at 05:50 Monday; a 00:10 Monday one opens at 23:50 Sunday).
 */
export function slotBefore(dayOfWeek: DayOfWeek, hour: number, minute: number, minutesBefore: number): { dayOfWeek: DayOfWeek, hour: number, minute: number } {
  const week = 7 * 24 * 60
  const at = (((DAYS.indexOf(dayOfWeek) * 24 * 60 + hour * 60 + minute - minutesBefore) % week) + week) % week
  return {
    dayOfWeek: DAYS[Math.floor(at / (24 * 60))],
    hour: Math.floor((at % (24 * 60)) / 60),
    minute: at % 60,
  }
}

/** Highest movement score written for `side` at or after `since`, or null when none. */
export function peakMovementSince(side: Side, since: Date): number | null {
  const [row] = biometricsDb
    .select({ peak: max(movement.totalMovement) })
    .from(movement)
    .where(and(eq(movement.side, side), gte(movement.timestamp, since)))
    .all()
  return row?.peak ?? null
}

interface Watch {
  timer: ReturnType<typeof setInterval>
  alarmAt: number
}

interface WakeWindowsOptions {
  readMovement?: (side: Side, since: Date) => number | null
  now?: () => number
  pollMs?: number
}

/**
 * The open wake windows, one per alarm schedule row. `open` starts polling
 * movement until the alarm time; the first reading at or over the threshold
 * fires the alarm and records that occurrence so the set-time job skips it.
 */
export class WakeWindows {
  private watches = new Map<number, Watch>()
  private firedEarly = new Map<number, number>()
  private readonly readMovement: (side: Side, since: Date) => number | null
  private readonly now: () => number
  private readonly pollMs: number

  constructor(options: WakeWindowsOptions = {}) {
    this.readMovement = options.readMovement ?? peakMovementSince
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? WAKE_POLL_MS
  }

  /**
   * Watch `side` for movement from `windowMinutes` before `alarmAt` until
   * `alarmAt`, calling `fire` on the first movement. Reopening replaces the
   * watch (a reload or edit brings new settings); an occurrence that already
   * fired early is not watched again.
   */
  open(scheduleId: number, side: Side, alarmAt: Date, windowMinutes: number, fire: () => Promise<void>): void {
    this.close(scheduleId)
    const due = alarmAt.getTime()
    if (this.firedEarly.get(scheduleId) === due || this.now() >= due) return
    const since = new Date(due - windowMinutes * 60_000)

    const check = async (): Promise<void> => {
      if (this.watches.get(scheduleId) !== watch) return
      if (this.now() >= due) {
        this.close(scheduleId)
        return
      }
      let peak: number | null
      try {
        peak = this.readMovement(side, since)
      }
      catch (error) {
        console.warn(`[wakeWindow] alarm-${scheduleId}: movement read failed:`, error instanceof Error ? error.message : error)
        return
      }
      if (peak == null || peak < WAKE_MOVEMENT_THRESHOLD) return
      this.close(scheduleId)
      this.firedEarly.set(scheduleId, due)
      console.log(`[wakeWindow] alarm-${scheduleId}: ${side} moved (${peak}) ${Math.round((due - this.now()) / 60_000)} min before the alarm — firing now`)
      try {
        await fire()
      }
      catch (error) {
        // Leave the set-time job to fire it.
        this.firedEarly.delete(scheduleId)
        console.error(`[wakeWindow] alarm-${scheduleId}: early fire failed:`, error instanceof Error ? error.message : error)
      }
    }

    const watch: Watch = { timer: setInterval(() => void check(), this.pollMs), alarmAt: due }
    watch.timer.unref?.()
    this.watches.set(scheduleId, watch)
    void check()
  }

  /** Stop watching `scheduleId` (a pre-empted occurrence stays recorded). */
  close(scheduleId: number): void {
    const watch = this.watches.get(scheduleId)
    if (!watch) return
    clearInterval(watch.timer)
    this.watches.delete(scheduleId)
  }

  closeAll(): void {
    for (const id of [...this.watches.keys()]) this.close(id)
  }

  /**
   * Called by the set-time job: stops any watch and reports whether this
   * occurrence already fired early (consuming that record).
   */
  claim(scheduleId: number): boolean {
    this.close(scheduleId)
    const due = this.firedEarly.get(scheduleId)
    if (due == null) return false
    this.firedEarly.delete(scheduleId)
    return Math.abs(due - this.now()) <= PREEMPT_MATCH_MS
  }

  isOpen(scheduleId: number): boolean {
    return this.watches.has(scheduleId)
  }
}

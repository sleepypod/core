/**
 * Wake window — an alarm with `wakeWindow` minutes set fires early once its
 * side turns restless within that many minutes before the set time. The set
 * time is the latest it fires: without restlessness it fires then as usual.
 *
 * Movement comes from the sleep-detector's per-minute `movement` rows. A
 * single turn-over in deep sleep scores as high as getting up, and sleepers
 * turn over every few minutes, so one moving minute fires nearly every window
 * as soon as it opens. Restless means moving in WAKE_RESTLESS_MINUTES of any
 * WAKE_RESTLESS_SPAN_MINUTES in a row: in recorded nights a sleeper did that in
 * about 2% of 20-minute stretches, while someone waking on their own did it
 * several minutes before getting up. The detector only writes rows while it holds a session open for
 * an occupied side, so an empty bed never trips it.
 */

import { and, asc, eq, gte } from 'drizzle-orm'
import { biometricsDb } from '@/src/db'
import { movement } from '@/src/db/biometrics-schema'

type Side = 'left' | 'right'

/**
 * Per-minute movement score (0–1000) that counts as moving. Lying still scores
 * under ~50 and a small shift ~100–200; turning over or getting up runs into
 * the hundreds.
 */
export const WAKE_MOVEMENT_THRESHOLD = 300

/** Moving minutes, within WAKE_RESTLESS_SPAN_MINUTES, that count as waking. */
export const WAKE_RESTLESS_MINUTES = 4

/** The span, in minutes, the moving minutes must fall within. */
export const WAKE_RESTLESS_SPAN_MINUTES = 8

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

export interface MovementMinute {
  /** Unix seconds. */
  timestamp: number
  score: number
}

/** Movement rows written for `side` at or after `since`, oldest first. */
export function movementSince(side: Side, since: Date): MovementMinute[] {
  return biometricsDb
    .select({ timestamp: movement.timestamp, score: movement.totalMovement })
    .from(movement)
    .where(and(eq(movement.side, side), gte(movement.timestamp, since)))
    .orderBy(asc(movement.timestamp))
    .all()
    .map(row => ({ timestamp: Math.floor(row.timestamp.getTime() / 1000), score: row.score }))
}

/**
 * Whether `rows` hold WAKE_RESTLESS_MINUTES moving minutes within some
 * WAKE_RESTLESS_SPAN_MINUTES, going by timestamps so a missing minute
 * counts as still. Returns the span's moving scores, or null.
 */
export function restlessSpan(rows: MovementMinute[]): number[] | null {
  const moving = rows.filter(row => row.score >= WAKE_MOVEMENT_THRESHOLD)
  const span = WAKE_RESTLESS_SPAN_MINUTES * 60
  for (let end = WAKE_RESTLESS_MINUTES - 1; end < moving.length; end++) {
    const start = end - (WAKE_RESTLESS_MINUTES - 1)
    if (moving[end].timestamp - moving[start].timestamp < span) {
      return moving.slice(start, end + 1).map(row => row.score)
    }
  }
  return null
}

interface Watch {
  timer: ReturnType<typeof setInterval>
  alarmAt: number
}

interface WakeWindowsOptions {
  readMovement?: (side: Side, since: Date) => MovementMinute[]
  now?: () => number
  pollMs?: number
}

/**
 * The open wake windows, one per alarm schedule row. `open` starts polling
 * movement until the alarm time; the first restless span fires the alarm and
 * records that occurrence so the set-time job skips it.
 */
export class WakeWindows {
  private watches = new Map<number, Watch>()
  private firedEarly = new Map<number, number>()
  private readonly readMovement: (side: Side, since: Date) => MovementMinute[]
  private readonly now: () => number
  private readonly pollMs: number

  constructor(options: WakeWindowsOptions = {}) {
    this.readMovement = options.readMovement ?? movementSince
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? WAKE_POLL_MS
  }

  /**
   * Watch `side` for movement from `windowMinutes` before `alarmAt` until
   * `alarmAt`, calling `fire` once the side turns restless. Reopening replaces the
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
      let rows: MovementMinute[]
      try {
        rows = this.readMovement(side, since)
      }
      catch (error) {
        console.warn(`[wakeWindow] alarm-${scheduleId}: movement read failed:`, error instanceof Error ? error.message : error)
        return
      }
      const restless = restlessSpan(rows)
      if (!restless) return
      this.close(scheduleId)
      this.firedEarly.set(scheduleId, due)
      console.log(`[wakeWindow] alarm-${scheduleId}: ${side} restless (${restless.join(', ')}) ${Math.round((due - this.now()) / 60_000)} min before the alarm — firing now`)
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

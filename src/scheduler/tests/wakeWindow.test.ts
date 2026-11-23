import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbRows = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('@/src/db', () => {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.from = () => chain
  chain.where = () => chain
  chain.orderBy = () => chain
  chain.all = () => dbRows.rows
  return { biometricsDb: chain }
})

import { WAKE_MOVEMENT_THRESHOLD, WakeWindows, movementSince, restlessSpan, slotBefore } from '../wakeWindow'
import type { MovementMinute } from '../wakeWindow'

const MIN = 60_000
const T0 = Date.UTC(2026, 8, 30, 10, 55) / 1000

/** One row per score, a minute apart from T0. */
const minutes = (...scores: number[]): MovementMinute[] =>
  scores.map((score, i) => ({ timestamp: T0 + i * 60, score }))

/** Restless: four moving minutes in a row. */
const RESTLESS = minutes(800, 800, 800, 800)

describe('slotBefore', () => {
  it('moves back within the same day', () => {
    expect(slotBefore('monday', 7, 15, 20)).toEqual({ dayOfWeek: 'monday', hour: 6, minute: 55 })
    expect(slotBefore('friday', 6, 30, 30)).toEqual({ dayOfWeek: 'friday', hour: 6, minute: 0 })
  })

  it('crosses midnight into the previous day', () => {
    expect(slotBefore('monday', 0, 10, 20)).toEqual({ dayOfWeek: 'sunday', hour: 23, minute: 50 })
  })

  it('wraps Sunday back to Saturday', () => {
    expect(slotBefore('sunday', 0, 5, 10)).toEqual({ dayOfWeek: 'saturday', hour: 23, minute: 55 })
  })

  it('is the same slot for a zero offset', () => {
    expect(slotBefore('wednesday', 12, 0, 0)).toEqual({ dayOfWeek: 'wednesday', hour: 12, minute: 0 })
  })
})

describe('movementSince', () => {
  it('returns the rows as unix seconds and scores', () => {
    dbRows.rows = [
      { timestamp: new Date(T0 * 1000), score: 420 },
      { timestamp: new Date((T0 + 60) * 1000 + 999), score: 0 },
    ]
    expect(movementSince('left', new Date())).toEqual([
      { timestamp: T0, score: 420 },
      { timestamp: T0 + 60, score: 0 },
    ])
    dbRows.rows = []
    expect(movementSince('left', new Date())).toEqual([])
  })
})

describe('restlessSpan', () => {
  const T = WAKE_MOVEMENT_THRESHOLD

  it('is null with no rows or only still minutes', () => {
    expect(restlessSpan([])).toBeNull()
    expect(restlessSpan(minutes(0, T - 1, 0, T - 1, T - 1))).toBeNull()
  })

  it('ignores a lone turn-over, however large', () => {
    expect(restlessSpan(minutes(1000, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 1000))).toBeNull()
  })

  it('ignores three moving minutes in eight', () => {
    expect(restlessSpan(minutes(1000, 1000, 0, 0, 0, 0, 0, 1000))).toBeNull()
  })

  it('fires on four moving minutes within eight, from the threshold up', () => {
    expect(restlessSpan(minutes(T, 0, 500, 0, 1000, 0, 0, 600))).toEqual([T, 500, 1000, 600])
    expect(restlessSpan(minutes(0, T, T, T, T))).toEqual([T, T, T, T])
  })

  it('does not count moving minutes spread over nine', () => {
    expect(restlessSpan(minutes(800, 0, 800, 0, 800, 0, 0, 0, 800))).toBeNull()
  })

  it('treats a missing minute as still', () => {
    const rows = [
      { timestamp: T0, score: 800 },
      { timestamp: T0 + 60, score: 800 },
      { timestamp: T0 + 120, score: 800 },
      { timestamp: T0 + 480, score: 800 },
    ]
    expect(restlessSpan(rows)).toBeNull()
    expect(restlessSpan([...rows.slice(0, 3), { timestamp: T0 + 479, score: 800 }])).toEqual([800, 800, 800, 800])
  })

  it('finds a later span after scattered movement', () => {
    expect(restlessSpan(minutes(1000, 0, 0, 0, 0, 0, 0, 0, 900, 0, 0, 0, 0, 0, 0, 0, 400, 0, 600, 700, 0, 300))).toEqual([400, 600, 700, 300])
  })
})

describe('WakeWindows', () => {
  let now: number
  let rows: MovementMinute[]
  let reads: Array<{ side: string, since: Date }>
  let windows: WakeWindows
  const fire = vi.fn(async () => {})

  beforeEach(() => {
    vi.useFakeTimers()
    now = Date.UTC(2026, 8, 30, 10, 55)
    rows = []
    reads = []
    fire.mockClear()
    windows = new WakeWindows({
      readMovement: (side, since) => {
        reads.push({ side, since })
        return rows
      },
      now: () => now,
      pollMs: 1000,
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    windows.closeAll()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const alarmAt = () => new Date(Date.UTC(2026, 8, 30, 11, 15))

  it('reads movement from the start of the window, for the alarm side', async () => {
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(0)
    expect(reads[0]).toEqual({ side: 'left', since: new Date(alarmAt().getTime() - 20 * MIN) })
  })

  it('does not fire on a lone turn-over or movement under the threshold', async () => {
    rows = minutes(1000, WAKE_MOVEMENT_THRESHOLD - 1, WAKE_MOVEMENT_THRESHOLD - 1, 0, 1000)
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fire).not.toHaveBeenCalled()
    expect(windows.isOpen(1)).toBe(true)
    expect(reads.length).toBeGreaterThan(3)
  })

  it('fires once when the side turns restless and closes', async () => {
    rows = minutes(1000, 0, 1000, 0, 1000)
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fire).not.toHaveBeenCalled()
    rows = minutes(1000, 0, 1000, 0, 1000, WAKE_MOVEMENT_THRESHOLD)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fire).toHaveBeenCalledTimes(1)
    expect(windows.isOpen(1)).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('lets the set-time job skip an occurrence that fired early, once', async () => {
    rows = RESTLESS
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(0)
    expect(fire).toHaveBeenCalledTimes(1)
    now = alarmAt().getTime()
    expect(windows.claim(1)).toBe(true)
    expect(windows.claim(1)).toBe(false)
  })

  it('does not skip an occurrence that fired early long ago', async () => {
    rows = RESTLESS
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(0)
    now = alarmAt().getTime() + 7 * 24 * 60 * MIN
    expect(windows.claim(1)).toBe(false)
  })

  it('claim without an early fire stops the watch and lets the alarm run', async () => {
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(0)
    now = alarmAt().getTime()
    expect(windows.claim(1)).toBe(false)
    expect(windows.isOpen(1)).toBe(false)
  })

  it('does not reopen an occurrence that already fired early', async () => {
    rows = RESTLESS
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(0)
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fire).toHaveBeenCalledTimes(1)
    expect(windows.isOpen(1)).toBe(false)
  })

  it('stops at the alarm time without firing', async () => {
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(0)
    now = alarmAt().getTime()
    rows = RESTLESS
    await vi.advanceTimersByTimeAsync(1000)
    expect(fire).not.toHaveBeenCalled()
    expect(windows.isOpen(1)).toBe(false)
  })

  it('ignores an alarm time already past', async () => {
    now = alarmAt().getTime() + MIN
    windows.open(1, 'left', alarmAt(), 20, fire)
    expect(windows.isOpen(1)).toBe(false)
  })

  it('reopening replaces the watch with the new settings', async () => {
    windows.open(1, 'left', alarmAt(), 20, fire)
    const other = vi.fn(async () => {})
    windows.open(1, 'right', alarmAt(), 10, other)
    rows = RESTLESS
    await vi.advanceTimersByTimeAsync(1000)
    expect(fire).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalledTimes(1)
    expect(reads.at(-1)).toEqual({ side: 'right', since: new Date(alarmAt().getTime() - 10 * MIN) })
  })

  it('close and closeAll stop polling', async () => {
    windows.open(1, 'left', alarmAt(), 20, fire)
    windows.open(2, 'right', alarmAt(), 20, fire)
    windows.close(1)
    expect(windows.isOpen(1)).toBe(false)
    expect(windows.isOpen(2)).toBe(true)
    windows.closeAll()
    rows = RESTLESS
    await vi.advanceTimersByTimeAsync(3000)
    expect(fire).not.toHaveBeenCalled()
  })

  it('ignores an already queued poll from a replaced watch', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval')
    windows.open(1, 'left', alarmAt(), 20, fire)
    const stalePoll = intervals.mock.calls[0][0] as () => void
    const replacement = vi.fn(async () => {})
    windows.open(1, 'right', alarmAt(), 10, replacement)
    reads.length = 0
    rows = RESTLESS
    stalePoll()
    expect(reads).toEqual([])
    expect(fire).not.toHaveBeenCalled()
    expect(windows.isOpen(1)).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(fire).not.toHaveBeenCalled()
  })

  it('keeps polling after a non-Error movement failure', async () => {
    const failure = { code: 'SQLITE_BUSY' }
    const readMovement = vi.fn().mockImplementationOnce(() => {
      throw failure
    }).mockReturnValue(RESTLESS)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    windows = new WakeWindows({ readMovement, now: () => now, pollMs: 1000 })
    windows.open(1, 'left', alarmAt(), 20, fire)
    expect(warn).toHaveBeenCalledExactlyOnceWith('[wakeWindow] alarm-1: movement read failed:', failure)
    expect(windows.isOpen(1)).toBe(true)
    expect(fire).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fire).toHaveBeenCalledTimes(1)
    expect(windows.isOpen(1)).toBe(false)
  })

  it('allows the set-time alarm after a non-Error early-fire failure', async () => {
    const failure = { code: 'DAC_DISCONNECTED' }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    rows = RESTLESS
    windows.open(1, 'left', alarmAt(), 20, vi.fn().mockRejectedValue(failure))
    await vi.advanceTimersByTimeAsync(0)
    expect(error).toHaveBeenCalledExactlyOnceWith('[wakeWindow] alarm-1: early fire failed:', failure)
    expect(windows.isOpen(1)).toBe(false)
    now = alarmAt().getTime()
    expect(windows.claim(1)).toBe(false)
  })

  it('keeps watching after a failed movement read', async () => {
    let fail = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    windows = new WakeWindows({
      readMovement: () => {
        if (fail) throw new Error('db busy')
        return RESTLESS
      },
      now: () => now,
      pollMs: 1000,
    })
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalled()
    expect(fire).not.toHaveBeenCalled()
    fail = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('leaves a failed early fire to the set-time job', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    rows = RESTLESS
    windows.open(1, 'left', alarmAt(), 20, async () => {
      throw new Error('hardware down')
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(err).toHaveBeenCalled()
    now = alarmAt().getTime()
    expect(windows.claim(1)).toBe(false)
  })
})

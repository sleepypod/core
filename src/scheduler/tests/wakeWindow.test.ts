import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbRows = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('@/src/db', () => {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.from = () => chain
  chain.where = () => chain
  chain.all = () => dbRows.rows
  return { biometricsDb: chain }
})

import { WAKE_MOVEMENT_THRESHOLD, WakeWindows, peakMovementSince, slotBefore } from '../wakeWindow'

const MIN = 60_000

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

describe('peakMovementSince', () => {
  it('returns the peak score, or null when no rows were written', () => {
    dbRows.rows = [{ peak: 420 }]
    expect(peakMovementSince('left', new Date())).toBe(420)
    dbRows.rows = [{ peak: null }]
    expect(peakMovementSince('left', new Date())).toBeNull()
    dbRows.rows = []
    expect(peakMovementSince('left', new Date())).toBeNull()
  })
})

describe('WakeWindows', () => {
  let now: number
  let peak: number | null
  let reads: Array<{ side: string, since: Date }>
  let windows: WakeWindows
  const fire = vi.fn(async () => {})

  beforeEach(() => {
    vi.useFakeTimers()
    now = Date.UTC(2026, 8, 30, 10, 55)
    peak = null
    reads = []
    fire.mockClear()
    windows = new WakeWindows({
      readMovement: (side, since) => {
        reads.push({ side, since })
        return peak
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

  it('does not fire while movement stays under the threshold', async () => {
    peak = WAKE_MOVEMENT_THRESHOLD - 1
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fire).not.toHaveBeenCalled()
    expect(windows.isOpen(1)).toBe(true)
    expect(reads.length).toBeGreaterThan(3)
  })

  it('fires once on the first reading at the threshold and closes', async () => {
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fire).not.toHaveBeenCalled()
    peak = WAKE_MOVEMENT_THRESHOLD
    await vi.advanceTimersByTimeAsync(1000)
    expect(fire).toHaveBeenCalledTimes(1)
    expect(windows.isOpen(1)).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('lets the set-time job skip an occurrence that fired early, once', async () => {
    peak = 800
    windows.open(1, 'left', alarmAt(), 20, fire)
    await vi.advanceTimersByTimeAsync(0)
    expect(fire).toHaveBeenCalledTimes(1)
    now = alarmAt().getTime()
    expect(windows.claim(1)).toBe(true)
    expect(windows.claim(1)).toBe(false)
  })

  it('does not skip an occurrence that fired early long ago', async () => {
    peak = 800
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
    peak = 800
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
    peak = 900
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
    peak = 500
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
    peak = 900
    await vi.advanceTimersByTimeAsync(3000)
    expect(fire).not.toHaveBeenCalled()
  })

  it('keeps watching after a failed movement read', async () => {
    let fail = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    windows = new WakeWindows({
      readMovement: () => {
        if (fail) throw new Error('db busy')
        return 600
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
    peak = 600
    windows.open(1, 'left', alarmAt(), 20, async () => {
      throw new Error('hardware down')
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(err).toHaveBeenCalled()
    now = alarmAt().getTime()
    expect(windows.claim(1)).toBe(false)
  })
})

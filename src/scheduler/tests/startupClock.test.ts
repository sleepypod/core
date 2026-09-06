import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForValidSystemDate } from '../startupClock'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('scheduler startup clock', () => {
  it('returns immediately for a valid clock without scheduling a timer', async () => {
    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'))
    await waitForValidSystemDate()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps scheduled writers waiting until NTP makes the clock plausible', async () => {
    vi.setSystemTime(new Date('2010-01-01T00:00:00Z'))
    let ready = false
    const pending = waitForValidSystemDate().then(() => {
      ready = true
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ready).toBe(false)
    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'))
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    expect(ready).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('logs and continues when the bounded NTP wait expires', async () => {
    vi.setSystemTime(new Date('2010-01-01T00:00:00Z'))
    const pending = waitForValidSystemDate(2, 5_000)
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
    expect(console.error).toHaveBeenCalledWith(
      'System clock never synced after waiting — proceeding anyway.',
      'Scheduled jobs may fire at incorrect times.',
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the pending clock timer immediately on shutdown', async () => {
    vi.setSystemTime(new Date('2010-01-01T00:00:00Z'))
    const controller = new AbortController()
    const pending = waitForValidSystemDate(24, 5_000, controller.signal)
    const assertion = expect(pending).rejects.toThrow('Scheduler startup cancelled')
    controller.abort()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an already-cancelled startup even when the clock is valid', async () => {
    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'))
    const controller = new AbortController()
    controller.abort()
    await expect(waitForValidSystemDate(24, 5_000, controller.signal)).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})

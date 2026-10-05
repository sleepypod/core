import { afterEach, describe, expect, it, vi } from 'vitest'

// Exercise the same independent-side contract that drives both demo layouts.
afterEach(() => vi.useRealTimers())
describe('base demo motion', () => {
  it('moves only selected sides over time and Stop freezes both measured positions', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { base } = await import('../handlers/base')
    const before = await base.getStatus()
    await base.setPosition({ head: 40, feet: 0, feedRate: 50, sides: ['right'] })
    expect(await base.getStatus()).toMatchObject({ movingBySide: { left: false, right: true }, position: before.position })
    vi.advanceTimersByTime(1500)
    const during = await base.getStatus()
    expect(during.position?.left).toEqual(before.position?.left)
    expect(during.position?.right.head).toBeGreaterThan(before.position?.right.head ?? 0)
    await base.stop()
    const stopped = await base.getStatus()
    vi.advanceTimersByTime(30_000)
    expect(await base.getStatus()).toMatchObject({ position: stopped.position, movingBySide: { left: false, right: false } })
    await base.setPosition({ head: 0, feet: 0, feedRate: 100, sides: ['left', 'right'] })
    vi.advanceTimersByTime(30_000)
    expect(await base.getStatus()).toMatchObject({ position: { left: { head: 0, feet: 0 }, right: { head: 0, feet: 0 } }, moving: false })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.useRealTimers())
describe('base demo motion', () => {
  it('locks one-sided moves and schedules until per-side control is unlocked', async () => {
    vi.resetModules()
    const { base } = await import('../handlers/base')
    expect(await base.getStatus()).toMatchObject({ independentControl: false, position: { left: { head: 30, feet: 15 }, right: { head: 30, feet: 15 } } })
    expect(() => base.setPosition({ head: 40, feet: 0, feedRate: 50, sides: ['right'] })).toThrow('whole-bed movement only')
    expect(() => base.setPreset({ preset: 'read', sides: ['left'] })).toThrow('whole-bed movement only')
    expect(() => base.saveSchedule({ head: 1, feet: 5, feedRate: 50, dayOfWeek: 'daily', time: '22:00', side: 'left', presetName: 'Sleep', enabled: true })).toThrow('whole-bed movement only')
    expect(await base.setPosition({ head: 40, feet: 0, feedRate: 50, sides: ['left', 'right'] })).toEqual({ success: true })
  })

  // The unlocked contract drives the per-side layouts once firmware confirms it.
  it('moves only selected sides over time and Stop freezes both measured positions', async () => {
    vi.useFakeTimers()
    const { createBaseSimulator } = await import('../baseSimulator')
    const base = createBaseSimulator({ independent: true })
    expect(await base.getStatus()).toMatchObject({ independentControl: true })
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

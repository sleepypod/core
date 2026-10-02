import { describe, expect, it, vi } from 'vitest'

vi.mock('@/src/utils/trpc', () => ({ trpc: {} }))

import { dailyWaterLevels, waterSeries } from '../waterHistory'

const HOUR = 60 * 60 * 1000
// Noon local time keeps the day math away from midnight edges.
const NOW = new Date(2026, 8, 28, 12, 0, 0).getTime()
const at = (daysAgo: number, hour = 10) => new Date(2026, 8, 28 - daysAgo, hour, 0, 0)

describe('dailyWaterLevels', () => {
  it('returns seven days ending today, oldest first, null without data', () => {
    const days = dailyWaterLevels([], NOW)
    expect(days).toHaveLength(7)
    expect(days.every(d => d.level === null)).toBe(true)
    expect(new Date(days[6].day).getDate()).toBe(28)
    expect(new Date(days[0].day).getDate()).toBe(22)
  })

  it('marks a day low if any reading was low, otherwise ok', () => {
    const days = dailyWaterLevels([
      { timestamp: at(0, 9), level: 'ok' },
      { timestamp: at(1, 8), level: 'ok' },
      { timestamp: at(1, 9), level: 'low' },
      { timestamp: at(1, 10), level: 'ok' },
    ], NOW)
    expect(days[6].level).toBe('ok')
    expect(days[5].level).toBe('low')
    expect(days[4].level).toBeNull()
  })

  it('ignores readings older than the window', () => {
    const days = dailyWaterLevels([{ timestamp: at(9), level: 'low' }], NOW)
    expect(days.every(d => d.level === null)).toBe(true)
  })

  it('accepts ISO string timestamps', () => {
    const days = dailyWaterLevels([{ timestamp: at(0).toISOString(), level: 'ok' }], NOW)
    expect(days[6].level).toBe('ok')
  })
})

describe('waterSeries', () => {
  it('maps ok to 1, low to 0 and empty buckets to NaN', () => {
    const series = waterSeries([
      { timestamp: new Date(NOW - 1 * HOUR), level: 'ok' },
      { timestamp: new Date(NOW - 7 * 24 * HOUR + HOUR), level: 'low' },
    ], NOW, 7)
    expect(series).toHaveLength(7)
    expect(series[6]).toBe(1)
    expect(series[0]).toBe(0)
    expect(Number.isNaN(series[3])).toBe(true)
  })

  it('keeps the worst reading in a bucket so short dips stay visible', () => {
    const series = waterSeries([
      { timestamp: new Date(NOW - 2 * HOUR), level: 'ok' },
      { timestamp: new Date(NOW - 3 * HOUR), level: 'low' },
      { timestamp: new Date(NOW - 4 * HOUR), level: 'ok' },
    ], NOW, 7)
    expect(series[6]).toBe(0)
  })

  it('drops readings outside the 7-day window', () => {
    const series = waterSeries([
      { timestamp: new Date(NOW - 8 * 24 * HOUR), level: 'low' },
      { timestamp: new Date(NOW + HOUR), level: 'low' },
    ], NOW, 7)
    expect(series.every(Number.isNaN)).toBe(true)
  })
})

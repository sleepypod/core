import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { databases } from '../handlers/databases'

function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}

// 2026-10-10 12:00 UTC; the latest 07:00 UTC is the same morning.
const NOW = Date.UTC(2026, 9, 10, 12)
const WAKE = Date.UTC(2026, 9, 10, 7) / 1000
const SEGMENT = 20 * 60
const DAY = 24 * 60 * 60

describe('demo databases.rows reference_stages', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => vi.useRealTimers())

  it('returns back-to-back 20-minute Watch segments per night, newest first', async () => {
    const out = await required(databases.rows)({ db: 'biometrics', table: 'reference_stages', offset: 0, limit: 26 })
    const at = (row: number, column: string) => out.rows[row][out.columns.indexOf(column)]

    expect(out.total).toBe(120)
    expect(out.rows).toHaveLength(26)
    expect(out.rows.every(r => r[out.columns.indexOf('source')] === 'apple_watch')).toBe(true)
    expect(out.rows.slice(0, 6).map((_, i) => at(i, 'stage'))).toEqual(['light', 'deep', 'light', 'rem', 'light', 'wake'])
    expect(at(6, 'stage')).toBe('light')

    expect(at(0, 'end')).toBe(WAKE)
    expect(at(0, 'start')).toBe(WAKE - SEGMENT)
    expect(at(1, 'end')).toBe(at(0, 'start'))
    expect(at(23, 'start')).toBe(WAKE - 24 * SEGMENT)
    expect(at(24, 'end')).toBe(WAKE - DAY)
    expect(at(25, 'end')).toBe(WAKE - DAY - SEGMENT)
    for (let i = 0; i < out.rows.length; i++) {
      expect(at(i, 'end') as number).toBeGreaterThan(at(i, 'start') as number)
    }
  })

  it('leaves columns of other tables to their own generators', async () => {
    const out = await required(databases.rows)({ db: 'biometrics', table: 'water_level_readings', offset: 0, limit: 2 })
    expect(out.columns).toEqual(['id', 'timestamp', 'level'])
    expect(out.rows.map(r => r[2])).toEqual(['ok', 'ok'])
  })
})

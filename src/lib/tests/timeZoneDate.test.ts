import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dateInTimeZone, isValidTimeZone } from '../timeZoneDate'

const shared = globalThis as typeof globalThis & { __sp_timeZoneDateFormatters?: Map<string, Intl.DateTimeFormat | null> }
beforeEach(() => {
  delete shared.__sp_timeZoneDateFormatters
})
afterEach(() => {
  vi.restoreAllMocks()
  delete shared.__sp_timeZoneDateFormatters
})

describe('bounded timezone date formatters', () => {
  it.each([
    ['2026-11-01T06:59:59Z', 'America/Los_Angeles', '2026-10-31'],
    ['2026-11-01T07:00:00Z', 'America/Los_Angeles', '2026-11-01'],
    ['2026-11-01T08:30:00Z', 'America/Los_Angeles', '2026-11-01'],
    ['2026-11-01T09:30:00Z', 'America/Los_Angeles', '2026-11-01'],
    ['2026-03-08T09:59:59Z', 'America/Los_Angeles', '2026-03-08'],
    ['2026-03-08T10:00:00Z', 'America/Los_Angeles', '2026-03-08'],
    ['2026-11-01T23:30:00Z', 'Asia/Kolkata', '2026-11-02'],
    ['2011-12-30T12:00:00Z', 'Pacific/Apia', '2011-12-31'],
    ['2026-11-01T00:00:00Z', 'UTC', '2026-11-01'],
  ])('keeps the source-local day for %s in %s', (instant, zone, expected) => {
    expect(isValidTimeZone(zone)).toBe(true)
    expect(dateInTimeZone(Date.parse(instant), zone)).toBe(expected)
  })

  it('shares one formatter across repeated validation, date conversion and module copies', async () => {
    const originalDateTimeFormat = Intl.DateTimeFormat
    const constructors = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
      return new originalDateTimeFormat(locales, options)
    })
    for (let index = 0; index < 100; index++) {
      expect(isValidTimeZone('UTC')).toBe(true)
      expect(dateInTimeZone(Date.UTC(2026, 10, 11), 'UTC')).toBe('2026-11-11')
    }
    vi.resetModules()
    const duplicate = await import('../timeZoneDate')
    expect(duplicate.isValidTimeZone('UTC')).toBe(true)
    expect(constructors).toHaveBeenCalledTimes(1)
  })

  it('retains rejection after a valid zone and after cache eviction', () => {
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('not/a-timezone')).toBe(false)
    expect(() => dateInTimeZone(0, 'not/a-timezone')).toThrow(RangeError)
    for (let index = 0; index < 100; index++) expect(isValidTimeZone(`Unknown/zone-${index}`)).toBe(false)
    expect(shared.__sp_timeZoneDateFormatters?.size).toBeLessThanOrEqual(64)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(dateInTimeZone(0, 'UTC')).toBe('1970-01-01')
    expect(isValidTimeZone('not/a-timezone')).toBe(false)
    expect(() => dateInTimeZone(Number.NaN, 'UTC')).toThrow(RangeError)
    expect(() => dateInTimeZone(Infinity, 'UTC')).toThrow(RangeError)
  })
})

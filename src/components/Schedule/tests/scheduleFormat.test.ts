import { describe, expect, it } from 'vitest'
import {
  curveSlug,
  daysToIndexes,
  formatDayRange,
  indexesToDays,
  parseCurveSlug,
  sameDays,
  tempTone,
} from '../scheduleFormat'

describe('formatDayRange', () => {
  it('returns empty string for no days and "Every day" for all seven', () => {
    expect(formatDayRange([])).toBe('')
    expect(formatDayRange(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'])).toBe('Every day')
  })

  it('collapses 3+ contiguous Mon-first days into a range regardless of input order', () => {
    expect(formatDayRange(['friday', 'monday', 'wednesday', 'tuesday', 'thursday'])).toBe('Mon–Fri')
    expect(formatDayRange(['monday', 'tuesday', 'wednesday'])).toBe('Mon–Wed')
  })

  it('lists non-contiguous or short runs', () => {
    expect(formatDayRange(['monday', 'wednesday', 'friday'])).toBe('Mon, Wed, Fri')
    expect(formatDayRange(['saturday', 'sunday'])).toBe('Sat, Sun')
    expect(formatDayRange(['tuesday'])).toBe('Tue')
  })

  it('names weekdays and weekends only when asked', () => {
    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const
    expect(formatDayRange(weekdays, { named: true })).toBe('Weekdays')
    expect(formatDayRange(['sunday', 'saturday'], { named: true })).toBe('Weekends')
    expect(formatDayRange(['monday', 'tuesday', 'wednesday', 'thursday'], { named: true })).toBe('Mon–Thu')
    expect(formatDayRange(['saturday', 'sunday', 'monday'], { named: true })).toBe('Mon, Sat, Sun')
  })
})

describe('curve slugs', () => {
  it('names a curve by its days, Mon-first', () => {
    expect(curveSlug(['sunday', 'monday', 'friday'])).toBe('mon-fri-sun')
    expect(curveSlug(new Set(['saturday'] as const))).toBe('sat')
  })

  it('reads a slug back in any order and case', () => {
    expect(parseCurveSlug('mon-fri-sun')).toEqual(['monday', 'friday', 'sunday'])
    expect(parseCurveSlug('Sun-Mon')).toEqual(['monday', 'sunday'])
  })

  it('rejects anything that is not a list of days', () => {
    expect(parseCurveSlug('new')).toBeNull()
    expect(parseCurveSlug('mon-')).toBeNull()
    expect(parseCurveSlug('')).toBeNull()
  })
})

describe('day index mapping', () => {
  it('maps DayOfWeek to Mon-first picker indexes and back', () => {
    expect(daysToIndexes(['sunday', 'monday', 'friday'])).toEqual([0, 4, 6])
    expect(indexesToDays([0, 4, 6])).toEqual(['monday', 'friday', 'sunday'])
    expect(indexesToDays([9])).toEqual([])
  })

  it('compares day sets ignoring order and duplicates', () => {
    expect(sameDays(['monday', 'sunday'], ['sunday', 'monday'])).toBe(true)
    expect(sameDays(['monday'], ['monday', 'sunday'])).toBe(false)
    expect(sameDays(['monday', 'tuesday'], ['monday', 'sunday'])).toBe(false)
  })
})

describe('tempTone', () => {
  it('splits at the 80°F neutral point', () => {
    expect(tempTone(79)).toBe('cool')
    expect(tempTone(80)).toBe('neutral')
    expect(tempTone(81)).toBe('warm')
  })
})

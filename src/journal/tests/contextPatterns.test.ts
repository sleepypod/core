import { describe, expect, it } from 'vitest'
import assert from 'node:assert/strict'
import type { JournalSelection } from '../contract'
import { journalContextPatterns, journalContextPatternsSchema } from '../contextPatterns'
import { shiftHistoryDate } from '@/src/lib/localDates'

const now = Date.parse('2026-11-10T20:00Z')
function records(): JournalSelection[] {
  return Array.from({ length: 10 }, (_, index) => {
    const date = shiftHistoryDate('2026-11-10', -index)
    const bedtimeAt = Date.parse(`${date}T06:00Z`)
    return { side: 'left', date, revision: null, record: {
      side: 'left', date, origin: 'sleepypod', timeZone: 'America/Los_Angeles', createdAt: now, updatedAt: now, importedAt: null,
      fields: { restfulness: 3, comfort: index < 5 ? 'warm' : 'comfortable', caffeine: true, alcohol: false, exercise: true, notes: '', context: {
        version: 1, bedtimeAt, stress: index < 5 ? 'higher' : 'usual',
        caffeine: { status: 'yes', unit: 'milligrams', amount: index < 5 ? 200 : 100, lastAt: bedtimeAt - (index < 5 ? 2 : 8) * 3600_000 },
        alcohol: { status: 'not_logged', unit: 'usStandardDrinks' },
        exercise: { status: 'yes', unit: 'minutes', amount: 30, lastAt: bedtimeAt - (index < 5 ? 1 : 5) * 3600_000 },
      } },
    } } as JournalSelection
  })
}
describe('exploratory habit and reported-comfort associations', () => {
  it('reports counts and absolute percentage-point differences only with five dates in each group', () => {
    const result = journalContextPatternsSchema.parse(journalContextPatterns(records(), now))
    const time = result.cohorts[0].comparisons.find(value => value.id === 'exercise-time')
    expect(time).toMatchObject({ withCount: 5, withoutCount: 5, withWarmCount: 5, withoutWarmCount: 0, warmRateDifferencePoints: 100, excludedCount: 0 })
    expect(result.cohorts[0].comparisons.find(value => value.id === 'alcohol-time')).toMatchObject({ withCount: 0, withoutCount: 0, excludedCount: 10, warmRateDifferencePoints: null })
    const partial = journalContextPatterns(records().slice(1), now)
    expect(partial.cohorts[0].comparisons.every(value => value.warmRateDifferencePoints === null)).toBe(true)
  })
  it('uses a displayed range-specific median and does not manufacture groups from ties', () => {
    const result = journalContextPatterns(records(), now).cohorts[0]
    expect(result.comparisons.find(value => value.id === 'caffeine-amount')).toMatchObject({ quantityThreshold: 150, withCount: 5, withoutCount: 5 })
    expect(result.comparisons.find(value => value.id === 'exercise-amount')).toMatchObject({ quantityThreshold: 30, withCount: 0, withoutCount: 10, warmRateDifferencePoints: null })
  })
  it('never pools sides, source origins or retained zones to reach the threshold', () => {
    for (const field of ['side', 'origin', 'timeZone'] as const) {
      const entries = records()
      for (const entry of entries.slice(0, 5)) {
        assert(entry.record)
        Object.assign(entry.record, { [field]: field === 'side' ? 'right' : field === 'origin' ? 'free-sleep' : 'America/New_York' })
      }
      const result = journalContextPatterns(entries, now)
      expect(result.cohorts).toHaveLength(2)
      expect(result.cohorts.flatMap(cohort => cohort.comparisons).every(value => value.warmRateDifferencePoints === null)).toBe(true)
    }
  })
  it('withdraws duplicate dates, missing bedtime, future data and activity after bedtime', () => {
    const entries = records()
    entries.push(entries[0])
    const missing = entries[1].record?.fields.context
    const future = entries[2].record?.fields.context
    const afterBed = entries[3].record?.fields.context
    assert(missing && future && afterBed && afterBed.bedtimeAt !== undefined)
    delete missing.bedtimeAt
    future.exercise.lastAt = now + 1
    afterBed.exercise.lastAt = afterBed.bedtimeAt + 1
    const result = journalContextPatterns(entries, now).cohorts[0]
    expect(result.comparisons.find(value => value.id === 'exercise-time')).toMatchObject({ withCount: 1, withoutCount: 5, excludedCount: 5, warmRateDifferencePoints: null })
    expect(result.dates).toBe(9)
  })
})

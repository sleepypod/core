import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { personalJournalPatterns, parsePersonalJournalPatternsQuery, personalJournalPatternsResponseSchema } from '../personalJournalPatterns'
import type { PersonalJournalSelection } from '../personalJournalContract'
import { shiftHistoryDate } from '@/src/lib/localDates'

const now = Date.parse('2026-11-11T20:00:00Z')
function entries(): PersonalJournalSelection[] {
  return Array.from({ length: 10 }, (_, index) => {
    const date = shiftHistoryDate('2026-11-10', -index), bedtimeAt = Date.parse(`${date}T06:00:00Z`)
    return { date, revision: randomUUID(), timeZone: 'America/Los_Angeles', record: {
      date, timeZone: 'America/Los_Angeles', createdAt: now, updatedAt: now, fields: {
        restfulness: 4, comfort: index < 5 ? 'warm' : 'comfortable', notes: 'private-note-marker',
        caffeine: true, alcohol: false, exercise: false, context: {
          version: 1, bedtimeAt, caffeine: { status: 'yes', unit: 'milligrams', amount: index < 5 ? 200 : 100,
            lastAt: bedtimeAt - (index < 5 ? 2 : 8) * 3_600_000 },
          alcohol: { status: 'not_logged', unit: 'usStandardDrinks' }, exercise: { status: 'none', unit: 'minutes' },
          stress: index < 5 ? 'higher' : 'usual',
        },
      },
    } }
  })
}
function saved(entry: PersonalJournalSelection) {
  if (!entry.record) throw new Error('Fixture requires a saved entry')
  return entry.record
}
function response(values = entries()) {
  const identity = randomUUID()
  return { version: 1, generatedAt: now, scope: { podId: identity, householdId: identity, accountId: identity,
    sleeperId: identity, sessionRevision: 1, householdRevision: 1, assignmentRevision: 1 },
  query: { from: '2026-11-01', through: '2026-11-10' }, interpretation: 'personal_self_report_not_sleep_measurement',
  ...personalJournalPatterns(values, now) }
}
describe('person-owned habit comparison projection', () => {
  it('reports separate counts and descriptive differences without notes, dates or a fabricated side', () => {
    const result = personalJournalPatternsResponseSchema.parse(response())
    expect(result.cohorts[0].dates).toBe(10)
    expect(result.cohorts[0].comparisons.find(item => item.id === 'caffeine-time')).toMatchObject({
      withCount: 5, withoutCount: 5, withWarmCount: 5, withoutWarmCount: 0, warmRateDifferencePoints: 100,
    })
    expect(result.cohorts[0].comparisons.find(item => item.id === 'caffeine-amount')).toMatchObject({ quantityThreshold: 150 })
    const projection = JSON.stringify(result.cohorts)
    for (const forbidden of ['private-note-marker', 'side', '2026-11-10', 'bedtimeAt', 'createdAt']) expect(projection).not.toContain(forbidden)
    expect(result.source).toBe('personal_journal')
  })
  it('never pools retained zones to satisfy the two minimum groups', () => {
    const values = entries()
    for (const entry of values.slice(0, 5)) {
      entry.timeZone = 'America/New_York'
      saved(entry).timeZone = entry.timeZone
    }
    const result = personalJournalPatternsResponseSchema.parse(response(values))
    expect(result.cohorts).toHaveLength(2)
    expect(result.cohorts.flatMap(item => item.comparisons).every(item => item.warmRateDifferencePoints === null)).toBe(true)
  })
  it('treats missing and future context as excluded, not a cold or no-activity night', () => {
    const values = entries()
    saved(values[0]).fields.context = null
    const context = saved(values[1]).fields.context
    if (!context) throw new Error('Fixture requires optional context')
    context.caffeine.lastAt = now + 1
    const result = personalJournalPatternsResponseSchema.parse(response(values))
    expect(result.cohorts[0].comparisons.find(item => item.id === 'caffeine-time')).toMatchObject({
      withCount: 3, withoutCount: 5, excludedCount: 2, warmRateDifferencePoints: null,
    })
    expect(result.cohorts[0].comparisons.find(item => item.id === 'alcohol-time')).toMatchObject({ withCount: 0, withoutCount: 0, excludedCount: 10 })
  })
  it('rejects duplicate persisted dates and saved records newer than the response clock', () => {
    const values = entries()
    expect(() => personalJournalPatterns([...values, values[0]], now)).toThrow()
    saved(values[0]).updatedAt = now + 1
    expect(() => personalJournalPatterns(values, now)).toThrow()
  })
  it('rejects inconsistent counts, invented differences and wider projections', () => {
    const result = response()
    result.cohorts[0].comparisons[0].warmRateDifferencePoints = 4
    expect(() => personalJournalPatternsResponseSchema.parse(result)).toThrow()
    const broader = response()
    Object.assign(broader.cohorts[0], { side: 'left', notes: 'private' })
    expect(() => personalJournalPatternsResponseSchema.parse(broader)).toThrow()
    const totals = response()
    totals.cohorts[0].dates = 9
    expect(() => personalJournalPatternsResponseSchema.parse(totals)).toThrow()
  })
  it.each(['', 'date=2026-11-10', 'from=2026-11-01&through=2026-11-10&side=left',
    'from=2026-11-01&from=2026-11-02&through=2026-11-10', 'from=2026-01-01&through=2026-11-10',
    'from=2026-02-30&through=2026-03-02', 'from=2026-11-10&through=2026-11-01'])('rejects unsupported or unbounded ranges: %s', (query) => {
    expect(() => parsePersonalJournalPatternsQuery(new URLSearchParams(query))).toThrow()
  })
})

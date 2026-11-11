import { describe, expect, it } from 'vitest'
import { journalWallTime, journalWallTimeCandidates } from '../contextClock'
import { journalContextDraft, parseJournalContextDraft } from '../contextDraft'
import type { JournalFields } from '../contract'

const fields: JournalFields = { restfulness: 3, comfort: 'comfortable', caffeine: true, alcohol: false, exercise: false, notes: '' }
const zone = 'America/Los_Angeles'
const now = Date.parse('2026-11-01T18:00:00Z')
describe('journal context drafts and retained clocks', () => {
  it('does not turn older unchecked habits into reported absence', () => {
    const draft = journalContextDraft(fields, zone)
    expect(draft.habits.caffeine.status).toBe('yes')
    expect(draft.habits.alcohol.status).toBe('not_logged')
    expect(parseJournalContextDraft(draft, '2026-11-01', zone, now).context?.alcohol.status).toBe('not_logged')
  })
  it('rejects spring gaps, invalid dates and unknown zones without normalizing them', () => {
    expect(journalWallTimeCandidates('2026-03-08T02:30', zone)).toEqual([])
    expect(journalWallTimeCandidates('2026-02-30T12:30', zone)).toEqual([])
    expect(journalWallTimeCandidates('2026-11-01T12:30', 'Bad/Zone')).toEqual([])
  })
  it('requires an explicit fall-back occurrence and keeps a saved later occurrence', () => {
    const candidates = journalWallTimeCandidates('2026-11-01T01:30', zone)
    expect(candidates).toEqual([Date.parse('2026-11-01T08:30Z'), Date.parse('2026-11-01T09:30Z')])
    const draft = journalContextDraft(fields, zone)
    draft.times.bedtimeAt.value = '2026-11-01T01:30'
    expect(parseJournalContextDraft(draft, '2026-11-01', zone, now).error).toContain('occurs twice')
    draft.times.bedtimeAt.occurrence = candidates[1]
    const parsed = parseJournalContextDraft(draft, '2026-11-01', zone, now)
    expect(parsed.context?.bedtimeAt).toBe(candidates[1])
    expect(journalContextDraft({ ...fields, context: parsed.context }, zone).times.bedtimeAt.occurrence).toBe(candidates[1])
  })
  it('handles a half-hour clock fold and quarter-hour fixed offset', () => {
    expect(journalWallTimeCandidates('2026-04-05T01:45', 'Australia/Lord_Howe')).toHaveLength(2)
    const candidates = journalWallTimeCandidates('2026-11-01T12:00', 'Asia/Kathmandu')
    expect(candidates).toEqual([Date.parse('2026-11-01T06:15Z')])
    expect(journalWallTime(candidates[0], 'Asia/Kathmandu')).toBe('2026-11-01T12:00')
  })
  it('keeps zero distinct from blank and rejects invalid amounts or future time', () => {
    const draft = journalContextDraft(fields, zone)
    expect(parseJournalContextDraft(draft, '2026-11-01', zone, now).context?.caffeine.amount).toBeUndefined()
    draft.habits.caffeine.amount = '0'
    expect(parseJournalContextDraft(draft, '2026-11-01', zone, now).context?.caffeine.amount).toBe(0)
    for (const value of ['-1', 'Infinity', 'NaN', '10001']) {
      draft.habits.caffeine.amount = value
      expect(parseJournalContextDraft(draft, '2026-11-01', zone, now).error).toContain('amount')
    }
    draft.habits.caffeine.amount = ''
    draft.times.caffeine.value = '2026-11-01T23:30'
    expect(parseJournalContextDraft(draft, '2026-11-01', zone, now).error).toContain('Future')
    draft.habits.caffeine.status = 'none'
    expect(parseJournalContextDraft(draft, '2026-11-01', zone, now).context?.caffeine).toEqual({ status: 'none', unit: 'milligrams' })
  })
})

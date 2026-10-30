import { describe, expect, it } from 'vitest'
import fixtures from '../fixtures/personal-history-v1.json'
import { parsePersonalHistorySearch, personalHistoryDetailSchema, personalHistoryPageSchema } from '../historyApiContract'

describe('personal history version-one transport', () => {
  it('keeps the shared native/web examples valid and source-labeled', () => {
    expect(personalHistoryPageSchema.parse(fixtures.page)).toEqual(fixtures.page)
    expect(personalHistoryPageSchema.parse(fixtures.emptyPage)).toEqual(fixtures.emptyPage)
    expect(personalHistoryPageSchema.parse(fixtures.vitalsPage)).toEqual(fixtures.vitalsPage)
    expect(personalHistoryPageSchema.parse(fixtures.movementPage)).toEqual(fixtures.movementPage)
    expect(personalHistoryDetailSchema.parse(fixtures.detail)).toEqual(fixtures.detail)
  })

  it.each(['1e2', '-1', '01', '1.5', 'Infinity', 'NaN', '', '101', '0'])('rejects an invalid page limit %s without number coercion surprises', (limit) => {
    expect(() => parsePersonalHistorySearch(new URLSearchParams({ startsAt: '0', endsAt: '10000', kind: 'presence', limit }))).toThrow()
  })

  it('rejects unknown and duplicate keys, excessive intervals, foreign people and fabricated sources', () => {
    const base = 'startsAt=0&endsAt=10000&kind=presence'
    for (const extra of ['__proto__=anything', 'constructor=anything', 'side=left', 'startsAt=1'])
      expect(() => parsePersonalHistorySearch(new URLSearchParams(`${base}&${extra}`))).toThrow()
    expect(() => parsePersonalHistorySearch(new URLSearchParams('startsAt=0&endsAt=8000000000&kind=presence'))).toThrow()
    expect(() => personalHistoryPageSchema.parse({ ...fixtures.page, scope: { ...fixtures.page.scope, sleeperId: '10000000-0000-4000-8000-000000000099' } })).toThrow()
    expect(() => personalHistoryDetailSchema.parse({ ...fixtures.detail, source: 'apple_health' })).toThrow()
  })

  it('rejects invalid ranges, duplicate records, cross-kind records and impossible duration', () => {
    const page = structuredClone(fixtures.page)
    expect(() => personalHistoryPageSchema.parse({ ...page, query: { ...page.query, startsAt: page.query.endsAt } })).toThrow()
    expect(() => personalHistoryPageSchema.parse({ ...page, query: { ...page.query, kind: 'vitals' } })).toThrow()
    expect(() => personalHistoryPageSchema.parse({ ...page, records: [...page.records, ...page.records] })).toThrow()
    const record = { ...page.records[0], endsAt: page.records[0].startsAt + 1 }
    expect(() => personalHistoryDetailSchema.parse({ ...fixtures.detail, record })).toThrow()
  })
})

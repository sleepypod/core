import { describe, expect, it } from 'vitest'
import { comparisonStatistics, morningTakeaways, parseMorningReport, verifiedReportComparison, type SavedMorningReport } from '../morning'
import nativeFixture from './fixtures/native-report-v1.json'

const createdAt = Date.parse('2026-11-02T16:05:00Z')
const identity = '120c83db-50f9-4fef-879d-5dc603978bea'
function example() {
  // Fixed LA noon instants straddle the real 25-hour fall-back day.
  const boundaries = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23',
    '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29',
    '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']
    .map(date => Date.parse(`${date}T${date >= '2026-11-01' ? '20' : '19'}:00:00Z`))
  return { version: 1, report: { id: identity, createdAt, provider: 'apple', model: 'Apple Foundation Models',
    source: 'Synthetic Watch source', facts: [{ id: 'health.sleep', text: 'A saved, source-specific estimate.' },
      { id: 'pod.occupancy', text: 'Bed presence is separate from measured sleep.' }],
    text: '### Example interpretation\nNo demonstrated causal improvement. [health.sleep]',
    comparison: { metric: 'recorded_sleep_minutes', sourceID: 'synthetic-watch', sourceName: 'Synthetic Watch',
      timeZone: 'America/Los_Angeles', importedAt: Date.parse('2026-11-02T16:00:00Z'), asOf: Date.parse('2026-11-02T16:01:00Z'),
      omittedRecords: 0, days: boundaries.slice(0, 14).map((start, index) => ({ start, end: boundaries[index + 1], minutes: index < 7 ? 420 : 480 as number | null })) },
    followUps: [] as { id: string, createdAt: number, question: string, text: string, provider: string, model: string }[],
  } }
}
const read = (value: unknown) => parseMorningReport(JSON.stringify(value), createdAt + 60000)
function requireComparison(report: SavedMorningReport) {
  const comparison = verifiedReportComparison(report)
  if (!comparison) throw new Error('Expected a valid comparison fixture')
  return comparison
}

describe('frozen morning report evidence for web/native parity', () => {
  it('reads the exact native transfer fixture with Unix milliseconds, explicit gaps and a real DST day', () => {
    const report = read(nativeFixture), comparison = requireComparison(report)
    expect(report.createdAt).toBe(1793635500000)
    expect(report.id).toBe('120c83db-50f9-4fef-879d-5dc603978bea')
    expect(report.text).toBe(nativeFixture.report.text)
    expect(report.followUps?.[0].createdAt).toBe(1793635560000)
    expect(comparison.days[0].minutes).toBeNull()
    expect(comparison.days[12].end - comparison.days[12].start).toBe(25 * 3600000)
    expect(comparisonStatistics(comparison)).toEqual({ priorCount: 6, recentCount: 7, observedCount: 13, changeMinutes: 60 })
  })
  it('keeps original report, facts and clocks unchanged while deriving three highlights', () => {
    const input = example(), original = JSON.stringify(input)
    const report = read(input), comparison = requireComparison(report)
    expect(comparison.days[12].end - comparison.days[12].start).toBe(25 * 3600000)
    expect(comparisonStatistics(comparison)).toEqual({ priorCount: 7, recentCount: 7, observedCount: 14, changeMinutes: 60 })
    const takeaways = morningTakeaways(report)
    expect(takeaways).toHaveLength(3)
    expect(takeaways[0]).toMatchObject({ badge: 'Source estimate' })
    expect(takeaways[0].text).toContain('8h 0m recorded for the sleep day ending Nov 2')
    expect(takeaways[1].text).toContain('60 minutes more')
    expect(takeaways[1].text).toContain('descriptive difference')
    expect(JSON.stringify(input)).toBe(original)
    expect(report.text).toBe(input.report.text)
  })

  it('leaves missing days as gaps and requires four observations in both weeks', () => {
    const input = example()
    for (const index of [0, 1, 2, 3, 7, 8, 9]) input.report.comparison.days[index].minutes = null
    const comparison = requireComparison(read(input))
    expect(comparisonStatistics(comparison)).toEqual({ priorCount: 3, recentCount: 4, observedCount: 7, changeMinutes: null })
    expect(comparison.days[0].minutes).toBeNull()
    expect(morningTakeaways(read(input))[1].badge).toBe('Limited coverage')
    input.report.comparison.days[3].minutes = 420
    expect(comparisonStatistics(requireComparison(read(input))).changeMinutes).toBe(60)
  })

  it('retains the 23-hour spring day instead of allowing a full 24-hour value', () => {
    const input = example(), chart = input.report.comparison
    input.report.createdAt = Date.parse('2026-03-15T15:05:00Z')
    chart.importedAt = Date.parse('2026-03-15T15:00:00Z')
    chart.asOf = chart.importedAt
    const boundaries = Array.from({ length: 15 }, (_, index) => {
      const date = `2026-03-${String(index + 1).padStart(2, '0')}`
      return Date.parse(`${date}T${index < 7 ? '20' : '19'}:00:00Z`)
    })
    chart.days = boundaries.slice(0, 14).map((start, index) => ({ start, end: boundaries[index + 1], minutes: 420 }))
    const result = requireComparison(read(input))
    expect(result.days[6].end - result.days[6].start).toBe(23 * 3600000)
    chart.days[6].minutes = 1381
    expect(verifiedReportComparison(read(input))).toBeNull()
  })

  it('validates source-local noon in a quarter-hour-offset zone', () => {
    const input = example(), chart = input.report.comparison
    chart.timeZone = 'Asia/Kathmandu'
    chart.importedAt = Date.parse('2026-11-02T05:00:00Z')
    chart.asOf = chart.importedAt
    chart.days = chart.days.map(day => ({ ...day,
      start: Date.parse(`${new Date(day.start).toISOString().slice(0, 10)}T06:15:00Z`),
      end: Date.parse(`${new Date(day.end).toISOString().slice(0, 10)}T06:15:00Z`),
    }))
    expect(verifiedReportComparison(read(input))?.timeZone).toBe('Asia/Kathmandu')
  })

  it('never calls an entirely missing fortnight zero sleep', () => {
    const input = example()
    input.report.comparison.days.forEach(day => day.minutes = null)
    expect(morningTakeaways(read(input))[0]).toMatchObject({ badge: 'Missing data' })
    expect(morningTakeaways(read(input))[0].text).toContain('Missing data does not establish no sleep')
    expect(morningTakeaways(read(input))[2].badge).toBe('0/14 days')
  })

  it.each(['missing', 'invalid-zone', 'presence', 'duplicate-day', 'shifted-noon', 'flat-dst', 'future-as-of', 'future-import', 'impossible-minutes', 'zero', 'negative', 'partial-import'])(
    'withholds %s chart metadata without inventing replacements from prose', (kind) => {
      const input = example(), chart = input.report.comparison
      input.report.text = 'The report claims 17 hours and 99% improvement. These numbers must not become highlights.'
      switch (kind) {
        case 'missing': Object.assign(input.report, { comparison: undefined })
          break
        case 'invalid-zone': chart.timeZone = 'Not/A_TimeZone'
          break
        case 'presence': chart.metric = 'bed_presence_minutes'
          break
        case 'duplicate-day': chart.days[1] = chart.days[0]
          break
        case 'shifted-noon': chart.days[0].start += 1000
          break
        case 'flat-dst': chart.days[12].end -= 3600000
          break
        case 'future-as-of': chart.asOf = createdAt + 1
          break
        case 'future-import': chart.importedAt = chart.asOf + 1
          break
        case 'impossible-minutes': chart.days[0].minutes = 1441
          break
        case 'zero': chart.days[0].minutes = 0
          break
        case 'negative': chart.days[0].minutes = -1
          break
        case 'partial-import': chart.importedAt = chart.days[13].start + 60000
          break
      }
      const report = read(input)
      expect(verifiedReportComparison(report)).toBeNull()
      expect(morningTakeaways(report)).toEqual([
        { id: 'health.sleep', title: 'Recorded sleep', text: input.report.facts[0].text, badge: 'Saved evidence' },
        { id: 'pod.occupancy', title: 'Bed presence', text: input.report.facts[1].text, badge: 'Saved evidence' },
      ])
      expect(report.text).toBe(input.report.text)
    },
  )

  it('preserves sparse legacy prose without claiming evidence or fabricating three cards', () => {
    const input = example()
    Object.assign(input.report, { comparison: undefined, facts: [] })
    expect(morningTakeaways(read(input))).toEqual([])
  })

  it('keeps a dated follow-up separate from the original interpretation', () => {
    const input = example()
    input.report.followUps.push({ id: '8893f3e4-0eef-4eb5-a53f-f273574c55de', createdAt: createdAt + 20000,
      question: 'How complete are these observations?', text: 'These are estimates and may include partial days.',
      provider: 'openai', model: 'example-model' })
    const report = read(input)
    expect(report.followUps?.[0].question).toBe(input.report.followUps[0].question)
    expect(report.createdAt).toBe(createdAt)
    expect(morningTakeaways(report)).toEqual(morningTakeaways(read(example())))
  })

  it.each(['duplicate-fact', 'future-report', 'early-follow-up', 'future-follow-up', 'reused-id', 'unknown-version', 'identity-claim'])(
    'rejects inconsistent document %s', (kind) => {
      const input = example()
      const answer = { id: '8893f3e4-0eef-4eb5-a53f-f273574c55de', createdAt: createdAt + 20000,
        question: 'What is recorded?', text: 'A saved answer.', provider: 'apple', model: 'example-model' }
      switch (kind) {
        case 'duplicate-fact': input.report.facts.push(input.report.facts[0])
          break
        case 'future-report': input.report.createdAt = createdAt + 60001
          break
        case 'early-follow-up': answer.createdAt = createdAt - 1
          input.report.followUps.push(answer)
          break
        case 'future-follow-up': answer.createdAt = createdAt + 60001
          input.report.followUps.push(answer)
          break
        case 'reused-id': answer.id = identity
          input.report.followUps.push(answer)
          break
        case 'unknown-version': input.version = 2
          break
        case 'identity-claim': Object.assign(input, { owner: 'another-person' })
          break
      }
      expect(() => read(input)).toThrow()
    },
  )

  it('bounds UTF-8 document size before parsing', () => {
    expect(() => parseMorningReport('💤'.repeat(100000), createdAt)).toThrow('too large')
    expect(() => parseMorningReport('{', createdAt)).toThrow()
  })
})

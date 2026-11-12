import { z } from 'zod'
import { sleepNightKey } from '@/src/lib/sleep-recording'
import { shiftHistoryDate } from '@/src/lib/localDates'

const timestamp = z.number().int().min(0).max(253402300799999)
const provider = z.enum(['apple', 'openai', 'gemini', 'anthropic', 'ollama'])
const model = z.string().min(1).max(128)
export const reportIdSchema = z.uuid().transform(value => value.toLowerCase())
const fact = z.object({ id: z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/), text: z.string().min(1).max(8000) }).strict()
const response = z.object({
  id: reportIdSchema, createdAt: timestamp, question: z.string().min(1).max(1000), text: z.string().min(1).max(60000),
  provider, model, inputTokens: z.number().int().nonnegative().nullable().optional(),
  outputTokens: z.number().int().nonnegative().nullable().optional(),
}).strict()

/** Versioned display data only: scope and sharing authorization belong to the authenticated transport. */
const document = z.object({
  version: z.literal(1),
  report: z.object({
    id: reportIdSchema, createdAt: timestamp, provider, model, source: z.string().min(1).max(256),
    facts: z.array(fact).max(80), text: z.string().min(1).max(60000),
    inputTokens: z.number().int().nonnegative().nullable().optional(),
    outputTokens: z.number().int().nonnegative().nullable().optional(),
    // Invalid optional chart metadata must not erase the original report and facts.
    comparison: z.unknown().optional(), followUps: z.array(response).max(10).optional(),
  }).strict(),
}).strict()

const comparisonSchema = z.object({
  metric: z.literal('recorded_sleep_minutes'),
  sourceID: z.string().min(1).max(256), sourceName: z.string().min(1).max(256),
  timeZone: z.string().min(1).max(100), importedAt: timestamp, asOf: timestamp,
  omittedRecords: z.number().int().nonnegative(),
  days: z.array(z.object({ start: timestamp, end: timestamp, minutes: z.number().positive().nullable() }).strict()).length(14),
}).strict()
export type ReportSleepComparison = z.infer<typeof comparisonSchema>
export type SavedMorningReport = z.infer<typeof document>['report']
export interface MorningTakeaway { id: string, title: string, text: string, badge: string }

export const reportEvidenceTitles: Readonly<Record<string, string>> = {
  'health.coverage': 'Health coverage', 'health.recent': 'Recent Health records', 'health.sleep': 'Recorded sleep',
  'health.rhr': 'Daily resting heart rate', 'health.hrv': 'Daily HRV · SDNN', 'health.respiration': 'Daily breathing rate',
  'health.timing': 'Sleep timing', 'health.change': 'Recorded sleep change', 'pod.range': 'Pod date range',
  'pod.coverage': 'Pod coverage', 'pod.presence': 'Bed presence', 'pod.occupancy': 'Bed presence',
  'pod.latest': 'Latest presence', 'pod.heart': 'Estimated Pod heart rate', 'pod.processing': 'Processing provenance',
}

/** Never parse numbers from model prose or accept a document as proof of its owner's identity. */
export function parseMorningReport(text: string, receivedAt: number): SavedMorningReport {
  timestamp.parse(receivedAt)
  if (new TextEncoder().encode(text).byteLength > 384 * 1024) throw new Error('Report is too large')
  const { report } = document.parse(JSON.parse(text))
  const followUps = report.followUps ?? []
  if (report.createdAt > receivedAt
    || new Set(report.facts.map(item => item.id)).size !== report.facts.length
    || new Set([report.id, ...followUps.map(item => item.id)]).size !== followUps.length + 1
    || followUps.some(item => item.createdAt < report.createdAt || item.createdAt > receivedAt)) {
    throw new Error('Report dates or evidence identifiers are inconsistent')
  }
  return report
}

/** Check every calendar boundary in the source zone, retaining 23/25-hour DST days. */
export function verifiedReportComparison(report: SavedMorningReport): ReportSleepComparison | null {
  const parsed = comparisonSchema.safeParse(report.comparison)
  if (!parsed.success) return null
  const comparison = parsed.data
  if (comparison.importedAt > comparison.asOf || comparison.asOf > report.createdAt) return null
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: comparison.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    const current = sleepNightKey(new Date(comparison.asOf), comparison.timeZone)
    const boundary = (instant: number, expected: string) => {
      const parts = formatter.formatToParts(instant)
      const field = (name: string) => parts.find(part => part.type === name)?.value
      return `${field('year')}-${field('month')}-${field('day')}` === expected
        && Number(field('hour')) === 12 && Number(field('minute')) === 0 && Number(field('second')) === 0 && instant % 1000 === 0
    }
    const valid = comparison.days.every((day, index) => {
      const date = shiftHistoryDate(current, index - 13)
      return boundary(day.start, date) && boundary(day.end, shiftHistoryDate(date, 1))
        && day.end > day.start && (index === 0 || day.start === comparison.days[index - 1].end)
        && (day.minutes === null || day.minutes <= (Math.min(day.end, comparison.importedAt) - day.start) / 60000 + 0.01)
    })
    return valid ? comparison : null
  }
  catch { return null }
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const ordered = [...values].sort((first, second) => first - second)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}
export function comparisonStatistics(comparison: ReportSleepComparison) {
  const observed = (days: ReportSleepComparison['days']) => days.flatMap(day => day.minutes === null ? [] : [day.minutes])
  const prior = observed(comparison.days.slice(0, 7)), recent = observed(comparison.days.slice(7))
  const priorMedian = median(prior), recentMedian = median(recent)
  return { priorCount: prior.length, recentCount: recent.length, observedCount: prior.length + recent.length,
    changeMinutes: prior.length >= 4 && recent.length >= 4 && priorMedian !== null && recentMedian !== null ? recentMedian - priorMedian : null }
}

/** Same three evidence-backed highlights as native; older reports retain their original supplied facts. */
export function morningTakeaways(report: SavedMorningReport): MorningTakeaway[] {
  const comparison = verifiedReportComparison(report)
  if (!comparison) {
    return ['health.sleep', 'health.change', 'health.recent', 'health.coverage', 'pod.coverage', 'pod.occupancy', 'health.timing']
      .flatMap(identifier => report.facts.filter(item => item.id === identifier).map(item => ({
        id: identifier, title: reportEvidenceTitles[identifier], text: item.text, badge: 'Saved evidence',
      }))).slice(0, 3)
  }
  const latest = comparison.days.findLast(day => day.minutes !== null)
  const stats = comparisonStatistics(comparison)
  const date = latest ? new Intl.DateTimeFormat('en-US', { timeZone: comparison.timeZone, month: 'short', day: 'numeric' }).format(latest.end) : ''
  const minutes = latest?.minutes === undefined || latest.minutes === null ? null : Math.round(latest.minutes)
  const duration = minutes === null ? '' : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
  return [
    { id: 'latest', title: 'Latest recorded sleep', badge: latest ? 'Source estimate' : 'Missing data',
      text: latest
        ? `${duration} recorded for the sleep day ending ${date}. This may include naps or a partial recording.`
        : 'No recorded sleep in this 14-day view. Missing data does not establish no sleep.' },
    { id: 'comparison', title: 'Compared with the week before', badge: stats.changeMinutes === null ? 'Limited coverage' : 'Same source',
      text: stats.changeMinutes === null
        ? `${stats.recentCount} recorded days in the recent seven and ${stats.priorCount} in the prior seven. At least four in each period are needed for this comparison.`
        : `${Math.round(Math.abs(stats.changeMinutes))} minutes ${stats.changeMinutes >= 0 ? 'more' : 'less'} in the recent seven-day median than the prior seven, using ${stats.recentCount} and ${stats.priorCount} recorded days. This is a descriptive difference.` },
    { id: 'coverage', title: 'How much is recorded', badge: `${stats.observedCount}/14 days`,
      text: `${stats.observedCount} of 14 noon-to-noon days have observations. Unknown days remain gaps; recorded days are not automatically complete nights.` },
  ]
}

import { z } from 'zod'
import { personalHistoryScopeSchema } from './historyApiContract'
import { personalJournalRangeSchema, personalJournalSelectionSchema, personalJournalTimeZoneSchema, type PersonalJournalSelection } from './personalJournalContract'
import { compareJournalContext, journalContextComparisonSchema, type JournalContextObservation } from '@/src/journal/contextPatterns'

const count = z.number().int().min(0).max(90)
const comparison = journalContextComparisonSchema.extend({
  id: z.enum(['caffeine-time', 'alcohol-time', 'exercise-time', 'meal-time', 'stress', 'caffeine-amount', 'alcohol-amount', 'exercise-amount']),
  label: z.string().max(120), withLabel: z.string().max(120), withoutLabel: z.string().max(120),
  withCount: count, withoutCount: count, excludedCount: count, withWarmCount: count, withoutWarmCount: count,
  warmRateDifferencePoints: z.number().min(-100).max(100).nullable(), quantityThreshold: z.number().min(0).max(10_000).nullable(),
}).strict().refine(value => value.withWarmCount <= value.withCount && value.withoutWarmCount <= value.withoutCount
  && value.withCount + value.withoutCount + value.excludedCount <= 90
  && value.warmRateDifferencePoints === (value.withCount >= 5 && value.withoutCount >= 5
    ? Math.round((value.withWarmCount / value.withCount - value.withoutWarmCount / value.withoutCount) * 1000) / 10
    : null),
'Comparison counts and reported difference must agree.')

const cohort = z.object({ timeZone: personalJournalTimeZoneSchema, dates: count, comparisons: z.array(comparison).min(5).max(8) }).strict()
  .refine(value => new Set(value.comparisons.map(item => item.id)).size === value.comparisons.length
    && value.comparisons.every(item => item.withCount + item.withoutCount + item.excludedCount === value.dates),
  'Each comparison must describe the same saved dates.')

export const personalJournalPatternsResponseSchema = z.object({
  version: z.literal(1), generatedAt: z.number().int().min(0).max(253402300799000), scope: personalHistoryScopeSchema,
  interpretation: z.literal('personal_self_report_not_sleep_measurement'),
  query: personalJournalRangeSchema, source: z.literal('personal_journal'), minimumDatesPerGroup: z.literal(5),
  cohorts: z.array(cohort).max(90), note: z.string().max(1_200),
}).strict().refine(value => new Set(value.cohorts.map(item => item.timeZone)).size === value.cohorts.length
  && value.cohorts.reduce((sum, item) => sum + item.dates, 0) <= 90, 'Check-in cohorts must be separate and bounded.')
export type PersonalJournalPatterns = z.infer<typeof personalJournalPatternsResponseSchema>

export function parsePersonalJournalPatternsQuery(search: URLSearchParams) {
  const input: Record<string, string> = {}
  for (const [key, value] of search) {
    if (!['from', 'through'].includes(key) || Object.hasOwn(input, key)) throw new Error('Unsupported comparison query.')
    input[key] = value
  }
  return personalJournalRangeSchema.parse(input)
}

/** Only person-owned saved entries enter these cohorts; notes, imported archives and physical sides are not projected. */
export function personalJournalPatterns(entries: PersonalJournalSelection[], now: number) {
  const grouped = new Map<string, JournalContextObservation[]>()
  const dates = new Set<string>()
  for (const entry of entries) {
    const { record } = personalJournalSelectionSchema.parse(entry)
    if (!record) continue
    if (dates.has(record.date) || record.updatedAt > now) throw new Error('Saved comparison data needs review.')
    dates.add(record.date)
    const observation = { date: record.date, timeZone: record.timeZone,
      fields: { comfort: record.fields.comfort, context: record.fields.context } }
    grouped.set(record.timeZone, [...(grouped.get(record.timeZone) ?? []), observation])
  }
  return {
    source: 'personal_journal' as const, minimumDatesPerGroup: 5 as const,
    cohorts: [...grouped].sort(([first], [second]) => first.localeCompare(second)).map(([timeZone, records]) => ({
      timeZone, ...compareJournalContext(records, now),
    })),
    note: 'Exploratory associations in your reported temperature comfort, not measured sleep or proof of cause. Each difference needs five distinct saved dates in each group within your personal account and one retained time zone. This is a display threshold, not statistical validation. Unlogged, future and after-bedtime observations are excluded from the relevant comparison. Timing bands describe groups, not recommended limits; quantity groups split at the median of logged amounts in this range. Other habits, room conditions, season and routine changes may explain a difference. Preserved legacy records are not pooled. These findings never change the bed or train a model.',
  }
}

import { z } from 'zod'
import type { JournalRecord, JournalSelection } from './contract'
import { contextTimesAreValid, type JournalContext } from './context'

const comparisonSchema = z.object({
  id: z.string(), label: z.string(), withLabel: z.string(), withoutLabel: z.string(),
  withCount: z.number().int().nonnegative(), withoutCount: z.number().int().nonnegative(), excludedCount: z.number().int().nonnegative(),
  withWarmCount: z.number().int().nonnegative(), withoutWarmCount: z.number().int().nonnegative(),
  warmRateDifferencePoints: z.number().nullable(), quantityThreshold: z.number().nullable(),
})
export const journalContextPatternsSchema = z.object({
  cohorts: z.array(z.object({
    side: z.enum(['left', 'right']), origin: z.enum(['sleepypod', 'free-sleep']), timeZone: z.string(),
    dates: z.number().int().nonnegative(), comparisons: z.array(comparisonSchema),
  })).max(90),
  note: z.string(),
})
export type JournalContextPatterns = z.infer<typeof journalContextPatternsSchema>
type ContextRecord = JournalRecord & { fields: JournalRecord['fields'] & { context: JournalContext } }

/** Keep unique recorded dates in source/zone/side cohorts; unknown context never becomes a negative exposure. */
export function journalContextPatterns(entries: JournalSelection[], now: number): JournalContextPatterns {
  const grouped = new Map<string, JournalRecord[]>()
  for (const { record } of entries) {
    if (!record) continue
    const key = JSON.stringify([record.side, record.origin, record.timeZone])
    grouped.set(key, [...(grouped.get(key) ?? []), record])
  }
  const cohorts = [...grouped.values()].map((records) => {
    const dateCounts = new Map<string, number>()
    for (const record of records) dateCounts.set(record.date, (dateCounts.get(record.date) ?? 0) + 1)
    const unique = records.filter(record => dateCounts.get(record.date) === 1)
    const usable = unique.filter((record): record is ContextRecord => Boolean(record.fields.context && contextTimesAreValid(record.fields.context, record.date, record.timeZone, now)))
    const comparisons: z.infer<typeof comparisonSchema>[] = []
    const compare = (id: string, label: string, withLabel: string, withoutLabel: string, classify: (record: ContextRecord) => boolean | undefined, quantityThreshold: number | null = null) => {
      const withGroup: ContextRecord[] = []
      const withoutGroup: ContextRecord[] = []
      for (const record of usable) {
        const included = classify(record)
        if (included === true) withGroup.push(record)
        if (included === false) withoutGroup.push(record)
      }
      const withWarmCount = withGroup.filter(record => record.fields.comfort === 'warm').length
      const withoutWarmCount = withoutGroup.filter(record => record.fields.comfort === 'warm').length
      comparisons.push({ id, label, withLabel, withoutLabel, quantityThreshold,
        withCount: withGroup.length, withoutCount: withoutGroup.length,
        excludedCount: records.length - withGroup.length - withoutGroup.length,
        withWarmCount, withoutWarmCount,
        warmRateDifferencePoints: withGroup.length >= 5 && withoutGroup.length >= 5
          ? Math.round((withWarmCount / withGroup.length - withoutWarmCount / withoutGroup.length) * 1000) / 10
          : null })
    }
    const timed = (habit: 'caffeine' | 'alcohol' | 'exercise' | 'lastMealAt', hours: number) => (record: ContextRecord) => {
      const context = record.fields.context
      const activity = habit === 'lastMealAt' ? context.lastMealAt : context[habit].status === 'yes' ? context[habit].lastAt : undefined
      if (context.bedtimeAt === undefined || activity === undefined || activity > context.bedtimeAt) return undefined
      return context.bedtimeAt - activity <= hours * 3600_000
    }
    compare('caffeine-time', 'Last caffeine relative to bedtime', 'Within 6 hours', 'More than 6 hours before', timed('caffeine', 6))
    compare('alcohol-time', 'Last drink relative to bedtime', 'Within 4 hours', 'More than 4 hours before', timed('alcohol', 4))
    compare('exercise-time', 'Exercise finished relative to bedtime', 'Within 3 hours', 'More than 3 hours before', timed('exercise', 3))
    compare('meal-time', 'Last meal relative to bedtime', 'Within 2 hours', 'More than 2 hours before', timed('lastMealAt', 2))
    compare('stress', 'Stress compared with your usual day', 'Higher', 'Usual or lower', record => record.fields.context.stress === 'not_logged' ? undefined : record.fields.context.stress === 'higher')
    for (const [habit, label, unit] of [['caffeine', 'Caffeine amount', 'mg'], ['alcohol', 'Alcohol amount', 'US standard drinks'], ['exercise', 'Exercise duration', 'min']] as const) {
      const amounts = usable.flatMap((record) => {
        const value = record.fields.context[habit]
        return value.status === 'yes' && value.amount !== undefined ? [value.amount] : []
      }).sort((first, second) => first - second)
      if (!amounts.length) continue
      const middle = Math.floor(amounts.length / 2)
      const median = amounts.length % 2 ? amounts[middle] : (amounts[middle - 1] + amounts[middle]) / 2
      compare(`${habit}-amount`, label, `Above ${median} ${unit}`, `${median} ${unit} or below`, (record) => {
        const value = record.fields.context[habit]
        return value.status === 'yes' && value.amount !== undefined ? value.amount > median : undefined
      }, median)
    }
    const first = records[0]
    return { side: first.side, origin: first.origin, timeZone: first.timeZone, dates: unique.length, comparisons }
  })
  return { cohorts, note: 'Exploratory associations in your reported temperature comfort, not measured sleep or proof of cause. Each result needs five distinct dates in each group within one side, source and time zone. Missing, duplicate, future and after-bedtime observations are excluded. Timing bands are comparison definitions, not recommended limits; amount splits use the median of logged amounts in this range. Other habits, room conditions and schedule changes may explain a difference. These findings do not change the bed.' }
}

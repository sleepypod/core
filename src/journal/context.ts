import { z } from 'zod'
import { historyDayStart, shiftHistoryDate, sourceDate } from '@/src/lib/localDates'

const milliseconds = z.number().int().nonnegative().max(253402300799000)
const status = z.enum(['not_logged', 'none', 'yes'])

function observationSchema<Quantity extends 'milligrams' | 'usStandardDrinks' | 'minutes'>(quantity: Quantity, maximum: number) {
  return z.object({
    status,
    lastAt: milliseconds.optional(),
    amount: z.number().min(0).max(maximum).optional(),
    unit: z.literal(quantity),
  }).strict().refine(value => value.status === 'yes' || (value.lastAt === undefined && value.amount === undefined),
    'Timing and quantity require a logged habit')
}

/** Explicit missingness keeps an untouched field distinct from a reported absence. */
export const journalContextSchema = z.object({
  version: z.literal(1),
  bedtimeAt: milliseconds.optional(),
  caffeine: observationSchema('milligrams', 10_000),
  alcohol: observationSchema('usStandardDrinks', 100),
  exercise: observationSchema('minutes', 1440),
  lastMealAt: milliseconds.optional(),
  stress: z.enum(['not_logged', 'lower', 'usual', 'higher']),
}).strict()
export type JournalContext = z.infer<typeof journalContextSchema>
export const journalHabits = ['caffeine', 'alcohol', 'exercise'] as const

/** Entries describe the preceding day and wake date in their retained source zone. */
export function contextTimesAreValid(context: JournalContext, date: string, timeZone: string, now: number): boolean {
  if (!Number.isSafeInteger(now) || now < 0) return false
  try {
    if (date > sourceDate(now / 1000, timeZone)) return false
    const start = historyDayStart(shiftHistoryDate(date, -1), timeZone)
    const end = historyDayStart(shiftHistoryDate(date, 1), timeZone)
    const times = [...journalHabits.map(habit => context[habit].lastAt), context.lastMealAt, context.bedtimeAt]
    return times.every(value => value === undefined || (value >= start && value < end && value <= now))
  }
  catch { return false }
}

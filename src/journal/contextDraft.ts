import type { JournalFields } from './contract'
import { contextTimesAreValid, journalContextSchema, journalHabits, type JournalContext } from './context'
import { journalWallTime, journalWallTimeCandidates } from './contextClock'

export type JournalHabit = typeof journalHabits[number]
export type ContextTimeKey = JournalHabit | 'bedtimeAt' | 'lastMealAt'
export interface ContextTimeDraft { value: string, occurrence?: number }
export interface JournalContextDraft {
  habits: Record<JournalHabit, { status: JournalContext[JournalHabit]['status'], amount: string }>
  times: Record<ContextTimeKey, ContextTimeDraft>
  stress: JournalContext['stress']
}
const timing = (instant: number | undefined, timeZone: string): ContextTimeDraft => instant === undefined ? { value: '' } : { value: journalWallTime(instant, timeZone), occurrence: Math.floor(instant / 60_000) * 60_000 }

/** Older unchecked switches do not establish an explicitly reported absence. */
export function journalContextDraft(fields: JournalFields, timeZone: string): JournalContextDraft {
  const context = fields.context
  const habit = (name: JournalHabit) => ({ status: context?.[name].status ?? (fields[name] ? 'yes' : 'not_logged'), amount: context?.[name].amount?.toString() ?? '' })
  return { habits: { caffeine: habit('caffeine'), alcohol: habit('alcohol'), exercise: habit('exercise') }, stress: context?.stress ?? 'not_logged',
    times: { caffeine: timing(context?.caffeine.lastAt, timeZone), alcohol: timing(context?.alcohol.lastAt, timeZone), exercise: timing(context?.exercise.lastAt, timeZone), bedtimeAt: timing(context?.bedtimeAt, timeZone), lastMealAt: timing(context?.lastMealAt, timeZone) } }
}

export function parseJournalContextDraft(draft: JournalContextDraft, date: string, timeZone: string, now: number): { context?: JournalContext, error?: string } {
  const times: Partial<Record<ContextTimeKey, number>> = {}
  for (const name of ['bedtimeAt', 'lastMealAt', ...journalHabits] as const) {
    if (journalHabits.includes(name as JournalHabit) && draft.habits[name as JournalHabit].status !== 'yes') continue
    const entry = draft.times[name]
    if (!entry.value) continue
    const candidates = journalWallTimeCandidates(entry.value, timeZone)
    if (!candidates.length) return { error: 'One of these times does not exist in this entry’s time zone. Check the date and time.' }
    const chosen = candidates.length === 1 ? candidates[0] : candidates.find(instant => instant === entry.occurrence)
    if (chosen === undefined) return { error: 'A clock time occurs twice when daylight saving ends. Choose the earlier or later occurrence below that field.' }
    times[name] = chosen
  }
  const observation = (habit: JournalHabit, unit: string) => {
    const value = draft.habits[habit]
    return value.status === 'yes' ? { status: value.status, unit, amount: value.amount.trim() ? Number(value.amount) : undefined, lastAt: times[habit] } : { status: value.status, unit }
  }
  const result = journalContextSchema.safeParse({ version: 1, bedtimeAt: times.bedtimeAt, lastMealAt: times.lastMealAt, stress: draft.stress,
    caffeine: observation('caffeine', 'milligrams'), alcohol: observation('alcohol', 'usStandardDrinks'), exercise: observation('exercise', 'minutes') })
  if (!result.success) return { error: 'Enter a valid nonnegative amount, or leave it blank if unknown. Maximums are 10,000 mg, 100 US standard drinks and 1,440 minutes.' }
  if (!contextTimesAreValid(result.data, date, timeZone, now)) return { error: 'Use a time in the day before this wake date or the wake date itself. Future times cannot be saved.' }
  return { context: result.data }
}

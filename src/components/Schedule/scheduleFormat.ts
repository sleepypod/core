import type { DayOfWeek } from '@/src/lib/scheduleTime'

/** Mon-first order used by every day picker and range label in the schedule UI. */
export const DAY_ORDER: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

export const DAY_SHORT: Record<DayOfWeek, string> = {
  sunday: 'Sun', monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed',
  thursday: 'Thu', friday: 'Fri', saturday: 'Sat',
}

/** Accessible names for the DayPicker buttons (Mon-first). */
export const DAY_PICKER_LABELS = DAY_ORDER.map(d => DAY_SHORT[d])

export const WEEKDAYS: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
export const WEEKENDS: DayOfWeek[] = ['saturday', 'sunday']

/**
 * Human-readable day range, e.g.
 *   Mon, Tue, Wed     → "Mon–Wed"
 *   Mon, Wed, Fri     → "Mon, Wed, Fri"
 *   Sat, Sun          → "Sat, Sun" (or "Weekends" with `named`)
 *   all 7             → "Every day"
 */
export function formatDayRange(days: Iterable<DayOfWeek>, { named = false }: { named?: boolean } = {}): string {
  const set = new Set(days)
  if (set.size === 0) return ''
  if (set.size === 7) return 'Every day'
  if (named && set.size === 5 && WEEKDAYS.every(d => set.has(d))) return 'Weekdays'
  if (named && set.size === 2 && WEEKENDS.every(d => set.has(d))) return 'Weekends'

  const ordered = DAY_ORDER.filter(d => set.has(d))
  const indices = ordered.map(d => DAY_ORDER.indexOf(d))
  const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1)
  if (isContiguous && ordered.length > 2) {
    return `${DAY_SHORT[ordered[0]]}–${DAY_SHORT[ordered[ordered.length - 1]]}`
  }
  return ordered.map(d => DAY_SHORT[d]).join(', ')
}

/** DayOfWeek set → Mon-first DayPicker indexes. */
export function daysToIndexes(days: Iterable<DayOfWeek>): number[] {
  const set = new Set(days)
  return DAY_ORDER.flatMap((d, i) => (set.has(d) ? [i] : []))
}

/** Mon-first DayPicker indexes → DayOfWeek list. */
export function indexesToDays(indexes: number[]): DayOfWeek[] {
  return indexes.map(i => DAY_ORDER[i]).filter((d): d is DayOfWeek => d !== undefined)
}

export function sameDays(a: Iterable<DayOfWeek>, b: Iterable<DayOfWeek>): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every(d => sb.has(d))
}

/* ─── Temperature tone ──────────────────────────────────────────────────
   Set points below the 80°F neutral read as cooling, above as warming. */
export type TempTone = 'cool' | 'warm' | 'neutral'

export const NEUTRAL_TEMP_F = 80

export function tempTone(tempF: number): TempTone {
  if (tempF < NEUTRAL_TEMP_F) return 'cool'
  if (tempF > NEUTRAL_TEMP_F) return 'warm'
  return 'neutral'
}

export const TONE_VAR: Record<TempTone, string> = {
  cool: 'var(--accent-cool)',
  warm: 'var(--accent-warm)',
  neutral: 'var(--accent-neutral)',
}

export const TONE_TEXT: Record<TempTone, string> = {
  cool: 'text-cool',
  warm: 'text-warm',
  neutral: 'text-hold',
}

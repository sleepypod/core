export const DAYS = [
  { key: 'sunday', short: 'S', label: 'Sun' },
  { key: 'monday', short: 'M', label: 'Mon' },
  { key: 'tuesday', short: 'T', label: 'Tue' },
  { key: 'wednesday', short: 'W', label: 'Wed' },
  { key: 'thursday', short: 'T', label: 'Thu' },
  { key: 'friday', short: 'F', label: 'Fri' },
  { key: 'saturday', short: 'S', label: 'Sat' },
] as const

export type DayOfWeek = (typeof DAYS)[number]['key']

/** Predefined day groups for "Apply to" shortcuts */
export const DAY_GROUPS = {
  weekdays: new Set<DayOfWeek>(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']),
  weekends: new Set<DayOfWeek>(['saturday', 'sunday']),
  allDays: new Set<DayOfWeek>(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']),
}

/**
 * Get the current day of week as a DayOfWeek string.
 * Adjusts for early morning (before 4am counts as previous day).
 */
export function getCurrentDay(): DayOfWeek {
  const now = new Date()
  const adjusted = new Date(now)
  if (now.getHours() < 4) {
    adjusted.setDate(adjusted.getDate() - 1)
  }
  const dayIndex = adjusted.getDay()
  return DAYS[dayIndex].key
}

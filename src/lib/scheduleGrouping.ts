import type { DayOfWeek } from '@/src/components/Schedule/DaySelector'

export interface SetPoint {
  time: string
  temperature: number
}

export interface ScheduleGroup {
  /** Fingerprint string for this set of set points */
  key: string
  /** Days sharing this identical curve */
  days: DayOfWeek[]
  /** The shared set points (sorted by time), empty for "no schedule" */
  setPoints: SetPoint[]
  /** True when the day has schedules but all are disabled */
  allDisabled?: boolean
}

const ALL_DAYS: DayOfWeek[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

/**
 * Build a deterministic fingerprint for a set of temperature set points.
 * Points are sorted by time then temperature so that ordering in the DB
 * doesn't affect grouping.
 */
function fingerprint(points: SetPoint[]): string {
  if (points.length === 0) return '__empty__'
  const sorted = [...points].sort((a, b) =>
    a.time.localeCompare(b.time) || a.temperature - b.temperature,
  )
  return sorted.map(p => `${p.time}@${p.temperature}`).join('|')
}

/**
 * Sort set points chronologically with overnight wrap detection.
 * For schedules spanning midnight (e.g. 22:00 -> 00:30 -> 06:00),
 * early-morning times are shifted by +24h so they sort after evening times.
 */
export function sortChronological(points: SetPoint[]): SetPoint[] {
  if (points.length <= 1) return [...points]

  const withMinutes = points.map((p) => {
    const [h, m] = p.time.split(':').map(Number)
    return { ...p, minutes: h * 60 + m }
  })

  // Detect overnight wrap: check if times span across midnight
  // by looking for a gap > 12 hours between consecutive sorted times
  const byClock = [...withMinutes].sort((a, b) => a.minutes - b.minutes)
  let isOvernight = false
  const HALF_DAY = 12 * 60

  // If we have times both before and after noon with a large gap, it's overnight
  const hasEarlyMorning = byClock.some(p => p.minutes < HALF_DAY)
  const hasEvening = byClock.some(p => p.minutes >= HALF_DAY)
  if (hasEarlyMorning && hasEvening) {
    // Check for a gap > 12h between any consecutive pair
    for (let i = 0; i < byClock.length - 1; i++) {
      if (byClock[i + 1].minutes - byClock[i].minutes > HALF_DAY) {
        isOvernight = true
        break
      }
    }
  }

  if (isOvernight) {
    // Shift early-morning times by +24h for sorting, then restore original order
    const adjusted = withMinutes.map(p => ({
      ...p,
      sortMinutes: p.minutes < HALF_DAY ? p.minutes + 24 * 60 : p.minutes,
    }))
    adjusted.sort((a, b) => a.sortMinutes - b.sortMinutes)
    return adjusted.map(({ time, temperature }) => ({ time, temperature }))
  }

  // Normal daytime schedule — plain chronological sort
  return byClock.map(({ time, temperature }) => ({ time, temperature }))
}

/**
 * Group the 7 days of the week by identical temperature set point lists.
 *
 * @param temperatureSchedules - all temperature schedules for one side (from getAll)
 * @returns groups sorted by number of days descending, then by earliest day
 */
export function groupDaysBySharedCurve(
  temperatureSchedules: Array<{
    dayOfWeek: string
    time: string
    temperature: number
    enabled: boolean
  }>,
): ScheduleGroup[] {
  // Collect enabled set points per day (used for the rendered curve)
  const enabledByDay = new Map<DayOfWeek, SetPoint[]>()
  // Collect ALL saved set points per day (used to keep paused-day curves distinct)
  const allByDay = new Map<DayOfWeek, SetPoint[]>()
  for (const day of ALL_DAYS) {
    enabledByDay.set(day, [])
    allByDay.set(day, [])
  }

  for (const s of temperatureSchedules) {
    const day = s.dayOfWeek as DayOfWeek
    allByDay.get(day)?.push({ time: s.time, temperature: s.temperature })
    if (!s.enabled) continue
    enabledByDay.get(day)?.push({ time: s.time, temperature: s.temperature })
  }

  // Group days by fingerprint. Paused days fingerprint by their saved curve
  // prefixed with a marker, so two days that "share" being paused only group
  // together when their saved set points actually match.
  const groups = new Map<string, { days: DayOfWeek[], setPoints: SetPoint[], allDisabled?: boolean }>()

  for (const day of ALL_DAYS) {
    const enabled = enabledByDay.get(day) ?? []
    const all = allByDay.get(day) ?? []
    const isPaused = enabled.length === 0 && all.length > 0

    const fp = isPaused ? `__disabled__:${fingerprint(all)}` : fingerprint(enabled)
    // For paused days, render the saved curve (sorted) so the user still
    // sees what's defined; we just mark it as disabled.
    const sourcePoints = isPaused ? all : enabled

    const existing = groups.get(fp)
    if (existing) {
      existing.days.push(day)
    }
    else {
      const sorted = sortChronological(sourcePoints)
      groups.set(fp, {
        days: [day],
        setPoints: sorted,
        ...(isPaused ? { allDisabled: true } : {}),
      })
    }
  }

  // Convert to array and sort: most days first, then by earliest day index
  return Array.from(groups.entries())
    .map(([key, group]) => ({
      key,
      days: group.days,
      setPoints: group.setPoints,
      ...(group.allDisabled ? { allDisabled: true } : {}),
    }))
    .sort((a, b) => {
      // Active curves first, then disabled, then truly empty
      const aRank = a.setPoints.length > 0 ? 0 : a.allDisabled ? 1 : 2
      const bRank = b.setPoints.length > 0 ? 0 : b.allDisabled ? 1 : 2
      if (aRank !== bRank) return aRank - bRank
      // More days first
      if (b.days.length !== a.days.length) return b.days.length - a.days.length
      // Earliest day index as tiebreaker
      const aIdx = ALL_DAYS.indexOf(a.days[0])
      const bIdx = ALL_DAYS.indexOf(b.days[0])
      return aIdx - bIdx
    })
}

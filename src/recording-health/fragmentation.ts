import type { Side } from '@/src/hardware/types'

type Interval = [number, number]
export interface PresenceRecordEvidence {
  side: Side
  start: number
  end: number
  present: unknown
  absent: unknown
}
export interface PresenceBreakAssessment {
  observedAt: number
  status: 'read' | 'partial' | 'unavailable'
  sides: Array<{
    side: Side
    records: number
    discarded: number
    reportedPresenceSeconds: number
    shortBreaks: number
    mostInOneHour: number
  }>
}
export const PRESENCE_BREAK_WINDOW_MS = 24 * 3_600_000
export const PRESENCE_BREAK_REVIEW_COUNT = 3
export const PRESENCE_BREAK_POLICY = 'completed-interval-breaks-v1'
const MAX_INTERVALS = 2000
const MAX_RECORDS_PER_SIDE = 200

function union(intervals: Interval[]): Interval[] {
  const result: Interval[] = []
  for (const interval of [...intervals].sort((first, second) => first[0] - second[0])) {
    const previous = result.at(-1)
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
    else result.push([...interval])
  }
  return result
}

/** These are the detector's explicit reported intervals, never reconstructed sleep or signal coverage. */
function intervals(raw: unknown, start: number, end: number, now: number): Interval[] | null {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 64 * 1024) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  }
  catch { return null }
  if (!Array.isArray(value) || value.length > MAX_INTERVALS) return null
  const result: Interval[] = []
  // Python floors record boundary columns, while JSON retains fractional frame times.
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !entry.every(value => typeof value === 'number' && Number.isFinite(value))
      || entry[0] < start || entry[1] >= end + 1 || entry[1] > now || entry[0] >= entry[1]) return null
    result.push([entry[0], entry[1]])
  }
  return union(result)
}

function nonConflictingBreaks(present: Interval[], absent: Interval[]): Interval[] {
  let cursor = 0
  return absent.filter((gap) => {
    while (cursor < present.length && present[cursor][1] <= gap[0]) cursor++
    return cursor === present.length || present[cursor][0] >= gap[1]
  })
}

/** Flag clusters of short explicit absences. Gaps between records are unknown, not inferred exits. */
export function assessPresenceBreaks(rows: PresenceRecordEvidence[], now: number, partial = false): PresenceBreakAssessment {
  if (!Number.isSafeInteger(now) || now < 0) return { observedAt: 0, status: 'unavailable', sides: [] }
  const start = (now - PRESENCE_BREAK_WINDOW_MS) / 1000, end = now / 1000
  const sides = (['left', 'right'] as const).map((side) => {
    const present: Interval[] = [], absent: Interval[] = []
    let records = 0, discarded = 0
    const selected = rows.filter(row => row.side === side)
    if (selected.length > MAX_RECORDS_PER_SIDE) partial = true
    for (const row of selected.slice(0, MAX_RECORDS_PER_SIDE)) {
      if (!Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || row.start < 0
        || row.end <= row.start || row.end > end || row.end - row.start > 72 * 3600) {
        discarded++
        continue
      }
      if (row.end < start) continue
      const foundPresent = intervals(row.present, row.start, row.end, end)
      const foundAbsent = intervals(row.absent, row.start, row.end, end)
      if (!foundPresent?.length || !foundAbsent || nonConflictingBreaks(foundPresent, foundAbsent).length !== foundAbsent.length
        || present.length + absent.length + foundPresent.length + foundAbsent.length > 8000) {
        discarded++
        continue
      }
      records++
      present.push(...foundPresent)
      absent.push(...foundAbsent)
    }
    const reported = union(present), recordedBreaks = union(absent)
    // Contradictory overlapping records cannot manufacture a trustworthy exit.
    const consistent = nonConflictingBreaks(reported, recordedBreaks)
    discarded += recordedBreaks.length - consistent.length
    const presenceStarts = new Set(reported.map(value => value[0])), presenceEnds = new Set(reported.map(value => value[1]))
    const short = consistent.filter(gap => gap[0] >= start && gap[1] <= end
      && gap[1] - gap[0] >= 30 && gap[1] - gap[0] <= 120
      && presenceEnds.has(gap[0]) && presenceStarts.has(gap[1]))
    let mostInOneHour = 0, first = 0
    for (let last = 0; last < short.length; last++) {
      while (short[last][0] - short[first][0] >= 3600) first++
      mostInOneHour = Math.max(mostInOneHour, last - first + 1)
    }
    const reportedPresenceSeconds = reported.reduce((sum, interval) => sum + Math.max(0, Math.min(end, interval[1]) - Math.max(start, interval[0])), 0)
    return { side, records, discarded, reportedPresenceSeconds, shortBreaks: short.length, mostInOneHour }
  })
  return { observedAt: now, status: partial || sides.some(side => side.discarded > 0) ? 'partial' : 'read', sides }
}

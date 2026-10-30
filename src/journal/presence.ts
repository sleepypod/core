import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { HISTORY_MAX_INTERVAL_BYTES } from '@/src/history/contract'
import { historyIntervals } from '@/src/history/intervals'
import { historyDayStart, shiftHistoryDate, sourceDate } from '@/src/lib/localDates'

export interface JournalPresence {
  status: 'ready' | 'unavailable' | 'not_imported' | 'too_many_records'
  timeZone: string | null
  minutes: Map<string, number>
}
interface PresenceRow { id: number, entered_bed_at: number, left_bed_at: number, bytes: number }

/** Bound archive work before loading interval JSON, then union records by their source-local wake date. */
export function readJournalPresence(database: Database.Database, side: Side, from: string, through: string, timeZone: string, now = Date.now()): JournalPresence {
  const start = historyDayStart(from, timeZone) / 1000
  const end = Math.min(historyDayStart(shiftHistoryDate(through, 1), timeZone), now) / 1000
  return database.transaction((): JournalPresence => {
    const rows = database.prepare(`SELECT id,entered_bed_at,left_bed_at,length(CAST(present_intervals AS BLOB)) AS bytes
      FROM sleep_records WHERE side=? AND left_bed_at>=? AND left_bed_at<? ORDER BY left_bed_at,id LIMIT 1001`)
      .all(side, start, end) as PresenceRow[]
    const totalBytes = rows.reduce((sum, row) => sum + (row.bytes <= HISTORY_MAX_INTERVAL_BYTES ? row.bytes : 0), 0)
    if (rows.length > 1000 || totalBytes > 8 * 1024 * 1024) return { status: 'too_many_records', timeZone, minutes: new Map() }
    const dates = new Map<string, Array<[number, number]> | null>()
    for (const row of rows) {
      if (!Number.isSafeInteger(row.left_bed_at)) continue
      const date = sourceDate(row.left_bed_at, timeZone)
      if (dates.get(date) === null) continue
      if (!Number.isSafeInteger(row.entered_bed_at) || row.entered_bed_at < 0 || row.entered_bed_at >= row.left_bed_at || row.bytes > HISTORY_MAX_INTERVAL_BYTES) {
        dates.set(date, null)
        continue
      }
      const raw = database.prepare('SELECT present_intervals FROM sleep_records WHERE id=? AND side=?').get(row.id, side) as { present_intervals: unknown }
      const parsed = historyIntervals(raw.present_intervals, row.bytes, row.entered_bed_at, row.left_bed_at)
      if (!parsed.intervals) dates.set(date, null)
      else dates.set(date, [...(dates.get(date) ?? []), ...parsed.intervals])
    }
    const minutes = new Map<string, number>()
    for (const [date, intervals] of dates) {
      if (!intervals?.length) continue
      intervals.sort((first, second) => first[0] - second[0])
      let total = 0
      let end = intervals[0][0]
      for (const [start, stop] of intervals) {
        total += Math.max(0, stop - Math.max(start, end))
        end = Math.max(end, stop)
      }
      // Implausibly long grouped dates remain unknown, rather than dominating an average.
      if (total <= 72 * 3600) minutes.set(date, total / 60)
    }
    return { status: 'ready', timeZone, minutes }
  })()
}

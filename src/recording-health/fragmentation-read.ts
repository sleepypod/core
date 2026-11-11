import type Database from 'better-sqlite3'
import { assessPresenceBreaks, PRESENCE_BREAK_WINDOW_MS, type PresenceBreakAssessment, type PresenceRecordEvidence } from './fragmentation'

interface RecordMetadata { id: number, entered_bed_at: number, left_bed_at: number, presentBytes: number | null, absentBytes: number | null }
const ROW_LIMIT = 200
const FIELD_LIMIT = 64 * 1024
const TOTAL_LIMIT = 2 * 1024 * 1024

/** Bound both indexed rows and JSON bytes before loading completed detector evidence. No writes. */
export function readPresenceBreaks(database: Database.Database, now: number): PresenceBreakAssessment {
  if (!Number.isSafeInteger(now) || now < 0) return { observedAt: 0, status: 'unavailable', sides: [] }
  try {
    return database.transaction(() => {
      const evidence: PresenceRecordEvidence[] = []
      let partial = false, usedBytes = 0
      for (const side of ['left', 'right'] as const) {
        const rows = database.prepare(`SELECT id,entered_bed_at,left_bed_at,
          length(CAST(present_intervals AS BLOB)) AS presentBytes,
          length(CAST(not_present_intervals AS BLOB)) AS absentBytes
          FROM sleep_records WHERE side=? AND entered_bed_at>=? AND entered_bed_at<=? AND left_bed_at>?
          ORDER BY entered_bed_at DESC,id DESC LIMIT ?`).all(side,
          (now - PRESENCE_BREAK_WINDOW_MS) / 1000 - 72 * 3600, now / 1000,
          (now - PRESENCE_BREAK_WINDOW_MS) / 1000, ROW_LIMIT + 1) as RecordMetadata[]
        if (rows.length > ROW_LIMIT) partial = true
        for (const row of rows.slice(0, ROW_LIMIT)) {
          if (row.presentBytes === null || row.absentBytes === null || row.presentBytes > FIELD_LIMIT || row.absentBytes > FIELD_LIMIT
            || row.presentBytes + row.absentBytes + usedBytes > TOTAL_LIMIT) {
            partial = true
            continue
          }
          usedBytes += row.presentBytes + row.absentBytes
          const raw = database.prepare('SELECT present_intervals,not_present_intervals FROM sleep_records WHERE id=? AND side=?')
            .get(row.id, side) as { present_intervals: unknown, not_present_intervals: unknown }
          evidence.push({ side, start: row.entered_bed_at, end: row.left_bed_at, present: raw.present_intervals, absent: raw.not_present_intervals })
        }
      }
      return assessPresenceBreaks(evidence, now, partial)
    })()
  }
  catch { return { observedAt: now, status: 'unavailable', sides: [] } }
}

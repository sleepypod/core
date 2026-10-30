import { synchronizeJournalComfort } from '@/src/journal/store'
import { durableTransaction } from '@/src/db/durable'
import { previewReportId } from './report-evidence'
import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { comfortEventSchema, comfortFeedbackSchema, comfortStateSchema, type ComfortEvent } from './contract'
import { defaultComfortState, type ComfortFeedback, type ComfortState } from './policy'
import { comfortLocalDate } from './policy'
import { thermalDataset } from './thermal-dataset'
import { evaluateThermalLearning, type ThermalContext, type ThermalLearning, type ThermalNight } from './thermal-learning'

export interface ComfortStore {
  read(side: Side): ComfortState
  commit(side: Side, state: ComfortState, event?: ComfortEvent, durable?: boolean): void
  history(side: Side): ComfortEvent[]
  feedback(side: Side): ComfortFeedback[]
  saveFeedback(side: Side, feedback: ComfortFeedback, event: ComfortEvent): void
  prune(now: number): void
  learning?(side: Side, context: ThermalContext | null, timezone: string, now: number): ThermalLearning
}

/** Missing rows default OFF; malformed persisted data must fail closed, never reset silently. */
export function createComfortStore(database: Database.Database): ComfortStore {
  const datasetCache: Partial<Record<Side, { at: number, nights: ThermalNight[] }>> = {}
  return {
    learning(side, context, timezone, now) {
      let cached = datasetCache[side]
      if (!cached || now < cached.at || now - cached.at >= 300000) {
        cached = { at: now, nights: thermalDataset(database, side, now) }
        datasetCache[side] = cached
      }
      return evaluateThermalLearning(cached.nights, context, comfortLocalDate(now, timezone))
    },
    read(side) {
      const row = database.prepare('SELECT state FROM comfort_states WHERE side = ?').get(side) as { state: string } | undefined
      return row ? comfortStateSchema.parse(JSON.parse(row.state)) : defaultComfortState()
    },
    commit(side, state, event, durable = false) {
      const encoded = JSON.stringify(comfortStateSchema.parse(state))
      const eventJson = event ? JSON.stringify(comfortEventSchema.parse(event)) : null
      const write = () => {
        database.prepare('INSERT INTO comfort_states (side, state) VALUES (?, ?) ON CONFLICT(side) DO UPDATE SET state = excluded.state').run(side, encoded)
        if (event && eventJson) database.prepare('INSERT INTO comfort_events (side, observed_at, event, report_id) VALUES (?, ?, ?, ?)').run(side, event.at, eventJson, event.preview ? previewReportId(event.preview) : null)
      }
      if (durable) durableTransaction(database, write)
      else database.transaction(write)()
    },
    history(side) {
      const rows = database.prepare('SELECT event FROM comfort_events WHERE side = ? ORDER BY observed_at DESC, id DESC LIMIT 60').all(side) as { event: string }[]
      return rows.map(row => comfortEventSchema.parse(JSON.parse(row.event)))
    },
    feedback(side) {
      const rows = database.prepare('SELECT local_date AS date, comfort FROM comfort_feedback WHERE side = ? ORDER BY local_date DESC LIMIT 60').all(side)
      return rows.map(row => comfortFeedbackSchema.parse(row))
    },
    saveFeedback(side, feedback, event) {
      datasetCache[side] = undefined
      const report = comfortFeedbackSchema.parse(feedback)
      const encoded = JSON.stringify(comfortEventSchema.parse(event))
      database.transaction(() => {
        database.prepare(`INSERT INTO comfort_feedback (side, local_date, comfort, recorded_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(side, local_date) DO UPDATE SET comfort = excluded.comfort, recorded_at = excluded.recorded_at`).run(side, report.date, report.comfort, event.at)
        synchronizeJournalComfort(database, side, report.date, report.comfort, event.at)
        database.prepare('INSERT INTO comfort_events (side, observed_at, event) VALUES (?, ?, ?)').run(side, event.at, encoded)
      })()
    },
    prune(now) {
      database.transaction(() => {
        // Sparse research observations need enough history for chronological validation.
        database.prepare(`DELETE FROM comfort_events WHERE observed_at < ? OR
          (observed_at < ? AND json_extract(event, '$.thermalContext') IS NULL)`)
          .run(now - 90 * 86_400_000, now - 30 * 86_400_000)
        for (const side of ['left', 'right']) {
          database.prepare(`DELETE FROM comfort_events WHERE side = ? AND id NOT IN
            (SELECT id FROM comfort_events WHERE side = ? ORDER BY observed_at DESC, id DESC LIMIT 50000)
            AND id NOT IN (SELECT id FROM comfort_events WHERE side = ?
              AND json_extract(event, '$.thermalContext') IS NOT NULL
              ORDER BY observed_at DESC, id DESC LIMIT 26000)`).run(side, side, side)
        }
      })()
    },
  }
}

export { comfortEvent } from './event'

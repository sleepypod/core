import type Database from 'better-sqlite3'
import { z } from 'zod'
import { MECHANICAL_FRESH_MS, mechanicalStateSchema } from './context'

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const mechanicalSpanSchema = z.object({ id: z.string().uuid(), epoch: z.string().uuid(),
  startMs: time, endMs: time }).strict().refine(span => span.startMs <= span.endMs)
export const mechanicalSnapshotSchema = z.object({ state: mechanicalStateSchema,
  spans: z.array(mechanicalSpanSchema).max(64) }).strict()

/** Bounded read-only snapshot, shared by diagnostics and prospective capture. */
export function readMechanicalSnapshot(database: Database.Database, now: number) {
  try {
    return database.transaction(() => {
      const row = database.prepare('SELECT CASE WHEN length(CAST(payload AS BLOB)) <= 8192 THEN payload END AS payload FROM biometric_mechanical_state WHERE id=1').get() as { payload: string } | undefined
      if (!row || !Number.isSafeInteger(now)) return null
      const state = mechanicalStateSchema.parse(JSON.parse(row.payload))
      if (state.publishedAtMs > now || now - state.publishedAtMs >= MECHANICAL_FRESH_MS) return null
      const spans = database.prepare('SELECT id, epoch, start_ms AS startMs, end_ms AS endMs FROM biometric_mechanical_spans WHERE end_ms >= ? AND end_ms <= ? ORDER BY end_ms DESC, id DESC LIMIT 64').all(now - 600_000, now)
      return mechanicalSnapshotSchema.parse({ state, spans })
    })()
  }
  catch { return null }
}

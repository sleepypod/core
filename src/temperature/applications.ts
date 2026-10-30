import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { Side } from '@/src/hardware/types'

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000)
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const temperatureApplicationInputSchema = z.object({
  side: z.enum(['left', 'right']),
  targetF: z.number().min(55).max(110),
  durationSec: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  reason: z.enum(['manual', 'power_on', 'reconcile', 'keepalive']),
  source: z.enum(['manual', 'run-once', 'autopilot', 'schedule']).nullable(),
  requestId: z.string().min(1).max(2000).nullable(),
}).strict()
export type TemperatureApplicationInput = z.infer<typeof temperatureApplicationInputSchema>
export interface TemperatureApplicationReceipt {
  attemptId: string
  attemptedAt: number
  finishedAt: number | null
  outcome: 'acknowledged' | 'unknown'
}
export type RecordTemperatureApplication = (input: TemperatureApplicationInput, apply: () => Promise<void>) => Promise<TemperatureApplicationReceipt>

export const temperatureApplicationSchema = temperatureApplicationInputSchema.extend({
  id: positiveId, attemptId: z.string().uuid(), attemptedAt: timestamp, finishedAt: timestamp.nullable(),
  outcome: z.enum(['attempting', 'acknowledged', 'unknown']),
  acknowledgment: z.enum(['accepted_not_physically_verified', 'unconfirmed']),
}).refine(value => value.finishedAt === null || value.finishedAt >= value.attemptedAt, 'Invalid completion clock')
  .refine(value => value.outcome !== 'acknowledged' || value.finishedAt !== null, 'Missing acknowledgment clock')
export const temperatureApplicationQuerySchema = z.object({
  side: z.enum(['left', 'right']), beforeId: positiveId.optional(),
}).strict()
export const temperatureApplicationsSchema = z.object({
  apiVersion: z.literal(1), generatedAt: timestamp, side: z.enum(['left', 'right']),
  items: z.array(temperatureApplicationSchema), nextBeforeId: positiveId.nullable(),
})

const RETENTION_MS = 30 * 86_400_000
const MAX_ROWS_PER_SIDE = 10_000
const PAGE_SIZE = 50
interface ApplicationRow { id: number, attemptId: string, attemptedAt: number, finishedAt: number | null, outcome: string, request: string }

/** Journal before dispatch. An interrupted or partly completed write never becomes an acknowledgment. */
export function createTemperatureApplicationRecorder(database: Database.Database, now = Date.now): RecordTemperatureApplication {
  return async (input, apply) => {
    const request = temperatureApplicationInputSchema.parse(input)
    const attemptedAt = timestamp.parse(now())
    const attemptId = randomUUID()
    database.transaction(() => {
      database.prepare('DELETE FROM temperature_applications WHERE attempted_at < ?').run(attemptedAt - RETENTION_MS)
      database.prepare(`DELETE FROM temperature_applications WHERE side = ? AND id NOT IN
        (SELECT id FROM temperature_applications WHERE side = ? ORDER BY id DESC LIMIT ?)`).run(request.side, request.side, MAX_ROWS_PER_SIDE - 1)
      database.prepare(`INSERT INTO temperature_applications (attempt_id, side, attempted_at, outcome, request)
        VALUES (?, ?, ?, 'attempting', ?)`).run(attemptId, request.side, attemptedAt, JSON.stringify(request))
    })()
    const unknown = () => {
      let finishedAt: number | null = null
      // The durable attempting row stays unresolved if storage also prevents this update.
      try {
        const observedAt = now()
        finishedAt = Number.isSafeInteger(observedAt) && observedAt >= attemptedAt && observedAt <= 8_640_000_000_000_000 ? observedAt : null
        database.prepare(`UPDATE temperature_applications SET outcome = 'unknown', finished_at = ?
          WHERE attempt_id = ? AND outcome = 'attempting'`).run(finishedAt, attemptId)
      }
      catch { /* Never replace the control error with an audit-storage error. */ }
      return { attemptId, attemptedAt, finishedAt, outcome: 'unknown' as const }
    }
    try {
      await apply()
    }
    catch (error) {
      unknown()
      throw error
    }
    try {
      const finishedAt = timestamp.parse(now())
      if (finishedAt < attemptedAt) throw new Error('Temperature application clock moved backwards')
      const result = database.prepare(`UPDATE temperature_applications SET outcome = 'acknowledged', finished_at = ?
        WHERE attempt_id = ? AND outcome = 'attempting'`).run(finishedAt, attemptId)
      if (result.changes !== 1) throw new Error('Temperature application receipt was not retained')
      return { attemptId, attemptedAt, finishedAt, outcome: 'acknowledged' }
    }
    catch {
      const result = unknown()
      // The write itself succeeded. Do not roll back the owner's hold or provoke
      // another command just because recording its result failed.
      console.warn('[temperature] Application result could not be durably confirmed; inspect temperature application history.')
      return result
    }
  }
}

/** Read-only, side-scoped pagination. No controller, sensor or hardware is started by a history read. */
export function readTemperatureApplications(database: Database.Database, side: Side, beforeId?: number, now = Date.now()) {
  temperatureApplicationQuerySchema.parse({ side, beforeId })
  timestamp.parse(now)
  const rows = database.prepare(`SELECT id, attempt_id AS attemptId, attempted_at AS attemptedAt,
    finished_at AS finishedAt, outcome, request FROM temperature_applications
    WHERE side = ? AND id < ? AND attempted_at >= ? ORDER BY id DESC LIMIT ?`)
    .all(side, beforeId ?? Number.MAX_SAFE_INTEGER, now - RETENTION_MS, PAGE_SIZE + 1) as ApplicationRow[]
  const items = rows.slice(0, PAGE_SIZE).map((row) => {
    const input = temperatureApplicationInputSchema.parse(JSON.parse(row.request))
    if (input.side !== side) throw new Error('Temperature application side mismatch')
    return temperatureApplicationSchema.parse({ ...input, id: row.id, attemptId: row.attemptId,
      attemptedAt: row.attemptedAt, finishedAt: row.finishedAt, outcome: row.outcome,
      acknowledgment: row.outcome === 'acknowledged' ? 'accepted_not_physically_verified' : 'unconfirmed' })
  })
  return temperatureApplicationsSchema.parse({ apiVersion: 1, generatedAt: now, side, items,
    nextBeforeId: rows.length > PAGE_SIZE ? items.at(-1)?.id ?? null : null })
}

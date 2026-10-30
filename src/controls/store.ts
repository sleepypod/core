import type Database from 'better-sqlite3'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { controlReceipts } from '@/src/db/schema'

export type ControlRow = typeof controlReceipts.$inferSelect
export type TerminalControlState = Exclude<ControlRow['state'], 'executing'>
export class ControlConflictError extends Error {}

export interface ControlStore {
  claim: (row: ControlRow) => {
    created: boolean
    row: ControlRow
  }
  get: (requestId: string) => ControlRow | undefined
  dispatch: (requestId: string, runId: string, at: number) => void
  finish: (requestId: string, runId: string, state: TerminalControlState, reason: string | null, at: number) => ControlRow
}

/** Commit intent with FULL sync before actuation, even when ordinary app writes use NORMAL. */
export function createControlStore(sqlite: Database.Database): ControlStore {
  const database = drizzle(sqlite)
  function durable<T>(operation: () => T): T {
    if (sqlite.inTransaction) throw new Error('Control receipt requires an independent durable transaction')
    const previous = sqlite.pragma('synchronous', { simple: true }) as number
    sqlite.pragma('synchronous = FULL')
    try {
      return sqlite.transaction(operation).immediate()
    }
    finally {
      sqlite.pragma(`synchronous = ${previous}`)
    }
  }
  const get = (requestId: string) => database.select().from(controlReceipts).where(eq(controlReceipts.requestId, requestId)).get()
  const owned = (requestId: string, runId: string) => and(eq(controlReceipts.requestId, requestId), eq(controlReceipts.runId, runId), eq(controlReceipts.state, 'executing'))
  return {
    get,
    claim: row => durable(() => {
      const existing = get(row.requestId)
      if (existing) {
        if (existing.fingerprint !== row.fingerprint) throw new ControlConflictError('Request ID already belongs to a different control request')
        return { created: false, row: existing }
      }
      database.insert(controlReceipts).values(row).run()
      return { created: true, row }
    }),
    dispatch: (requestId, runId, at) => durable(() => {
      const result = database.update(controlReceipts).set({
        dispatchCount: sql`${controlReceipts.dispatchCount} + 1`, lastDispatchAt: at,
      }).where(owned(requestId, runId)).run()
      if (result.changes !== 1) throw new Error('Control dispatch receipt was not committed')
    }),
    finish: (requestId, runId, state, reason, at) => durable(() => {
      const result = database.update(controlReceipts).set({ state, reason, finishedAt: at }).where(owned(requestId, runId)).returning().get()
      if (!result) throw new Error('Control completion receipt was not committed')
      return result
    }),
  }
}

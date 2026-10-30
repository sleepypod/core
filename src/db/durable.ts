import type Database from 'better-sqlite3'

/** Flush intent before an external effect, even when ordinary app writes use NORMAL. */
export function durableTransaction<Result>(database: Database.Database, operation: () => Result): Result {
  if (database.inTransaction) throw new Error('A durable write requires an independent transaction')
  const previous = database.pragma('synchronous', { simple: true }) as number
  database.pragma('synchronous = FULL')
  try {
    return database.transaction(operation).immediate()
  }
  finally { database.pragma(`synchronous = ${previous}`) }
}

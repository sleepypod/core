import path from 'node:path'
import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { markFirmwareSynced } from '@/src/hardware/sideMutations'

/** Integration fixtures use the shipped migrations, including persisted control state. */
export function resetControlDatabase(sqlite: Database.Database): void {
  const globals = globalThis as Record<string, unknown>
  delete globals.__sp_temperatureController
  // The controller trusts device_state only after the firmware has reported
  // in; integration tests model a running pod unless they reset this.
  markFirmwareSynced()
  sqlite.pragma('foreign_keys = OFF')
  const tables = sqlite.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name NOT LIKE \'sqlite_%\'').all() as Array<{ name: string }>
  for (const { name } of tables) sqlite.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`)
  migrate(drizzle(sqlite), { migrationsFolder: path.resolve('src/db/migrations') })
  sqlite.pragma('foreign_keys = ON')
}

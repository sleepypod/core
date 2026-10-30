import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

export function migratedComfortDatabase(filename = ':memory:') {
  const database = new Database(filename)
  migrate(drizzle(database), { migrationsFolder: path.resolve('src/db/migrations') })
  return database
}

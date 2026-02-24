import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

// Database file path (configurable via environment)
const DB_PATH = process.env.DATABASE_URL?.replace('file:', '') || './sleepypod.dev.db'

// Initialize SQLite connection
export const sqlite = new Database(DB_PATH)

// Enable SQLite optimizations
sqlite.pragma('journal_mode = WAL') // Write-Ahead Logging for better concurrency
sqlite.pragma('synchronous = NORMAL') // Faster writes, still safe
sqlite.pragma('cache_size = -64000') // 64MB cache
sqlite.pragma('temp_store = MEMORY') // In-memory temp tables
sqlite.pragma('mmap_size = 268435456') // 256MB memory-mapped I/O (embedded-friendly)
sqlite.pragma('foreign_keys = ON') // Enable foreign key constraints

// Initialize Drizzle ORM
export const db = drizzle(sqlite, { schema })

/**
 * Close the database connection.
 * Called by the centralized shutdown coordinator in instrumentation.ts.
 */
export function closeDatabase(): void {
  console.log('Closing database connection...')
  sqlite.close()
}

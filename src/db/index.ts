import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

// Database file path (configurable via environment)
const DB_PATH = process.env.DATABASE_URL?.replace('file:', '') || './sleepypod.db'

// Initialize SQLite connection
export const sqlite = new Database(DB_PATH)

// Enable SQLite optimizations
sqlite.pragma('journal_mode = WAL') // Write-Ahead Logging for better concurrency
sqlite.pragma('synchronous = NORMAL') // Faster writes, still safe
sqlite.pragma('cache_size = -64000') // 64MB cache
sqlite.pragma('temp_store = MEMORY') // In-memory temp tables
sqlite.pragma('mmap_size = 30000000000') // 30GB memory-mapped I/O
sqlite.pragma('page_size = 4096') // 4KB pages
sqlite.pragma('foreign_keys = ON') // Enable foreign key constraints

// Initialize Drizzle ORM
export const db = drizzle(sqlite, { schema })

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Closing database connection...')
  sqlite.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('Closing database connection...')
  sqlite.close()
  process.exit(0)
})

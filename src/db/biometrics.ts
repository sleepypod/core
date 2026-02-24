import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as biometricsSchema from './biometrics-schema'

const BIOMETRICS_DB_PATH
  = process.env.BIOMETRICS_DATABASE_URL?.replace('file:', '')
    ?? './biometrics.dev.db'

const sqliteBiometrics = new Database(BIOMETRICS_DB_PATH)

// WAL mode: allows concurrent reads while a module holds the write lock
sqliteBiometrics.pragma('journal_mode = WAL')
// Wait up to 5s if another module is writing, rather than failing immediately
sqliteBiometrics.pragma('busy_timeout = 5000')
sqliteBiometrics.pragma('synchronous = NORMAL')
sqliteBiometrics.pragma('cache_size = -32000') // 32MB — smaller than main DB
sqliteBiometrics.pragma('temp_store = MEMORY')
sqliteBiometrics.pragma('mmap_size = 134217728') // 128MB

export const biometricsDb = drizzle(sqliteBiometrics, { schema: biometricsSchema })

export function closeBiometricsDatabase(): void {
  console.log('Closing biometrics database connection...')
  sqliteBiometrics.close()
}

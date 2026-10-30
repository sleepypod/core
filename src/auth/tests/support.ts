import type * as FileSystem from 'node:fs'
import type DatabaseConstructor from 'better-sqlite3'
import { afterEach, beforeEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Route tests may mock their application database. Access checks still read a
// real, isolated privacy boundary instead of depending on a checkout database.
const { mkdtempSync, rmSync } = await vi.importActual<typeof FileSystem>('node:fs')
const { default: PrivacyDatabase } = await vi.importActual<{ default: typeof DatabaseConstructor }>('better-sqlite3')
let privacyDirectory: string
let previousDatabasePath: string | undefined
beforeEach(() => {
  previousDatabasePath = process.env.DATABASE_URL
  privacyDirectory = mkdtempSync(join(tmpdir(), 'sleepypod-legacy-access-'))
  const path = join(privacyDirectory, 'privacy.db')
  const database = new PrivacyDatabase(path)
  database.exec('CREATE TABLE household_privacy_boundary (id INTEGER PRIMARY KEY, required_at INTEGER NOT NULL, reason TEXT NOT NULL)')
  database.close()
  vi.stubEnv('DATABASE_URL', path)
})
afterEach(() => {
  rmSync(privacyDirectory, { recursive: true, force: true })
  if (previousDatabasePath === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = previousDatabasePath
})

export const TEST_OWNER_TOKEN = 'test-only-sleepypod-owner-key-not-for-production'

export function ownerRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${TEST_OWNER_TOKEN}`)
  return new Request(input, { ...init, headers })
}

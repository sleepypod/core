// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabaseIntegrity, startDatabaseIntegrityChecks, stopDatabaseIntegrityChecks } from '../integrity'

let directory: string
let databasePath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-integrity-'))
  databasePath = join(directory, 'config.db')
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`)
  delete (globalThis as Record<string, unknown>).__sp_database_integrity__
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  await stopDatabaseIntegrityChecks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).__sp_database_integrity__
  rmSync(directory, { recursive: true, force: true })
})

describe('database integrity worker integration', () => {
  it('checks a real database without modifying its contents', async () => {
    const database = new Database(databasePath)
    database.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO test (value) VALUES (\'saved settings\')')
    database.close()
    const before = readFileSync(databasePath)

    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(getDatabaseIntegrity().status).toBe('ok'), { timeout: 5_000 })

    expect(getDatabaseIntegrity().checkedAt).not.toBeNull()
    expect(readFileSync(databasePath)).toEqual(before)
  })

  it('surfaces a corrupt database as degraded from the worker result', async () => {
    writeFileSync(databasePath, Buffer.alloc(4_096, 0x7f))
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(getDatabaseIntegrity().status).toBe('degraded'), { timeout: 5_000 })

    expect(getDatabaseIntegrity().error).toMatch(/not a database|malformed/i)
  })
})

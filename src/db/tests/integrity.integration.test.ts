// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDatabaseIntegrity, getDatabaseIntegrityByDb, startDatabaseIntegrityChecks, stopDatabaseIntegrityChecks } from '../integrity'

let directory: string
let databasePath: string
let biometricsPath: string

function createDatabase(path: string) {
  const database = new Database(path)
  database.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO test (value) VALUES (\'saved settings\')')
  database.close()
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-integrity-'))
  databasePath = join(directory, 'config.db')
  biometricsPath = join(directory, 'biometrics.db')
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`)
  vi.stubEnv('BIOMETRICS_DATABASE_URL', `file:${biometricsPath}`)
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
  it('checks both real databases without modifying their contents', async () => {
    createDatabase(databasePath)
    createDatabase(biometricsPath)
    const before = readFileSync(databasePath)
    const biometricsBefore = readFileSync(biometricsPath)

    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(getDatabaseIntegrity().status).toBe('ok'), { timeout: 5_000 })

    const byDb = getDatabaseIntegrityByDb()
    expect(byDb.sleepypod).toMatchObject({ status: 'ok', checkedAt: expect.any(String) })
    expect(byDb.biometrics).toMatchObject({ status: 'ok', checkedAt: expect.any(String) })
    expect(getDatabaseIntegrity().checkedAt).not.toBeNull()
    expect(readFileSync(databasePath)).toEqual(before)
    expect(readFileSync(biometricsPath)).toEqual(biometricsBefore)
  })

  it('surfaces a corrupt database as degraded from the worker result', async () => {
    writeFileSync(databasePath, Buffer.alloc(4_096, 0x7f))
    createDatabase(biometricsPath)
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(getDatabaseIntegrity().status).toBe('degraded'), { timeout: 5_000 })

    expect(getDatabaseIntegrity().error).toMatch(/^sleepypod\.db: .*(not a database|malformed)/i)
    expect(getDatabaseIntegrityByDb().biometrics.status).toBe('ok')
  })

  it('names biometrics.db when that file is corrupt or missing', async () => {
    createDatabase(databasePath)
    writeFileSync(biometricsPath, Buffer.alloc(4_096, 0x7f))
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(getDatabaseIntegrity().status).toBe('degraded'), { timeout: 5_000 })
    expect(getDatabaseIntegrity().error).toMatch(/^biometrics\.db: .*(not a database|malformed)/i)
    expect(getDatabaseIntegrityByDb().sleepypod.status).toBe('ok')

    rmSync(biometricsPath)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await vi.waitFor(() => expect(getDatabaseIntegrity().error).toMatch(/^biometrics\.db: .*unable to open/i), { timeout: 5_000 })
  })
})

// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'sp-dbinspect-'))
const HOUR = 3_600_000

beforeAll(() => {
  const now = Date.now()
  const main = new Database(join(dir, 'sleepypod.db'))
  main.pragma('journal_mode = WAL')
  main.exec(`
    CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at NUMERIC);
    CREATE TABLE automation_runs (id INTEGER PRIMARY KEY, fired_at INTEGER NOT NULL);
    CREATE TABLE device_settings (id INTEGER PRIMARY KEY, mqtt_password TEXT);
  `)
  main.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('h', 1)
  const run = main.prepare('INSERT INTO automation_runs (fired_at) VALUES (?)')
  for (let i = 0; i < 30; i++) run.run(now - i * 10 * 60_000) // ms, every 10 min for 5 h
  main.close()

  const bio = new Database(join(dir, 'biometrics.db'))
  bio.exec(`
    CREATE TABLE vitals (id INTEGER PRIMARY KEY, side TEXT, timestamp INTEGER NOT NULL);
    CREATE TABLE sleep_records (id INTEGER PRIMARY KEY, entered_bed_at INTEGER, left_bed_at INTEGER);
    CREATE TABLE ambient_light (id INTEGER PRIMARY KEY, timestamp INTEGER, lux REAL);
  `)
  const v = bio.prepare('INSERT INTO vitals (side, timestamp) VALUES (?, ?)')
  for (let i = 0; i < 12; i++) v.run('left', Math.floor((now - 3 * HOUR - i * 5 * 60_000) / 1000)) // seconds
  bio.prepare('INSERT INTO sleep_records (entered_bed_at, left_bed_at) VALUES (?, ?)').run(Math.floor((now - 5 * HOUR) / 1000), Math.floor(now / 1000))
  bio.close()

  vi.stubEnv('DATABASE_URL', `file:${join(dir, 'sleepypod.db')}`)
  vi.stubEnv('BIOMETRICS_DATABASE_URL', `file:${join(dir, 'biometrics.db')}`)
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('inspectDatabases', () => {
  it('reports rows, bytes, last write and hourly writes per table for both files', async () => {
    const { inspectDatabases } = await import('../dbInspect')
    const r = await inspectDatabases(true)
    const main = r.databases.find(d => d.key === 'sleepypod') as NonNullable<typeof r.databases[number]>
    const bio = r.databases.find(d => d.key === 'biometrics') as NonNullable<typeof r.databases[number]>

    expect(main.appliedMigrations).toBe(1)
    expect(main.tables.map(t => t.name)).toEqual(['automation_runs', 'device_settings'])
    const runs = main.tables[0]
    expect(runs).toMatchObject({ rows: 30, timeColumn: 'fired_at', timeInMs: true, rows24h: 30 })
    expect(runs.bytes).toBeGreaterThan(0)
    expect(runs.hourly.reduce((a, b) => a + b, 0)).toBe(30)
    expect(runs.hourly[23]).toBeGreaterThan(0)

    const vitals = bio.tables.find(t => t.name === 'vitals') as NonNullable<typeof bio.tables[number]>
    expect(vitals).toMatchObject({ rows: 12, timeInMs: false, rows24h: 12 })
    expect(vitals.lastWriteAt).toBeGreaterThan(Date.now() - 4 * HOUR)
    expect(vitals.hourly[23]).toBe(0)
    expect(bio.tables.find(t => t.name === 'ambient_light')).toMatchObject({ rows: 0, lastWriteAt: null })
    // In bed for the last 5 hours → the last 5–6 hourly buckets are occupied.
    expect(r.occupiedHours).toContain(23)
    expect(r.occupiedHours).toContain(19)
    expect(r.occupiedHours).not.toContain(10)
  })

  it('caches between calls unless asked for a fresh scan', async () => {
    const { inspectDatabases } = await import('../dbInspect')
    const a = await inspectDatabases()
    expect(await inspectDatabases()).toBe(a)
    expect(await inspectDatabases(true)).not.toBe(a)
  })
})

describe('runIntegrityChecks', () => {
  it('quick_checks both databases and remembers the result', async () => {
    const { manualIntegrity, runIntegrityChecks } = await import('../dbInspect')
    const runs = await runIntegrityChecks()
    expect(runs.sleepypod?.status).toBe('ok')
    expect(runs.biometrics?.status).toBe('ok')
    expect(manualIntegrity().biometrics?.checkedAt).toBe(runs.biometrics?.checkedAt)
  })
})

describe('migrationInfo', () => {
  it('reads the shipped journal and names the applied migration', async () => {
    const { migrationInfo } = await import('../dbInspect')
    const info = await migrationInfo('sleepypod', null)
    expect(info.known).toBeGreaterThan(10)
    expect(info.latestTag).toMatch(/^\d{4}_/)
    expect(info.appliedTag).toBeNull()
  })
})

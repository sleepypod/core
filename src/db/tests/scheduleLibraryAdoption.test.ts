/**
 * runMigrations on real in-memory databases: a pod upgrading from before the
 * schedule library (0028) gets its schedules adopted exactly once.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../schema'
import * as biometricsSchema from '../biometrics-schema'

const holder = vi.hoisted(() => ({ main: null as unknown, sqlite: null as unknown, biometrics: null as unknown }))

vi.mock('../index', () => ({
  get db() { return holder.main },
  get sqlite() { return holder.sqlite },
}))
vi.mock('../biometrics', () => ({
  get biometricsDb() { return holder.biometrics },
  closeBiometricsDatabase: vi.fn(),
}))
vi.mock('@/src/scheduler', () => ({ getJobManager: vi.fn() }))

const { runMigrations } = await import('../migrate')

const MIGRATIONS = path.resolve(process.cwd(), 'src/db/migrations')

function marker(raw: Database.Database) {
  return raw.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'schedule_library_adoption\'').get()
}

describe('schedule library adoption on upgrade', () => {
  let raw: Database.Database
  let bio: Database.Database
  let tmpDir: string

  beforeEach(() => {
    raw = new Database(':memory:')
    bio = new Database(':memory:')
    holder.sqlite = raw
    holder.main = drizzle(raw, { schema })
    holder.biometrics = drizzle(bio, { schema: biometricsSchema })
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-library-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    raw.close()
    bio.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('leaves the marker after a fresh full migration', () => {
    migrate(drizzle(raw, { schema }), { migrationsFolder: MIGRATIONS })
    expect(marker(raw)).toBeDefined()
    expect(raw.prepare('SELECT count(*) AS n FROM schedule_library_adoption').get()).toEqual({ n: 1 })
  })

  it('adopts pre-library schedules on the upgrade and drops the marker, then never again', async () => {
    // Migrate to the release before the library, as an existing pod would be.
    fs.cpSync(MIGRATIONS, tmpDir, { recursive: true })
    const journalPath = path.join(tmpDir, 'meta/_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as { entries: Array<{ tag: string }> }
    journal.entries = journal.entries.filter(e => e.tag < '0028')
    fs.writeFileSync(journalPath, JSON.stringify(journal))
    migrate(drizzle(raw, { schema }), { migrationsFolder: tmpDir })
    for (const day of ['monday', 'tuesday']) {
      raw.prepare('INSERT INTO temperature_schedules (side, day_of_week, time, temperature) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
        .run('left', day, '22:00', 70, 'left', day, '06:30', 78)
    }

    await runMigrations()

    expect(marker(raw)).toBeUndefined()
    const curves = raw.prepare('SELECT name, left_days AS leftDays, active FROM curve_templates').all()
    expect(curves).toEqual([{ name: 'Left schedule', leftDays: '["monday","tuesday"]', active: 1 }])
    expect(console.log).toHaveBeenCalledWith('✓ Added 1 existing schedule to the schedule library')

    // Later schedules written row by row stay out of the library.
    raw.prepare('INSERT INTO temperature_schedules (side, day_of_week, time, temperature) VALUES (?, ?, ?, ?)').run('right', 'friday', '23:00', 72)
    await runMigrations()
    expect(raw.prepare('SELECT count(*) AS n FROM curve_templates').get()).toEqual({ n: 1 })
  })

  it('keeps the marker when adoption fails, so the next start retries', async () => {
    migrate(drizzle(raw, { schema }), { migrationsFolder: MIGRATIONS })
    raw.exec('DROP TABLE side_settings')
    raw.prepare('INSERT INTO temperature_schedules (side, day_of_week, time, temperature) VALUES (?, ?, ?, ?)').run('left', 'monday', '22:00', 70)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runMigrations()).resolves.toBeUndefined()

    expect(error).toHaveBeenCalledWith(expect.stringContaining('retrying on next start'), expect.any(Error))
    expect(marker(raw)).toBeDefined()
    expect(raw.prepare('SELECT count(*) AS n FROM curve_templates').get()).toEqual({ n: 0 })
  })
})

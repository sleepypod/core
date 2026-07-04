import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { describe, expect, it } from 'vitest'
import * as biometricsSchema from '../biometrics-schema'
import * as schema from '../schema'

describe('migrations smoke test', () => {
  it('main DB migrations apply cleanly from empty', () => {
    const raw = new Database(':memory:')
    try {
      const db = drizzle(raw, { schema })
      expect(() => migrate(db, {
        migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations'),
      })).not.toThrow()

      // Smoke-check that the unique index added in this PR actually exists
      const idx = raw.prepare(
        'SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'uq_tap_side_type\'',
      ).get() as { name?: string } | undefined
      expect(idx?.name).toBe('uq_tap_side_type')
    }
    finally {
      raw.close()
    }
  })

  it('biometrics DB migrations apply cleanly from empty', () => {
    const raw = new Database(':memory:')
    try {
      const db = drizzle(raw, { schema: biometricsSchema })
      expect(() => migrate(db, {
        migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations'),
      })).not.toThrow()

      // After 0007 runs the redundant idx_vitals_side_timestamp must be gone
      const rows = raw.prepare(
        'SELECT name FROM sqlite_master WHERE type = \'index\' AND tbl_name = \'vitals\' ORDER BY name',
      ).all() as Array<{ name: string }>
      const names = rows.map(r => r.name)
      expect(names).toContain('uq_vitals_side_timestamp')
      expect(names).not.toContain('idx_vitals_side_timestamp')
    }
    finally {
      raw.close()
    }
  })

  it('biometrics journal timestamps are strictly increasing', () => {
    // Drizzle's migrator skips any entry whose `when` is <= the max recorded
    // created_at, so a hand-edited out-of-order journal silently drops
    // migrations on incremental upgrades (pods stuck mid-history).
    const journal = JSON.parse(fs.readFileSync(
      path.resolve(process.cwd(), 'src/db/biometrics-migrations/meta/_journal.json'),
      'utf-8',
    )) as { entries: Array<{ idx: number, when: number, tag: string }> }

    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]
      const curr = journal.entries[i]
      expect(curr.when, `journal entry ${curr.tag} must have when > ${prev.tag}`)
        .toBeGreaterThan(prev.when)
    }
  })

  it('biometrics DB upgrades incrementally from a db stopped at 0003', () => {
    // Simulate a pod that last migrated at 0003_sensor_calibration, then
    // receives an update with the full migration history. All of 0004+ must
    // apply — with the old out-of-order journal they were silently skipped.
    const migrationsDir = path.resolve(process.cwd(), 'src/db/biometrics-migrations')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biometrics-partial-'))
    const raw = new Database(':memory:')
    try {
      // Build a partial migrations folder containing only entries 0000–0003
      fs.cpSync(migrationsDir, tmpDir, { recursive: true })
      const journalPath = path.join(tmpDir, 'meta/_journal.json')
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
        entries: Array<{ idx: number }>
      }
      journal.entries = journal.entries.filter(e => e.idx <= 3)
      fs.writeFileSync(journalPath, JSON.stringify(journal))

      const db = drizzle(raw, { schema: biometricsSchema })
      migrate(db, { migrationsFolder: tmpDir })

      const tableNames = () => (raw.prepare(
        'SELECT name FROM sqlite_master WHERE type = \'table\' ORDER BY name',
      ).all() as Array<{ name: string }>).map(r => r.name)
      expect(tableNames()).not.toContain('water_level_readings')

      // Incremental upgrade: run the real migrator over the same db
      expect(() => migrate(db, { migrationsFolder: migrationsDir })).not.toThrow()

      const after = tableNames()
      expect(after).toContain('water_level_readings')
      expect(after).toContain('ambient_light')
      expect(after).toContain('water_level_alerts')
    }
    finally {
      raw.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('main DB unique index dedups existing duplicates', () => {
    const raw = new Database(':memory:')
    try {
      // Apply ALL migrations (including 0006 which creates uq_tap_side_type).
      // Then drop the index, insert duplicate rows, and replay the dedup SQL
      // — this simulates upgrade-from-old-schema where duplicates predated
      // the unique index and the migration must clean them up.
      const db = drizzle(raw, { schema })
      migrate(db, {
        migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations'),
      })

      // Drop the freshly-created unique index so we can insert duplicates,
      // then re-run the DELETE-then-create statements the migration uses.
      raw.exec('DROP INDEX uq_tap_side_type')
      const insertStmt = raw.prepare(
        'INSERT INTO tap_gestures (side, tap_type, action_type) VALUES (?, ?, ?)',
      )
      insertStmt.run('left', 'doubleTap', 'temperature')
      insertStmt.run('left', 'doubleTap', 'alarm') // duplicate
      insertStmt.run('right', 'tripleTap', 'temperature')

      expect(raw.prepare('SELECT COUNT(*) AS n FROM tap_gestures').get())
        .toEqual({ n: 3 })

      // Apply the dedup + unique index statements from 0006
      raw.exec(`
        DELETE FROM tap_gestures
        WHERE id NOT IN (
          SELECT MAX(id) FROM tap_gestures GROUP BY side, tap_type
        );
        CREATE UNIQUE INDEX uq_tap_side_type ON tap_gestures (side, tap_type);
      `)

      const remaining = raw.prepare(
        'SELECT side, tap_type, action_type FROM tap_gestures ORDER BY side, tap_type',
      ).all() as Array<{ side: string, tap_type: string, action_type: string }>
      expect(remaining).toHaveLength(2)
      // MAX(id) wins: the 'alarm' duplicate is the one that stays
      expect(remaining[0]).toEqual({ side: 'left', tap_type: 'doubleTap', action_type: 'alarm' })
      expect(remaining[1]).toEqual({ side: 'right', tap_type: 'tripleTap', action_type: 'temperature' })
    }
    finally {
      raw.close()
    }
  })
})

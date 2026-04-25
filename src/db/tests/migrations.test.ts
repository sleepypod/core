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

  it('main DB unique index dedups existing duplicates', () => {
    const raw = new Database(':memory:')
    try {
      // Apply all migrations EXCEPT the last one (which creates the unique index).
      // We simulate upgrade-from-old-schema: create tap_gestures manually and
      // insert duplicate rows before running 0006.
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

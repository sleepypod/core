// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ExportManifest } from './download'
import { checkSnapshotSchema, mergeSnapshot, migrationJournal, MIGRATIONS_FOLDER, openArchiveDatabase, TABLES } from './merge'

let root: string
let archive: Database.Database
const open: Database.Database[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'biometrics-archive-merge-'))
  archive = openArchiveDatabase(join(root, 'archive.db'))
})
afterEach(() => {
  archive.close()
  for (const db of open.splice(0)) db.close()
  rmSync(root, { recursive: true, force: true })
})

const journal = migrationJournal()
let snapshots = 0
function snapshot(fill: (db: Database.Database) => void, migrationsFolder = MIGRATIONS_FOLDER) {
  const path = join(root, `snapshot-${++snapshots}.db`)
  const db = new Database(path)
  migrate(drizzle(db), { migrationsFolder })
  fill(db)
  db.close()
  return path
}
function manifest(generatedAtMs: number, entry = journal[journal.length - 1]) {
  return {
    generatedAtMs, generatedAt: new Date(generatedAtMs).toISOString(),
    files: [{ role: 'database', path: 'biometrics.db', bytes: 0, sha256: randomBytes(32).toString('hex') }],
    schema: { biometrics: { migrationHash: 'h', migrationCreatedAt: entry.when, migrationTag: entry.tag, appliedMigrations: 1 } },
  } as unknown as ExportManifest
}
const merge = (path: string, generatedAtMs: number, entry?: (typeof journal)[number]) =>
  mergeSnapshot(archive, path, manifest(generatedAtMs, entry), { pullKey: `pod/pulls/${generatedAtMs}.json`, nowMs: generatedAtMs, occupiedArchiveNames: new Set() })
const rows = (sql: string) => archive.prepare(sql).all()
function vitals(db: Database.Database, side: string, timestamps: number[], heartRate = 60) {
  for (const ts of timestamps) {
    const id = db.prepare('INSERT INTO vitals (side, timestamp, heart_rate) VALUES (?, ?, ?)').run(side, ts, heartRate).lastInsertRowid
    db.prepare('INSERT INTO vitals_quality (vitals_id, side, timestamp, quality_score, created_at) VALUES (?, ?, ?, 0.9, ?)').run(id, side, ts, ts)
  }
}

it('has a merge rule, with a unique key in the archive, for every table the migrations create', () => {
  const tables = (rows('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' AND name NOT LIKE \'archive_%\' AND name != \'__drizzle_migrations\'') as Array<{ name: string }>)
    .map(row => row.name).sort()
  expect(TABLES.map(spec => spec.table).sort()).toEqual(tables)
  const indexed = rows('SELECT name FROM sqlite_master WHERE type = \'index\' AND name LIKE \'archive_uq_%\'') as Array<{ name: string }>
  expect(indexed.map(row => row.name).sort()).toEqual(['calibration_runs', 'flash_write_samples', 'health_runs', 'movement', 'prime_events', 'pump_alerts',
    'sleep_records', 'thermal_state', 'vitals_quality', 'water_level_alerts'].map(name => `archive_uq_${name}`))
})

it('gives rows new ids after a pod database reset and keeps vitals_quality pointing at its vitals row', () => {
  merge(snapshot(db => vitals(db, 'left', [100, 160, 220])), 1)
  const result = merge(snapshot(db => vitals(db, 'left', [10_000, 10_060])), 2)
  expect(result.tables.vitals).toMatchObject({ snapshot: 2, inserted: 0, reassigned: 2, conflicts: 0 })
  expect(rows('SELECT v.timestamp, q.timestamp AS qualityTimestamp FROM vitals_quality q JOIN vitals v ON v.id = q.vitals_id ORDER BY v.timestamp'))
    .toEqual([100, 160, 220, 10_000, 10_060].map(ts => ({ timestamp: ts, qualityTimestamp: ts })))
})

it('keeps the first copy of an append-only row and records a changed copy once', () => {
  merge(snapshot(db => vitals(db, 'left', [100], 60)), 1)
  const changed = snapshot(db => vitals(db, 'left', [100], 72))
  expect(merge(changed, 2).tables.vitals).toMatchObject({ inserted: 0, ignored: 1, conflicts: 1 })
  expect(merge(changed, 3).tables.vitals).toMatchObject({ conflicts: 0 })
  expect(rows('SELECT heart_rate AS hr FROM vitals')).toEqual([{ hr: 60 }])
  const [conflict] = rows('SELECT table_name, reason, key, archive_row, snapshot_row FROM archive_conflicts') as Array<Record<string, string>>
  expect(conflict).toMatchObject({ table_name: 'vitals', reason: 'changed', key: '{"side":"left","timestamp":100}' })
  expect(JSON.parse(conflict.archive_row).heart_rate).toBe(60)
  expect(JSON.parse(conflict.snapshot_row).heart_rate).toBe(72)
})

it('keeps calibration runs the pod logged in the same second as separate rows', () => {
  const runs = (db: Database.Database) => {
    const insert = db.prepare(`INSERT INTO calibration_runs (side, sensor_type, status, error_message, duration_ms, triggered_by, created_at)
      VALUES ('left', 'piezo', 'failed', 'No piezo records available', ?, ?, 1777925137)`)
    insert.run(4, 'startup')
    insert.run(6, 'daily')
  }
  const path = snapshot(runs)
  expect(merge(path, 1).tables.calibration_runs).toMatchObject({ inserted: 2, conflicts: 0 })
  expect(merge(path, 2).tables.calibration_runs).toMatchObject({ inserted: 0, ignored: 2, conflicts: 0 })
})

it('takes the newest snapshot\'s values for state tables, but keeps a released dataset\'s content', () => {
  const dataset = (db: Database.Database, snapshotText: string, releasedAtMs: number | null) => db.prepare(`INSERT INTO biometric_datasets
    (id, side, subject_id, idempotency_key, request_hash, content_hash, manifest, snapshot, byte_length, created_at_ms, released_at_ms)
    VALUES ('ds-1', 'left', 'me', 'k', 'r', 'c', '{}', ?, ?, 1, ?)`).run(snapshotText, snapshotText.length, releasedAtMs)
  const health = (db: Database.Database, lastSeenAt: number) => db.prepare('INSERT INTO health_runs (check_id, status, started_at, last_seen_at) VALUES (\'disk\', \'ok\', 10, ?)').run(lastSeenAt)
  merge(snapshot((db) => {
    dataset(db, '{"nights":[1,2]}', null)
    health(db, 20)
  }), 1000)
  const released = snapshot((db) => {
    dataset(db, '{"released":true}', 5000)
    health(db, 90)
  })
  const older = snapshot(db => health(db, 50))
  expect(merge(released, 2000).tables.health_runs).toMatchObject({ updated: 1 })
  expect(merge(older, 1500).tables.health_runs).toMatchObject({ updated: 0, conflicts: 0 })
  expect(rows('SELECT last_seen_at AS lastSeenAt FROM health_runs')).toEqual([{ lastSeenAt: 90 }])
  expect(rows('SELECT snapshot, byte_length AS bytes, released_at_ms AS releasedAtMs FROM biometric_datasets'))
    .toEqual([{ snapshot: '{"nights":[1,2]}', bytes: 16, releasedAtMs: 5000 }])
})

it('merges a snapshot from an older schema and refuses one newer than the checkout', () => {
  const folder = join(root, 'migrations')
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true })
  const old = journal[19]
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'sqlite', entries: journal.slice(0, 20) }))
  const path = snapshot(db => vitals(db, 'right', [500, 560]), folder)
  expect(checkSnapshotSchema(manifest(1, old).schema.biometrics)).toMatchObject({ known: true })
  const result = merge(path, 1, old)
  expect(result.tables.vitals).toMatchObject({ inserted: 2 })
  expect(result.tables.biometric_datasets).toBeUndefined()
  expect(rows('SELECT side, processing_run_id AS run FROM vitals')).toEqual([{ side: 'right', run: null }, { side: 'right', run: null }])

  const latest = journal[journal.length - 1]
  expect(() => checkSnapshotSchema({ migrationHash: 'h', migrationCreatedAt: latest.when + 1, migrationTag: '0099_future', appliedMigrations: 99 }))
    .toThrow('The pod\'s biometrics schema (0099_future) is newer than this checkout\'s')
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { ExportManifest, ManifestRawFile } from './download'

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../src/db/biometrics-migrations', import.meta.url))

/**
 * How a pod table merges into the archive. `key` is the natural key, backed by
 * a unique index (the archive adds `archive_uq_<table>` where the pod has none).
 * - append: rows are written once. A key match with other content is recorded
 *   in archive_conflicts and the archive keeps its row.
 * - state: the pod updates rows in place. The newest snapshot's non-key values
 *   win, except `keep` columns, which keep what the archive saw first.
 * Integer `id` surrogates keep the pod's id when it is free; a row whose id is
 * taken by a different key (the pod's database was reset) gets a new id.
 */
export interface TableSpec {
  table: string
  key: string[]
  mode: 'append' | 'state'
  keep?: string[]
  /** SQL for a column's value, over the snapshot row `s`. */
  remap?: Record<string, string>
}

export const TABLES: TableSpec[] = [
  { table: 'vitals', key: ['side', 'timestamp'], mode: 'append' },
  // vitals_id follows the vitals row to its archive id.
  { table: 'vitals_quality', key: ['side', 'timestamp'], mode: 'append', remap: {
    vitals_id: 'COALESCE((SELECT m.id FROM main.vitals m JOIN snap.vitals v ON m.side IS v.side AND m.timestamp IS v.timestamp WHERE v.id = s.vitals_id), s.vitals_id)',
  } },
  { table: 'movement', key: ['side', 'timestamp'], mode: 'append' },
  { table: 'sleep_records', key: ['side', 'entered_bed_at', 'left_bed_at'], mode: 'state' },
  { table: 'cap_sense_frames', key: ['side', 'timestamp'], mode: 'append' },
  { table: 'bed_temp', key: ['timestamp'], mode: 'append' },
  { table: 'freezer_temp', key: ['timestamp'], mode: 'append' },
  { table: 'ambient_light', key: ['timestamp'], mode: 'append' },
  { table: 'water_level_readings', key: ['timestamp'], mode: 'append' },
  { table: 'flow_readings', key: ['timestamp'], mode: 'append' },
  { table: 'thermal_state', key: ['side', 'timestamp', 'is_powered'], mode: 'append' },
  { table: 'prime_events', key: ['timestamp'], mode: 'append' },
  { table: 'flash_write_samples', key: ['boot_id', 'timestamp'], mode: 'append' },
  { table: 'water_level_alerts', key: ['type', 'started_at'], mode: 'state' },
  { table: 'pump_alerts', key: ['timestamp', 'type', 'side'], mode: 'state' },
  { table: 'health_runs', key: ['check_id', 'started_at'], mode: 'state' },
  { table: 'calibration_profiles', key: ['side', 'sensor_type'], mode: 'state' },
  // A retried calibration can log several runs in the same second; trigger and duration tell them apart.
  { table: 'calibration_runs', key: ['side', 'sensor_type', 'created_at', 'triggered_by', 'duration_ms'], mode: 'append' },
  { table: 'reference_imports', key: ['id'], mode: 'state' },
  { table: 'reference_measurements', key: ['import_id', 'record_key'], mode: 'append' },
  { table: 'reference_stages', key: ['side', 'start', 'source'], mode: 'state' },
  { table: 'reference_samples', key: ['side', 'metric', 'timestamp', 'source'], mode: 'state' },
  { table: 'reference_vitals', key: ['side', 'timestamp', 'source'], mode: 'state' },
  { table: 'biometric_processing_runs', key: ['id'], mode: 'state' },
  { table: 'biometric_runtime_configs', key: ['side', 'generation'], mode: 'append' },
  { table: 'biometric_runtime_receipts', key: ['side', 'component', 'generation'], mode: 'state' },
  // Releasing a dataset on the pod replaces its snapshot with a tombstone; the archive keeps the content.
  { table: 'biometric_datasets', key: ['id'], mode: 'state', keep: ['snapshot', 'byte_length'] },
  { table: 'biometric_experiments', key: ['id'], mode: 'state' },
  { table: 'biometric_backtest_jobs', key: ['id'], mode: 'state' },
  { table: 'biometric_backtest_results', key: ['job_id'], mode: 'state' },
  { table: 'biometric_holdout_accesses', key: ['id'], mode: 'append' },
  { table: 'biometric_raw_artifacts', key: ['content_hash'], mode: 'state' },
  { table: 'biometric_dataset_raw_artifacts', key: ['id'], mode: 'state' },
  { table: 'biometric_raw_sources', key: ['id'], mode: 'state' },
  { table: 'biometric_shadow_runs', key: ['id'], mode: 'state' },
  { table: 'biometric_shadow_samples', key: ['run_id', 'sequence'], mode: 'append' },
]

const INTERNAL_TABLE = /^(sqlite_|__drizzle_migrations$|archive_)/

const ARCHIVE_TABLES = `
CREATE TABLE IF NOT EXISTS archive_snapshots (
  sha256 TEXT PRIMARY KEY NOT NULL, generated_at_ms INTEGER NOT NULL, migration_tag TEXT,
  migration_created_at INTEGER, pull_key TEXT NOT NULL, merged_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS archive_raw_files (
  sha256 TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, archive_name TEXT NOT NULL UNIQUE,
  mtime_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, pull_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS archive_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, reason TEXT NOT NULL, key TEXT NOT NULL,
  archive_row TEXT, snapshot_row TEXT NOT NULL, pull_key TEXT NOT NULL, UNIQUE (table_name, key, snapshot_row));`

export interface TableCounts { snapshot: number, inserted: number, reassigned: number, ignored: number, updated: number, conflicts: number }
export interface ArchiveName { sha256: string, name: string, archiveName: string, renamed: boolean }
export interface MergeResult { tables: Record<string, TableCounts>, archiveNames: ArchiveName[], warnings: string[] }

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

interface Column { name: string, type: string, pk: number }

function columns(db: Database.Database, schema: 'main' | 'snap', table: string) {
  return db.prepare('SELECT name, type, pk FROM pragma_table_info(?, ?)').all(table, schema) as Column[]
}

function tables(db: Database.Database, schema: 'main' | 'snap') {
  return (db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
    .map(row => row.name).filter(name => !INTERNAL_TABLE.test(name))
}

function hasUniqueKey(db: Database.Database, table: string, key: string[]) {
  const pk = columns(db, 'main', table).filter(column => column.pk > 0).map(column => column.name)
  if (pk.length === key.length && pk.every(name => key.includes(name))) return true
  const indexes = db.prepare('SELECT name, "unique" AS isUnique, partial FROM pragma_index_list(?)').all(table) as Array<{ name: string, isUnique: number, partial: number }>
  return indexes.some((index) => {
    if (!index.isUnique || index.partial) return false
    const indexed = (db.prepare('SELECT name FROM pragma_index_info(?)').all(index.name) as Array<{ name: string }>).map(row => row.name)
    return indexed.length === key.length && indexed.every(name => key.includes(name))
  })
}

interface JournalEntry { when: number, tag: string }
export function migrationJournal(folder = MIGRATIONS_FOLDER): JournalEntry[] {
  return (JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] }).entries
}

/**
 * The archive database is migrated to this checkout's newest migration, which
 * must be at least the snapshot's. An older snapshot still merges: columns it
 * lacks take their defaults.
 */
export function checkSnapshotSchema(schema: ExportManifest['schema']['biometrics'], journal = migrationJournal()) {
  if (!schema) throw new Error('The snapshot has no applied biometrics migrations; refusing to merge it')
  const latest = journal[journal.length - 1]
  if (schema.migrationCreatedAt > latest.when) {
    throw new Error(`The pod's biometrics schema (${schema.migrationTag ?? schema.migrationCreatedAt}) is newer than this checkout's (${latest.tag}). Update the checkout, then pull again.`)
  }
  return { known: journal.some(entry => entry.when === schema.migrationCreatedAt), checkoutTag: latest.tag }
}

/** Open (or create) the archive database: migrate it, then add the merge's unique keys and bookkeeping tables. */
export function openArchiveDatabase(path: string, migrationsFolder = MIGRATIONS_FOLDER) {
  const db = new Database(path)
  // A single file, so the archive reads from read-only and network mounts without -shm.
  db.pragma('journal_mode = DELETE')
  db.pragma('busy_timeout = 5000')
  migrate(drizzle(db), { migrationsFolder })
  // Snapshots are internally consistent and the archive never deletes, so
  // table order can't break references; enforcement would only block merges.
  db.pragma('foreign_keys = OFF')
  db.exec(ARCHIVE_TABLES)
  const existing = new Set(tables(db, 'main'))
  for (const spec of TABLES) {
    if (!existing.has(spec.table) || hasUniqueKey(db, spec.table, spec.key)) continue
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(`archive_uq_${spec.table}`)} ON ${quote(spec.table)} (${spec.key.map(quote).join(', ')})`)
  }
  return db
}

function mergeTable(db: Database.Database, spec: TableSpec, newest: boolean, pullKey: string): TableCounts {
  const table = quote(spec.table)
  const archiveColumns = columns(db, 'main', spec.table)
  const snapshotNames = new Set(columns(db, 'snap', spec.table).map(column => column.name))
  const common = archiveColumns.map(column => column.name).filter(name => snapshotNames.has(name))
  const missingKey = spec.key.filter(name => !common.includes(name))
  if (missingKey.length) throw new Error(`${spec.table}: key column(s) ${missingKey.join(', ')} missing from the snapshot or archive`)
  const surrogate = !spec.key.includes('id') && archiveColumns.some(column => column.name === 'id' && column.pk === 1 && column.type.toUpperCase() === 'INTEGER')
  const value = (name: string) => spec.remap?.[name] ?? `s.${quote(name)}`
  const keyMatch = spec.key.map(name => `m.${quote(name)} IS s.${quote(name)}`).join(' AND ')
  const json = (alias: string, names: string[]) => `json_object(${names.map(name => `'${name}', ${alias}.${quote(name)}`).join(', ')})`
  const counts: TableCounts = { snapshot: 0, inserted: 0, reassigned: 0, ignored: 0, updated: 0, conflicts: 0 }
  counts.snapshot = (db.prepare(`SELECT COUNT(*) AS n FROM snap.${table}`).get() as { n: number }).n

  const insert = (names: string[], where = '') =>
    db.prepare(`INSERT OR IGNORE INTO main.${table} (${names.map(quote).join(', ')}) SELECT ${names.map(value).join(', ')} FROM snap.${table} s ${where}`).run().changes
  counts.inserted = insert(common)
  if (surrogate) counts.reassigned = insert(common.filter(name => name !== 'id'), `WHERE NOT EXISTS (SELECT 1 FROM main.${table} m WHERE ${keyMatch})`)

  const recordConflicts = (reason: string, archiveRow: string, from: string, where: string) =>
    db.prepare(`INSERT OR IGNORE INTO archive_conflicts (table_name, reason, key, archive_row, snapshot_row, pull_key)
      SELECT ?, ?, ${json('s', spec.key)}, ${archiveRow}, ${json('s', common)}, ? FROM ${from} WHERE ${where}`).run(spec.table, reason, pullKey).changes
  // A row the archive's constraints refused (for example a second active reference
  // import with the same content after a pod reset) is kept aside, not lost.
  counts.conflicts += recordConflicts('rejected', 'NULL', `snap.${table} s`, `NOT EXISTS (SELECT 1 FROM main.${table} m WHERE ${keyMatch})`)

  const compared = common.filter(name => !spec.key.includes(name) && !(surrogate && name === 'id') && !spec.remap?.[name] && !spec.keep?.includes(name))
  if (compared.length) {
    const differs = `NOT (${compared.map(name => `m.${quote(name)} IS s.${quote(name)}`).join(' AND ')})`
    if (spec.mode === 'append') {
      counts.conflicts += recordConflicts('changed', json('m', common), `snap.${table} s JOIN main.${table} m ON ${keyMatch}`, differs)
    }
    else if (newest) {
      counts.updated = db.prepare(`UPDATE main.${table} AS m SET ${compared.map(name => `${quote(name)} = s.${quote(name)}`).join(', ')}
        FROM snap.${table} AS s WHERE ${keyMatch} AND ${differs}`).run().changes
    }
  }
  counts.ignored = counts.snapshot - counts.inserted - counts.reassigned
  return counts
}

function assignArchiveNames(db: Database.Database, raw: readonly ManifestRawFile[], pullKey: string, occupied: ReadonlySet<string>): ArchiveName[] {
  const known = db.prepare('SELECT archive_name AS archiveName FROM archive_raw_files WHERE sha256 = ?')
  const taken = db.prepare('SELECT 1 FROM archive_raw_files WHERE archive_name = ?')
  const add = db.prepare('INSERT INTO archive_raw_files (sha256, name, archive_name, mtime_ms, bytes, pull_key) VALUES (?, ?, ?, ?, ?, ?)')
  return raw.map((file) => {
    const existing = known.get(file.sha256) as { archiveName: string } | undefined
    if (existing) return { sha256: file.sha256, name: file.name, archiveName: existing.archiveName, renamed: existing.archiveName !== file.name }
    // The pod reused a name for different bytes (counter reset, reinstall), or a
    // file the archive didn't write sits there: never overwrite.
    const renamed = Boolean(taken.get(file.name)) || occupied.has(file.name)
    const archiveName = renamed ? file.name.replace(/\.RAW\.gz$/, `-${file.sha256.slice(0, 12)}.RAW.gz`) : file.name
    add.run(file.sha256, file.name, archiveName, Math.floor(file.mtimeMs), file.bytes, pullKey)
    return { sha256: file.sha256, name: file.name, archiveName, renamed }
  })
}

/**
 * Merge one verified snapshot into the archive database in a single
 * transaction, together with the RAW name index and the snapshot record.
 * Nothing is ever deleted: rows the pod has since pruned stay.
 */
export function mergeSnapshot(db: Database.Database, snapshotPath: string, manifest: ExportManifest,
  options: { pullKey: string, nowMs: number, occupiedArchiveNames: ReadonlySet<string> }): MergeResult {
  const { pullKey, nowMs } = options
  db.prepare('ATTACH DATABASE ? AS snap').run(snapshotPath)
  try {
    return db.transaction(() => {
      const warnings: string[] = []
      const latest = (db.prepare('SELECT MAX(generated_at_ms) AS ms FROM archive_snapshots').get() as { ms: number | null }).ms
      const newest = latest === null || manifest.generatedAtMs >= latest
      if (!newest) warnings.push(`Snapshot from ${manifest.generatedAt} is older than one already merged; state tables keep their newer values`)
      const archiveTables = new Set(tables(db, 'main'))
      const snapshotTables = tables(db, 'snap')
      const classified = new Set(TABLES.map(spec => spec.table))
      const specs = [...TABLES.filter(spec => snapshotTables.includes(spec.table))]
      for (const name of snapshotTables.filter(table => !classified.has(table)).sort()) {
        if (!archiveTables.has(name)) {
          warnings.push(`Table ${name} is not in this checkout's schema; skipped`)
          continue
        }
        const pk = columns(db, 'main', name).filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name)
        if (!pk.length) {
          warnings.push(`Table ${name} has no merge rule or primary key; skipped`)
          continue
        }
        warnings.push(`Table ${name} has no merge rule; merged on its primary key (${pk.join(', ')})`)
        specs.push({ table: name, key: pk, mode: 'append' })
      }
      const tableCounts: Record<string, TableCounts> = {}
      for (const spec of specs) tableCounts[spec.table] = mergeTable(db, spec, newest, pullKey)
      const archiveNames = assignArchiveNames(db, manifest.files.filter((file): file is ManifestRawFile => file.role === 'raw'), pullKey, options.occupiedArchiveNames)
      const database = manifest.files.find(file => file.role === 'database')
      const schema = manifest.schema.biometrics
      db.prepare('INSERT OR IGNORE INTO archive_snapshots (sha256, generated_at_ms, migration_tag, migration_created_at, pull_key, merged_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(database?.sha256 ?? '', manifest.generatedAtMs, schema?.migrationTag ?? null, schema?.migrationCreatedAt ?? null, pullKey, nowMs)
      return { tables: tableCounts, archiveNames, warnings }
    })()
  }
  finally {
    db.prepare('DETACH DATABASE snap').run()
  }
}

import Database from 'better-sqlite3'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  HISTORY_FILENAME, HISTORY_MAX_INTERVAL_BYTES, HISTORY_MAX_SECONDS, HISTORY_SEMANTICS,
  historyDetailInputSchema, historyDetailSchema, historyPageInputSchema, historyRecordSchema,
  historySnapshotSchema, type HistoryKind, type HistoryPage, type HistoryPageInput, type HistorySnapshot,
} from './contract'
import { historyIntervals } from './intervals'
import { readJournalPresence, type JournalPresence } from '@/src/journal/presence'
import type { Side } from '@/src/hardware/types'

type HistoryFailure = 'not_imported' | 'unavailable' | 'changed' | 'invalid_cursor' | 'not_found'
export class HistoryError extends Error {
  constructor(readonly reason: HistoryFailure, message: string) { super(message) }
}

const cursorSchema = z.object({
  version: z.literal(1), snapshotId: z.string(), side: z.string(), kind: z.string(),
  start: z.number().int(), end: z.number().int(),
  timestamp: z.number().int().min(0).max(HISTORY_MAX_SECONDS),
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
const tables = { presence: 'sleep_records', vitals: 'vitals', movement: 'movement' } as const
const columns = {
  presence: 'id,side,entered_bed_at,left_bed_at,sleep_period_seconds,times_exited_bed',
  vitals: 'id,side,timestamp,heart_rate,hrv,breathing_rate',
  movement: 'id,side,timestamp,total_movement',
} as const
const timestampColumn = (kind: HistoryKind) => kind === 'presence' ? 'entered_bed_at' : 'timestamp'

/** These bounds match the offline importer's readable-record counts. */
function readableRows(kind: HistoryKind): string {
  const timestamp = timestampColumn(kind)
  return `typeof(id)='integer' AND id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
    AND typeof(${timestamp})='integer' AND ${timestamp} BETWEEN 0 AND ${HISTORY_MAX_SECONDS}`
    + (kind === 'presence' ? ` AND typeof(left_bed_at)='integer' AND left_bed_at>entered_bed_at AND left_bed_at<=${HISTORY_MAX_SECONDS}` : '')
}

const finiteValue = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
function recordFromRow(kind: HistoryKind, row: Record<string, unknown>) {
  const common = { kind, id: row.id, side: row.side }
  if (kind === 'presence') return historyRecordSchema.parse({
    ...common, enteredBedAt: row.entered_bed_at, leftBedAt: row.left_bed_at,
    reportedDurationSeconds: finiteValue(row.sleep_period_seconds), exits: finiteValue(row.times_exited_bed),
  })
  if (kind === 'movement') return historyRecordSchema.parse({ ...common, timestamp: row.timestamp, totalMovement: finiteValue(row.total_movement) })
  return historyRecordSchema.parse({
    ...common, timestamp: row.timestamp, heartRateBpm: finiteValue(row.heart_rate),
    hrvEstimateMs: finiteValue(row.hrv), breathingRatePerMinute: finiteValue(row.breathing_rate),
  })
}

/** Reject WAL snapshots before SQLite can create auxiliary files beside the archive. */
function requireReadModel(filename: string): void {
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const header = Buffer.alloc(100)
    if (!fstatSync(descriptor).isFile() || readSync(descriptor, header, 0, 100, 0) !== 100
      || header.toString('utf8', 0, 16) !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1) {
      throw new HistoryError('unavailable', 'The imported history snapshot needs to be rebuilt from its preserved source.')
    }
  }
  finally { closeSync(descriptor) }
}

function cursorScope(input: HistoryPageInput) {
  return { version: 1 as const, snapshotId: input.snapshotId, side: input.side, kind: input.kind,
    start: Date.parse(input.startTime), end: Date.parse(input.endTime) }
}

function readCursor(input: HistoryPageInput) {
  if (!input.cursor) return null
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error('Encoding')
    const decoded = Buffer.from(input.cursor, 'base64url')
    if (decoded.toString('base64url') !== input.cursor) throw new Error('Encoding')
    const cursor = cursorSchema.parse(JSON.parse(decoded.toString('utf8')))
    const scope = cursorScope(input)
    if (cursor.version !== scope.version || cursor.snapshotId !== scope.snapshotId || cursor.side !== scope.side
      || cursor.kind !== scope.kind || cursor.start !== scope.start || cursor.end !== scope.end) throw new Error('Scope')
    return cursor
  }
  catch { throw new HistoryError('invalid_cursor', 'Reload this history range before requesting another page.') }
}

/** Every request opens only the separate imported snapshot, never Core's live metric store. */
export class ImportedHistoryReader {
  constructor(private readonly filename: string | null) {}

  private read<Result>(action: (database: Database.Database, snapshot: HistorySnapshot) => Result): Result {
    let database: Database.Database | undefined
    try {
      if (!this.filename) throw new HistoryError('not_imported', 'No earlier records have been imported.')
      requireReadModel(this.filename)
      database = new Database(this.filename, { readonly: true, fileMustExist: true, timeout: 250 })
      database.pragma('query_only = ON')
      database.pragma('trusted_schema = OFF')
      const connection = database
      return connection.transaction(() => {
        const row = connection.prepare('SELECT substr(document,1,65537) AS document FROM imported_history_metadata WHERE id=1').get() as { document?: unknown } | undefined
        if (typeof row?.document !== 'string' || Buffer.byteLength(row.document) > 65536) throw new Error('Missing history metadata')
        const snapshot = historySnapshotSchema.parse(JSON.parse(row.document))
        // Validate the stored display zone before returning it to either client.
        new Intl.DateTimeFormat('en', { timeZone: snapshot.timeZone }).format(0)
        return action(connection, snapshot)
      })()
    }
    catch (error) {
      if (error instanceof HistoryError) throw error
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        throw new HistoryError('not_imported', 'No earlier records have been imported.')
      }
      throw new HistoryError('unavailable', 'Imported history could not be read. The preserved source has not been changed.')
    }
    finally { database?.close() }
  }

  status() {
    try {
      return this.read((_database, snapshot) => ({
        apiVersion: 1 as const, status: 'ready' as const, snapshot, message: 'Earlier records are available as a read-only snapshot.', semantics: HISTORY_SEMANTICS,
      }))
    }
    catch (error) {
      const failure = error instanceof HistoryError ? error : new HistoryError('unavailable', 'Imported history could not be read.')
      return { apiVersion: 1 as const, status: failure.reason === 'not_imported' ? 'not_imported' as const : 'unavailable' as const,
        snapshot: null, message: failure.message, semantics: HISTORY_SEMANTICS }
    }
  }

  /** Analysis remains source-separated and uses the archive's original wake-date zone. */
  journalPresence(side: Side, from: string, through: string): JournalPresence {
    try {
      return this.read((database, snapshot) => readJournalPresence(database, side, from, through, snapshot.timeZone))
    }
    catch (error) {
      return { status: error instanceof HistoryError && error.reason === 'not_imported' ? 'not_imported' : 'unavailable', timeZone: null, minutes: new Map() }
    }
  }

  page(request: HistoryPageInput): HistoryPage {
    const input = historyPageInputSchema.parse(request)
    const cursor = readCursor(input)
    return this.read((database, snapshot) => {
      if (snapshot.snapshotId !== input.snapshotId) throw new HistoryError('changed', 'The imported snapshot changed. Reload its history before continuing.')
      const timestamp = timestampColumn(input.kind)
      const scope = cursorScope(input)
      const range = input.kind === 'presence' ? 'left_bed_at>? AND entered_bed_at<?' : `${timestamp}>=? AND ${timestamp}<?`
      const parameters: Array<string | number> = [input.side, scope.start / 1000, scope.end / 1000]
      if (cursor) parameters.push(cursor.timestamp, cursor.id)
      parameters.push(input.limit + 1)
      const rows = database.prepare(`SELECT ${columns[input.kind]} FROM ${tables[input.kind]}
        WHERE side=? AND ${readableRows(input.kind)} AND ${range}
        ${cursor ? `AND (${timestamp},id)<(?,?)` : ''}
        ORDER BY ${timestamp} DESC,id DESC LIMIT ?`).all(...parameters) as Array<Record<string, unknown>>
      const selected = rows.slice(0, input.limit)
      const last = selected.at(-1)
      const nextCursor = rows.length > input.limit && last
        ? Buffer.from(JSON.stringify({ ...scope, timestamp: last[timestamp], id: last.id })).toString('base64url')
        : null
      return { apiVersion: 1, snapshotId: snapshot.snapshotId, side: input.side, kind: input.kind,
        records: selected.map(row => recordFromRow(input.kind, row)), nextCursor, semantics: HISTORY_SEMANTICS }
    })
  }

  detail(request: z.infer<typeof historyDetailInputSchema>) {
    const input = historyDetailInputSchema.parse(request)
    return this.read((database, snapshot) => {
      if (snapshot.snapshotId !== input.snapshotId) throw new HistoryError('changed', 'The imported snapshot changed. Reload its history before continuing.')
      const row = database.prepare(`SELECT ${columns.presence},
        length(CAST(present_intervals AS BLOB)) AS present_bytes, length(CAST(not_present_intervals AS BLOB)) AS absent_bytes,
        CASE WHEN length(CAST(present_intervals AS BLOB))<=? THEN present_intervals END AS present_intervals,
        CASE WHEN length(CAST(not_present_intervals AS BLOB))<=? THEN not_present_intervals END AS not_present_intervals
        FROM sleep_records WHERE side=? AND id=? AND ${readableRows('presence')}`)
        .get(HISTORY_MAX_INTERVAL_BYTES, HISTORY_MAX_INTERVAL_BYTES, input.side, input.id) as Record<string, unknown> | undefined
      if (!row) throw new HistoryError('not_found', 'That bed-presence record is not available for this side.')
      const record = recordFromRow('presence', row)
      if (record.kind !== 'presence') throw new Error('Unexpected record kind')
      const present = typeof row.present_intervals === 'string' ? row.present_intervals : null
      const absent = typeof row.not_present_intervals === 'string' ? row.not_present_intervals : null
      return historyDetailSchema.parse({ apiVersion: 1, snapshotId: snapshot.snapshotId, record,
        present: historyIntervals(present, Number(row.present_bytes), record.enteredBedAt, record.leftBedAt),
        absent: historyIntervals(absent, Number(row.absent_bytes), record.enteredBedAt, record.leftBedAt),
        rawPresentIntervals: present, rawAbsentIntervals: absent, semantics: HISTORY_SEMANTICS,
      })
    })
  }
}

export function importedHistoryReader(): ImportedHistoryReader {
  const configured = process.env.DATABASE_URL?.replace(/^file:/, '') || './sleepypod.dev.db'
  return new ImportedHistoryReader(configured === ':memory:' ? null : join(dirname(resolve(configured)), HISTORY_FILENAME))
}

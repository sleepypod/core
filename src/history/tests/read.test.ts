import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { createHistoryFixture, HISTORY_FIXTURE_START } from '../../../tests/fixtures/importedHistory'
import { historyDetailSchema, historyPageSchema, historySnapshotSchema, historyStatusSchema, type HistoryPageInput, type HistorySnapshot } from '../contract'
import { ImportedHistoryReader } from '../read'

let directory: string
let filename: string
let original: string
let reader: ImportedHistoryReader
let snapshot: HistorySnapshot
let input: HistoryPageInput

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-history-test-'))
  ;({ filename, original } = createHistoryFixture(directory))
  reader = new ImportedHistoryReader(filename)
  snapshot = historySnapshotSchema.parse(reader.status().snapshot)
  input = { snapshotId: snapshot.snapshotId, side: 'left', kind: 'vitals',
    startTime: '2026-10-10T06:00:00Z', endTime: '2026-10-11T06:00:00Z', limit: 17 }
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function editSnapshot(action: (database: Database.Database) => void) {
  const database = new Database(filename)
  try {
    action(database)
  }
  finally { database.close() }
}

describe('imported legacy history', () => {
  it('reads the real importer output without modifying either file or creating sidecars', () => {
    const before = new Map(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]))
    expect(historyStatusSchema.parse(reader.status()).snapshot).toMatchObject({
      source: 'free-sleep', timeZone: 'America/Los_Angeles', unassignedRecords: 1,
      sides: { left: { vitals: { records: 56, readableRecords: 55 } }, right: { vitals: { records: 1, readableRecords: 1 } } },
    })
    expect(historyPageSchema.parse(reader.page(input)).semantics).toMatchObject({ previewEvidence: false, automationInput: false })
    const detail = historyDetailSchema.parse(reader.detail({ snapshotId: snapshot.snapshotId, side: 'left', id: 1 }))
    expect(detail.present).toEqual({ status: 'available', coveredSeconds: 9000,
      intervals: [[HISTORY_FIXTURE_START, HISTORY_FIXTURE_START + 7200], [HISTORY_FIXTURE_START + 27000, HISTORY_FIXTURE_START + 28800]] })
    expect(detail.absent).toEqual({ status: 'unavailable', coveredSeconds: null, intervals: null })
    expect(new Map(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]))).toEqual(before)
    const check = new Database(filename, { readonly: true })
    try {
      expect(check.prepare('SELECT name FROM sqlite_master WHERE name=\'unrelated_private_data\'').get()).toBeUndefined()
    }
    finally { check.close() }
    expect(readFileSync(original)).toEqual(before.get('legacy-history.db'))
  })

  it('paginates timestamp ties without omissions or duplicates and isolates sides', () => {
    const identifiers: number[] = []
    let cursor: string | undefined
    do {
      const page = reader.page({ ...input, cursor })
      identifiers.push(...page.records.map(record => record.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(identifiers).toEqual(Array.from({ length: 55 }, (_, index) => 55 - index))
    expect(reader.page({ ...input, side: 'right' }).records).toEqual([
      { kind: 'vitals', id: 56, side: 'right', timestamp: HISTORY_FIXTURE_START, heartRateBpm: 70, hrvEstimateMs: null, breathingRatePerMinute: null },
    ])
    expect(reader.page(input).records[0]).toMatchObject({ heartRateBpm: null })
    expect(reader.page({ ...input, kind: 'movement' }).records).toMatchObject([{ totalMovement: 3 }])
    expect(() => reader.detail({ snapshotId: snapshot.snapshotId, side: 'right', id: 1 })).toThrow(/not available for this side/)
  })

  it('uses half-open fractional sample windows and includes overlapping overnight presence', () => {
    expect(reader.page({ ...input, endTime: '2026-10-10T06:00:00.001Z' }).records.map(record => record.id)).toEqual([2, 1])
    expect(reader.page({ ...input, startTime: '2026-10-10T06:00:00.001Z', endTime: '2026-10-10T06:05:00Z' }).records).toEqual([])
    expect(reader.page({ ...input, kind: 'presence', startTime: '2026-10-10T13:00:00Z', endTime: '2026-10-10T14:00:00Z' }).records).toHaveLength(1)
    expect(reader.page({ ...input, kind: 'presence', startTime: '2026-10-10T14:00:00Z' }).records).toEqual([])
  })

  it('rejects cursors from another query or snapshot, and requires refresh after replacement', () => {
    const cursor = reader.page(input).nextCursor
    if (!cursor) throw new Error('Expected another fixture page')
    for (const changed of [{ side: 'right' as const }, { kind: 'presence' as const }, { startTime: '2026-10-10T06:00:01Z' },
      { endTime: '2026-10-10T07:00:00Z' }, { snapshotId: 'b'.repeat(64) }, { cursor: `${cursor}=` }]) {
      expect(() => reader.page({ ...input, cursor, ...changed })).toThrow(/Reload this history range/)
    }
    editSnapshot(database => database.prepare('UPDATE imported_history_metadata SET document=?').run(JSON.stringify({ ...snapshot, snapshotId: 'b'.repeat(64) })))
    expect(() => reader.page({ ...input, cursor })).toThrow(/snapshot changed/)
    expect(() => reader.detail({ snapshotId: snapshot.snapshotId, side: 'left', id: 1 })).toThrow(/snapshot changed/)
  })

  it('returns honest unavailable intervals and bounds their payload and processing', () => {
    const missing = reader.detail({ snapshotId: snapshot.snapshotId, side: 'right', id: 2 })
    expect(missing.present.coveredSeconds).toBeNull()
    expect(missing.absent.status).toBe('invalid')
    editSnapshot(database => database.prepare('UPDATE sleep_records SET present_intervals=? WHERE id=1').run(' '.repeat(262145)))
    const large = reader.detail({ snapshotId: snapshot.snapshotId, side: 'left', id: 1 })
    expect(large.present.status).toBe('too_large')
    expect(large.rawPresentIntervals).toBeNull()
    editSnapshot(database => database.prepare('UPDATE sleep_records SET left_bed_at=entered_bed_at+? WHERE id=1').run(73 * 3600))
    expect(reader.detail({ snapshotId: snapshot.snapshotId, side: 'left', id: 1 }).present.status).toBe('unsupported_window')
  })

  it('rejects invalid limits, timestamps, unknown inputs and inconsistent metadata', () => {
    for (const changed of [{ limit: 501 }, { limit: 0 }, { startTime: 'not-a-date' }, { startTime: input.endTime },
      { endTime: '2027-01-10T06:00:00Z' }, { filename: original }]) {
      expect(() => reader.page({ ...input, ...changed })).toThrow()
    }
    editSnapshot(database => database.prepare('UPDATE imported_history_metadata SET document=?').run(JSON.stringify({ ...snapshot,
      sides: { ...snapshot.sides, left: { ...snapshot.sides.left, vitals: { records: 0, readableRecords: 1, firstAt: null, lastAt: null } } } })))
    expect(reader.status()).toMatchObject({ status: 'unavailable', snapshot: null })
  })

  it('fails closed for missing, corrupt, linked and WAL snapshots without creating files', () => {
    expect(new ImportedHistoryReader(join(directory, 'missing.db')).status().status).toBe('not_imported')
    expect(new ImportedHistoryReader(null).status().status).toBe('not_imported')
    const link = join(directory, 'linked.db')
    symlinkSync(filename, link)
    expect(new ImportedHistoryReader(link).status().status).toBe('unavailable')
    const bytes = readFileSync(filename)
    bytes[18] = 2
    bytes[19] = 2
    writeFileSync(filename, bytes)
    const names = readdirSync(directory)
    expect(reader.status()).toMatchObject({ status: 'unavailable', snapshot: null })
    expect(readdirSync(directory)).toEqual(names)
    expect(readFileSync(filename)).toEqual(bytes)
    writeFileSync(filename, 'invalid SQLite')
    expect(reader.status().status).toBe('unavailable')
  })
})

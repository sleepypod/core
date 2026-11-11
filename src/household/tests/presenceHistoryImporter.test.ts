import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HISTORY_MAX_INTERVAL_BYTES } from '@/src/history/contract'
import { personalRuntimeFixture } from './runtimeFixture'
import { historySourceFixture } from './historySourceFixture'
import { PersonHistoryStore } from '../personHistory'
import { PresenceHistoryImporter } from '../presenceHistoryImporter'

let fixture: ReturnType<typeof personalRuntimeFixture>
let source: ReturnType<typeof historySourceFixture>
let history: PersonHistoryStore
let importer: PresenceHistoryImporter
let start: number
const day = 86_400_000
beforeEach(() => {
  fixture = personalRuntimeFixture()
  source = historySourceFixture(fixture.database, fixture.owner, () => fixture.clock.now)
  history = new PersonHistoryStore(fixture.database, fixture.identities, source.source, () => fixture.clock.now)
  importer = new PresenceHistoryImporter(source.biometrics, source.source, history, () => fixture.clock.now)
  start = Math.ceil(fixture.clock.now / 1000) * 1000
  fixture.clock.now = start + 30 * day
})
afterEach(() => {
  source.biometrics.close()
  fixture.database.close()
})
const request = () => ({ householdId: fixture.owner.householdId, datasetId: source.identity.datasetId })
const query = () => ({ startsAt: start, endsAt: fixture.clock.now, kind: 'presence' })
function assign() {
  return history.appendReviewedEpoch({ ...request(), startsAt: start, endsAt: null,
    expectedAttributionRevision: 1, mode: 'assigned', basis: 'verified_arrangement',
    reviewedBy: fixture.owner.accountId, reviewReceiptId: randomUUID(), assignments: [
      { sleeperId: fixture.owner.selfSleeperId, recordedSide: 'left' },
      { sleeperId: fixture.member.selfSleeperId, recordedSide: 'right' },
    ] })
}
function recording(index = 0, side = 'left') {
  const entered = (start + index * day) / 1000
  return { side, entered, left: entered + 8 * 3600, created: entered + 8 * 3600,
    duration: 8 * 3600, exits: 1, present: JSON.stringify([[entered, entered + 2 * 3600], [entered + 4 * 3600, entered + 8 * 3600]]), absent: '[]' }
}
function insert(row: ReturnType<typeof recording>) {
  return source.biometrics.prepare(`INSERT INTO sleep_records
    (side, entered_bed_at, left_bed_at, created_at, sleep_duration_seconds, times_exited_bed, present_intervals, not_present_intervals)
    VALUES (@side, @entered, @left, @created, @duration, @exits, @present, @absent)`).run(row).lastInsertRowid as number
}

describe('recorded presence importer', () => {
  it('requires an explicit attribution interval; source binding alone never claims history', () => {
    insert(recording())
    expect(importer.scan(request())).toMatchObject({ counts: { scanned: 1, admitted: 0, withheld: 1 }, withheldReasons: { unassigned: 1 }, nextCursor: null })
    expect(history.records(fixture.ownerKey, query()).records).toEqual([])
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('copies actual interval coverage into the correct private history, and survives restart/replay', () => {
    assign()
    insert(recording())
    insert(recording(0, 'right'))
    expect(importer.scan(request()).counts).toEqual({ scanned: 2, admitted: 2, unchanged: 0, withheld: 0 })
    const owner = history.records(fixture.ownerKey, query()).records
    const member = history.records(fixture.memberKey, query()).records
    expect(owner).toHaveLength(1)
    expect(member).toHaveLength(1)
    expect(owner[0]).toMatchObject({ recordedSide: 'left', startsAt: start, endsAt: start + 8 * 3600_000,
      payload: { reportedPresenceSeconds: 6 * 3600, interpretation: 'bed_presence_not_sleep' } })
    expect(history.record(fixture.memberKey, owner[0].id)).toBeNull()
    expect(history.record(fixture.ownerKey, member[0].id)).toBeNull()
    const restarted = new PresenceHistoryImporter(source.biometrics, source.source, history, () => fixture.clock.now)
    expect(restarted.scan(request()).counts).toEqual({ scanned: 2, admitted: 0, unchanged: 2, withheld: 0 })
    expect(source.biometrics.prepare('SELECT COUNT(*) AS count FROM sleep_records').get()).toEqual({ count: 2 })
    expect(source.biometrics.prepare('SELECT COUNT(*) AS count FROM vitals').get()).toEqual({ count: 0 })
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('uses a stable page watermark and picks up later arrivals only in the next scan', () => {
    assign()
    insert(recording(0))
    insert(recording(1))
    const first = importer.scan({ ...request(), limit: 1 })
    expect(first.nextCursor).toEqual({ afterId: 1, watermark: 2 })
    insert(recording(2))
    const second = importer.scan({ ...request(), limit: 1, cursor: first.nextCursor })
    expect(second.counts.admitted).toBe(1)
    expect(second.nextCursor).toBeNull()
    expect(importer.scan(request()).counts).toEqual({ scanned: 3, admitted: 1, unchanged: 2, withheld: 0 })
    expect(() => importer.scan({ ...request(), cursor: { afterId: 3, watermark: 2 } })).toThrow('outside its snapshot')
  })

  it('resumes idempotently when a process stops after a private copy commits', () => {
    assign()
    for (let index = 0; index < 3; index++) insert(recording(index))
    let completed = 0
    const interrupted = new PresenceHistoryImporter(source.biometrics, source.source, {
      rejectSourceObservation: input => history.rejectSourceObservation(input),
      admitObservation: (input) => {
        const result = history.admitObservation(input)
        if (++completed === 2) throw new Error('Simulated interruption after commit')
        return result
      },
    }, () => fixture.clock.now)
    expect(() => interrupted.scan(request())).toThrow('Simulated interruption')
    expect(history.records(fixture.ownerKey, query()).records).toHaveLength(2)
    expect(importer.scan(request()).counts).toEqual({ scanned: 3, admitted: 1, unchanged: 2, withheld: 0 })
    expect(history.records(fixture.ownerKey, query()).records).toHaveLength(3)
  })

  it('withholds the entire recording across a reviewed side transition', () => {
    const original = assign()
    history.transitionReviewedEpoch(original.epochId, { ...request(), startsAt: start + 4 * 3600_000, endsAt: null,
      expectedAttributionRevision: original.attributionRevision, mode: 'assigned', basis: 'verified_arrangement',
      reviewedBy: fixture.owner.accountId, reviewReceiptId: randomUUID(), assignments: [
        { sleeperId: fixture.member.selfSleeperId, recordedSide: 'left' },
        { sleeperId: fixture.owner.selfSleeperId, recordedSide: 'right' },
      ] })
    insert(recording())
    expect(importer.scan(request()).withheldReasons).toEqual({ unassigned: 1 })
    expect(history.records(fixture.ownerKey, query()).records).toEqual([])
    expect(history.records(fixture.memberKey, query()).records).toEqual([])
  })

  it('invalidates changed interval detail even when duration and other visible summaries are unchanged', () => {
    assign()
    const original = recording()
    const identifier = insert(original)
    importer.scan(request())
    const before = history.records(fixture.ownerKey, query())
    source.biometrics.prepare('UPDATE sleep_records SET present_intervals = ? WHERE id = ?')
      .run(JSON.stringify([[original.entered, original.entered + 6 * 3600]]), identifier)
    expect(importer.scan(request()).withheldReasons).toEqual({ source_changed: 1 })
    const after = history.records(fixture.ownerKey, query())
    expect(after.records).toEqual([])
    expect(after.attributionRevision).toBeGreaterThan(before.attributionRevision)
    source.biometrics.prepare('UPDATE sleep_records SET present_intervals = ? WHERE id = ?').run(original.present, identifier)
    expect(importer.scan(request()).withheldReasons).toEqual({ source_changed: 1 })
  })

  it('does not transfer an admitted recording to the partner if its source side is edited', () => {
    assign()
    const identifier = insert(recording())
    importer.scan(request())
    source.biometrics.prepare('UPDATE sleep_records SET side = \'right\' WHERE id = ?').run(identifier)
    expect(importer.scan(request()).withheldReasons).toEqual({ source_changed: 1 })
    expect(history.records(fixture.ownerKey, query()).records).toEqual([])
    expect(history.records(fixture.memberKey, query()).records).toEqual([])
  })

  it('withdraws a previously admitted row that becomes malformed without reviving it after repair', () => {
    assign()
    const original = recording()
    const identifier = insert(original)
    importer.scan(request())
    const before = history.records(fixture.ownerKey, query()).attributionRevision
    source.biometrics.prepare('UPDATE sleep_records SET present_intervals = \'broken\' WHERE id = ?').run(identifier)
    expect(importer.scan(request()).withheldReasons).toEqual({ invalid_recording: 1 })
    expect(history.records(fixture.ownerKey, query()).records).toEqual([])
    const invalidated = history.records(fixture.ownerKey, query()).attributionRevision
    expect(invalidated).toBeGreaterThan(before)
    importer.scan(request())
    expect(history.records(fixture.ownerKey, query()).attributionRevision).toBe(invalidated)
    source.biometrics.prepare('UPDATE sleep_records SET present_intervals = ? WHERE id = ?').run(original.present, identifier)
    expect(importer.scan(request()).withheldReasons).toEqual({ source_changed: 1 })
  })

  it.each(['empty', 'bad_json', 'oversized', 'future', 'wrong_units', 'open', 'long', 'negative_exits'])('withholds %s source recordings instead of inventing complete sleep', (kind) => {
    assign()
    const row = recording()
    if (kind === 'empty') row.present = '[]'
    if (kind === 'bad_json') row.present = '[['
    if (kind === 'oversized') row.present = ' '.repeat(HISTORY_MAX_INTERVAL_BYTES + 1)
    if (kind === 'future') {
      row.entered = fixture.clock.now / 1000 - 3600
      row.left = fixture.clock.now / 1000 + 3600
      row.created = row.left
      row.duration = 7200
      row.present = JSON.stringify([[row.entered, row.left]])
    }
    if (kind === 'wrong_units') {
      row.entered *= 1000
      row.left *= 1000
    }
    if (kind === 'open') row.left = row.entered
    if (kind === 'long') row.left = row.entered + 86_401
    if (kind === 'negative_exits') row.exits = -1
    insert(row)
    expect(importer.scan(request())).toMatchObject({ counts: { admitted: 0, withheld: 1 }, withheldReasons: { invalid_recording: 1 } })
    expect(history.records(fixture.ownerKey, query()).records).toEqual([])
  })

  it('bounds combined JSON bytes and resumes at the unconsumed row', () => {
    assign()
    for (let index = 0; index < 17; index++) {
      const row = recording(index)
      row.present = row.present.padEnd(HISTORY_MAX_INTERVAL_BYTES)
      row.absent = row.absent.padEnd(HISTORY_MAX_INTERVAL_BYTES)
      insert(row)
    }
    const first = importer.scan({ ...request(), limit: 100 })
    expect(first.counts).toEqual({ scanned: 16, admitted: 16, unchanged: 0, withheld: 0 })
    expect(first.nextCursor).toEqual({ afterId: 16, watermark: 17 })
    const last = importer.scan({ ...request(), limit: 100, cursor: first.nextCursor })
    expect(last.counts.admitted).toBe(1)
    expect(last.nextCursor).toBeNull()
    expect(history.records(fixture.ownerKey, { ...query(), limit: 100 }).records).toHaveLength(17)
  })

  it('rejects replacement sources before admitting or invalidating any private record', () => {
    assign()
    insert(recording())
    importer.scan(request())
    source.biometrics.prepare('UPDATE biometric_history_identity SET dataset_id = ?').run(randomUUID())
    expect(() => importer.scan(request())).toThrow('source is unavailable or changed')
    expect(history.records(fixture.ownerKey, query()).records).toHaveLength(1)
  })

  it('does not double-count overlap or delete private copies when raw retention removes a source row', () => {
    assign()
    insert(recording())
    insert(recording())
    expect(importer.scan(request()).withheldReasons).toEqual({ overlapping_presence: 1 })
    source.biometrics.prepare('DELETE FROM sleep_records').run()
    expect(importer.scan(request()).counts.scanned).toBe(0)
    expect(history.records(fixture.ownerKey, query()).records).toHaveLength(1)
  })
})

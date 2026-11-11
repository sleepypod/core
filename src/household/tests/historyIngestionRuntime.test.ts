import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { personalRuntimeFixture } from './runtimeFixture'
import { historySourceFixture } from './historySourceFixture'
import { PersonHistoryStore } from '../personHistory'
import { startPersonalHistoryIngestion, stopPersonalHistoryIngestion, personalHistoryIngestionStatus, readHistoryIngestionTarget } from '../historyIngestionRuntime'

let fixture: ReturnType<typeof personalRuntimeFixture>
let source: ReturnType<typeof historySourceFixture>
let history: PersonHistoryStore
let start: number
let epochId: string
const day = 86_400_000
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 9, 1))
  fixture = personalRuntimeFixture()
  source = historySourceFixture(fixture.database, fixture.owner, () => fixture.clock.now)
  history = new PersonHistoryStore(fixture.database, fixture.identities, source.source, () => fixture.clock.now)
  start = fixture.clock.now
  fixture.clock.now += 30 * day
  vi.setSystemTime(fixture.clock.now)
  vi.stubEnv('SLEEPYPOD_HOUSEHOLD_PREPARATION', '1')
  vi.stubEnv('SLEEPYPOD_PERSONAL_HISTORY', '1')
})
afterEach(() => {
  stopPersonalHistoryIngestion()
  source.biometrics.close()
  fixture.database.close()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
function assign() {
  epochId = history.appendReviewedEpoch({ householdId: fixture.owner.householdId, datasetId: source.identity.datasetId,
    startsAt: start, endsAt: null, expectedAttributionRevision: 1, mode: 'assigned', basis: 'verified_arrangement',
    reviewedBy: fixture.owner.accountId, reviewReceiptId: randomUUID(), assignments: [
      { sleeperId: fixture.owner.selfSleeperId, recordedSide: 'left' },
      { sleeperId: fixture.member.selfSleeperId, recordedSide: 'right' },
    ] }).epochId
}
function insert(index: number, side: 'left' | 'right' = 'left') {
  const entered = (start + index * day) / 1000
  const left = entered + 8 * 3600
  return source.biometrics.prepare(`INSERT INTO sleep_records
    (side, entered_bed_at, left_bed_at, created_at, sleep_duration_seconds, times_exited_bed, present_intervals, not_present_intervals)
    VALUES (?, ?, ?, ?, ?, 0, ?, '[]')`).run(side, entered, left, left, 8 * 3600, JSON.stringify([[entered, left]])).lastInsertRowid
}
function records(key = fixture.ownerKey) {
  return history.records(key, { startsAt: start, endsAt: fixture.clock.now, kind: 'presence' }).records
}
function boot() {
  startPersonalHistoryIngestion(fixture.database, source.biometrics)
  vi.advanceTimersByTime(5000)
}

describe('personal history ingestion with actual migrated stores', () => {
  it('does not create attribution during startup, even with a reviewed source and personal account', () => {
    insert(0)
    expect(readHistoryIngestionTarget(fixture.database)).toBeNull()
    boot()
    expect(personalHistoryIngestionStatus()?.state).toBe('awaiting_review')
    expect(records()).toEqual([])
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_attribution_epochs').get()).toEqual({ count: 0 })
    expect(source.biometrics.prepare('SELECT dataset_id FROM biometric_history_identity').get()).toEqual({ dataset_id: source.identity.datasetId })
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it.each(['SLEEPYPOD_HOUSEHOLD_PREPARATION', 'SLEEPYPOD_PERSONAL_HISTORY'])('does not import with %s disabled', (flag) => {
    assign()
    insert(0)
    vi.stubEnv(flag, '0')
    boot()
    expect(personalHistoryIngestionStatus()?.state).toBe('disabled')
    expect(records()).toEqual([])
  })

  it('copies each reviewed side privately, picks up a new arrival and replays after restart without duplicates', () => {
    assign()
    insert(0)
    insert(0, 'right')
    boot()
    expect(records()).toHaveLength(1)
    expect(records(fixture.memberKey)).toHaveLength(1)
    expect(history.record(fixture.memberKey, records()[0].id)).toBeNull()
    expect(history.record(fixture.ownerKey, records(fixture.memberKey)[0].id)).toBeNull()
    insert(1)
    vi.advanceTimersByTime(30_000)
    expect(records()).toHaveLength(2)
    const identifiers = records().map(record => record.id)
    stopPersonalHistoryIngestion()
    boot()
    expect(records().map(record => record.id)).toEqual(identifiers)
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_person_records').get()).toEqual({ count: 3 })
    expect(fixture.execute).not.toHaveBeenCalled()
    expect(fixture.identities.session(fixture.ownerKey).arrangement.mode).toBe('solo-anywhere')
  })

  it('withdraws an old edited copy on audit without transferring it to the partner', () => {
    assign()
    const identifier = insert(0)
    insert(0, 'right')
    boot()
    const ownerId = records()[0].id
    source.biometrics.prepare('UPDATE sleep_records SET side = \'right\' WHERE id = ?').run(identifier)
    vi.advanceTimersByTime(30_000)
    expect(records()).toHaveLength(1) // tail does not pretend to have audited old rows
    vi.advanceTimersByTime(15 * 60_000)
    expect(records()).toEqual([])
    expect(records(fixture.memberKey)).toHaveLength(1)
    expect(history.record(fixture.memberKey, ownerId)).toBeNull()
    expect(personalHistoryIngestionStatus()?.lastCompleteAuditAt).not.toBeNull()
  })

  it('continues tailing new rows while a large audit is paged', () => {
    assign()
    for (let index = 0; index < 27; index++) insert(index)
    boot()
    expect(records()).toHaveLength(25)
    vi.advanceTimersByTime(30_000)
    expect(records()).toHaveLength(27)
    source.biometrics.prepare('UPDATE sleep_records SET present_intervals = \'invalid\' WHERE id = 27').run()
    vi.advanceTimersByTime(15 * 60_000)
    insert(28)
    vi.advanceTimersByTime(30_000)
    const imported = records()
    expect(imported).toHaveLength(27) // one withdrawn and one new
    expect(imported.some(record => record.startsAt === start + 28 * day)).toBe(true)
    expect(imported.some(record => record.startsAt === start + 26 * day)).toBe(false)
  })

  it('does not reinitialize or rebind a substituted source; existing private copies remain available', () => {
    assign()
    insert(0)
    boot()
    const replacement = randomUUID()
    source.biometrics.prepare('UPDATE biometric_history_identity SET dataset_id = ?').run(replacement)
    insert(1)
    vi.advanceTimersByTime(30_000)
    expect(personalHistoryIngestionStatus()?.state).toBe('unavailable')
    expect(records()).toHaveLength(1)
    expect(source.biometrics.prepare('SELECT dataset_id FROM biometric_history_identity').get()).toEqual({ dataset_id: replacement })
    expect(fixture.database.prepare('SELECT dataset_id FROM household_history_sources').get()).toEqual({ dataset_id: source.identity.datasetId })
  })

  it('preserves private copies across raw retention and catches later arrivals', () => {
    assign()
    insert(0)
    boot()
    source.biometrics.prepare('DELETE FROM sleep_records').run()
    vi.advanceTimersByTime(16 * 60_000)
    expect(records()).toHaveLength(1)
    insert(1)
    vi.advanceTimersByTime(30_000)
    expect(records()).toHaveLength(2)
  })

  it('stops importing when the last reviewed interval is revoked', () => {
    assign()
    insert(0)
    boot()
    fixture.database.prepare('UPDATE household_attribution_epochs SET revoked_at = ? WHERE id = ?').run(fixture.clock.now, epochId)
    insert(1)
    vi.advanceTimersByTime(30_000)
    expect(personalHistoryIngestionStatus()?.state).toBe('awaiting_review')
    expect(records()).toEqual([])
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_person_records').get()).toEqual({ count: 1 })
  })

  it('keeps one singleton across repeated starts and cancels it before stores close', () => {
    assign()
    insert(0)
    startPersonalHistoryIngestion(fixture.database, source.biometrics)
    startPersonalHistoryIngestion(fixture.database, source.biometrics)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(5000)
    expect(records()).toHaveLength(1)
    stopPersonalHistoryIngestion()
    expect(personalHistoryIngestionStatus()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not recreate missing source identity during automatic retries', () => {
    assign()
    insert(0)
    source.biometrics.prepare('DELETE FROM biometric_history_identity').run()
    boot()
    vi.advanceTimersByTime(60_000)
    expect(personalHistoryIngestionStatus()?.state).toBe('unavailable')
    expect(records()).toEqual([])
    expect(source.biometrics.prepare('SELECT COUNT(*) AS count FROM biometric_history_identity').get()).toEqual({ count: 0 })
  })

  it('catches a newly reviewed older interval on audit without changing earlier ownership', () => {
    const split = start + 10 * day
    history.appendReviewedEpoch({ householdId: fixture.owner.householdId, datasetId: source.identity.datasetId,
      startsAt: split, endsAt: null, expectedAttributionRevision: 1, mode: 'solo_merged', basis: 'verified_arrangement',
      reviewedBy: fixture.owner.accountId, reviewReceiptId: randomUUID(),
      assignments: [{ sleeperId: fixture.owner.selfSleeperId, recordedSide: 'left' }] })
    insert(0)
    insert(11)
    boot()
    expect(records()).toHaveLength(1)
    history.appendReviewedEpoch({ householdId: fixture.owner.householdId, datasetId: source.identity.datasetId,
      startsAt: start, endsAt: split, expectedAttributionRevision: 2, mode: 'solo_merged', basis: 'verified_arrangement',
      reviewedBy: fixture.owner.accountId, reviewReceiptId: randomUUID(),
      assignments: [{ sleeperId: fixture.owner.selfSleeperId, recordedSide: 'left' }] })
    vi.advanceTimersByTime(15 * 60_000)
    expect(records()).toHaveLength(2)
    expect(records(fixture.memberKey)).toEqual([])
  })
})

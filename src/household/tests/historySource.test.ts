import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { personalRuntimeFixture } from './runtimeFixture'
import { historySourceFixture } from './historySourceFixture'
import { PersonHistorySource, prepareBiometricHistoryIdentity, readBiometricHistoryIdentity } from '../historySource'
import { PersonHistoryStore } from '../personHistory'

let fixture: ReturnType<typeof personalRuntimeFixture>
let sourceFixture: ReturnType<typeof historySourceFixture>
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'household-source-'))
  fixture = personalRuntimeFixture()
  sourceFixture = historySourceFixture(fixture.database, fixture.owner, () => fixture.clock.now, join(directory, 'original.db'))
})
afterEach(() => {
  sourceFixture.biometrics.close()
  fixture.database.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('reviewed biometric source binding', () => {
  it('keeps identity across reopening and backup relocation, without touching measurements', async () => {
    const before = sourceFixture.biometrics.prepare('SELECT total_changes() AS count').get()
    expect(prepareBiometricHistoryIdentity(sourceFixture.biometrics, fixture.clock.now)).toEqual(sourceFixture.identity)
    expect(sourceFixture.biometrics.prepare('SELECT total_changes() AS count').get()).toEqual(before)
    await sourceFixture.biometrics.backup(join(directory, 'restored.db'))
    const restored = new Database(join(directory, 'restored.db'))
    try {
      const source = new PersonHistorySource(fixture.database, restored, () => fixture.clock.now)
      expect(readBiometricHistoryIdentity(restored)).toEqual(sourceFixture.identity)
      expect(source.verify(fixture.owner.householdId, sourceFixture.identity.datasetId)).toEqual(sourceFixture.source.bindReviewedSource(sourceFixture.review))
    }
    finally { restored.close() }
    expect(sourceFixture.biometrics.prepare('SELECT COUNT(*) AS count FROM vitals').get()).toEqual({ count: 0 })
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('requires an active owner, the exact prepared identity and the original receipt on replay', () => {
    const { source, review } = sourceFixture
    expect(source.bindReviewedSource(review)).toEqual(source.bindReviewedSource(review))
    expect(() => source.bindReviewedSource({ ...review, reviewedBy: fixture.member.accountId })).toThrow('active household owner')
    expect(() => source.bindReviewedSource({ ...review, datasetId: randomUUID() })).toThrow('source is unavailable or changed')
    expect(() => source.bindReviewedSource({ ...review, reviewReceiptId: randomUUID() })).toThrow('source is unavailable or changed')
    expect(() => source.verify(fixture.member.householdId, randomUUID())).toThrow('source is unavailable or changed')
  })

  it('does not create or repair identity during verification', () => {
    const { biometrics, source, identity } = sourceFixture
    biometrics.prepare('DELETE FROM biometric_history_identity').run()
    expect(() => source.verify(fixture.owner.householdId, identity.datasetId)).toThrow('source is unavailable or changed')
    expect(biometrics.prepare('SELECT COUNT(*) AS count FROM biometric_history_identity').get()).toEqual({ count: 0 })
    const replacement = prepareBiometricHistoryIdentity(biometrics, fixture.clock.now)
    expect(replacement.datasetId).not.toBe(identity.datasetId)
    expect(() => source.verify(fixture.owner.householdId, replacement.datasetId)).toThrow('source is unavailable or changed')
    expect(() => source.bindReviewedSource({ ...sourceFixture.review, datasetId: replacement.datasetId })).toThrow('source is unavailable or changed')
  })

  it('requires a reviewed binding even when the recording database has a valid identity', () => {
    fixture.database.prepare('DELETE FROM household_history_sources').run()
    const { source, identity } = sourceFixture
    expect(() => source.verify(fixture.owner.householdId, identity.datasetId)).toThrow('source is unavailable or changed')
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_history_sources').get()).toEqual({ count: 0 })
    expect(readBiometricHistoryIdentity(sourceFixture.biometrics)).toEqual(identity)
  })

  it('rejects a review replay after the reviewing account is revoked', () => {
    fixture.database.prepare('UPDATE household_accounts SET state = \'revoked\' WHERE id = ?').run(fixture.owner.accountId)
    expect(() => sourceFixture.source.bindReviewedSource(sourceFixture.review)).toThrow('active household owner')
  })

  it.each(['wrong_id', 'malformed_uuid', 'extra_row', 'future_created', 'future_binding'])('rejects damaged or future metadata: %s', (damage) => {
    const { biometrics, source, identity } = sourceFixture
    if (damage === 'wrong_id') biometrics.prepare('UPDATE biometric_history_identity SET id = 2').run()
    if (damage === 'malformed_uuid') biometrics.prepare('UPDATE biometric_history_identity SET dataset_id = \'bad\'').run()
    if (damage === 'extra_row') biometrics.prepare('INSERT INTO biometric_history_identity VALUES (2, ?, ?)').run(randomUUID(), fixture.clock.now)
    if (damage === 'future_created') biometrics.prepare('UPDATE biometric_history_identity SET created_at_ms = ?').run(fixture.clock.now + 1)
    if (damage === 'future_binding') fixture.database.prepare('UPDATE household_history_sources SET bound_at = ?').run(fixture.clock.now + 1)
    expect(() => source.verify(fixture.owner.householdId, identity.datasetId)).toThrow('source is unavailable or changed')
  })

  it('withdraws new attribution/import on replacement while preserving already-private records', () => {
    const { source, identity, biometrics } = sourceFixture
    const history = new PersonHistoryStore(fixture.database, fixture.identities, source, () => fixture.clock.now)
    const start = fixture.clock.now
    const epoch = { householdId: fixture.owner.householdId, datasetId: identity.datasetId, startsAt: start,
      endsAt: null, mode: 'assigned', assignments: [{ sleeperId: fixture.owner.selfSleeperId, recordedSide: 'right' }],
      basis: 'verified_arrangement', reviewedBy: fixture.owner.accountId, reviewReceiptId: randomUUID(), expectedAttributionRevision: 1 }
    const initial = history.appendReviewedEpoch(epoch)
    fixture.clock.now += 3_600_000
    const observation = { householdId: fixture.owner.householdId, datasetId: identity.datasetId, sourceRecordKey: 'presence:1',
      recordedSide: 'right', startsAt: start, endsAt: fixture.clock.now,
      payload: { kind: 'presence', reportedPresenceSeconds: 3_500, exits: 1, interpretation: 'bed_presence_not_sleep' } }
    const admitted = history.admitObservation(observation)
    expect(admitted.status).toBe('admitted')
    biometrics.prepare('UPDATE biometric_history_identity SET dataset_id = ?').run(randomUUID())
    expect(() => history.admitObservation(observation)).toThrow('source is unavailable or changed')
    expect(() => history.appendReviewedEpoch(epoch)).toThrow('source is unavailable or changed')
    expect(() => history.transitionReviewedEpoch(initial.epochId, { ...epoch, startsAt: fixture.clock.now,
      expectedAttributionRevision: initial.attributionRevision, reviewReceiptId: randomUUID(),
      assignments: [{ sleeperId: fixture.member.selfSleeperId, recordedSide: 'right' }] })).toThrow('source is unavailable or changed')
    expect(fixture.database.prepare('SELECT ends_at FROM household_attribution_epochs WHERE id = ?').get(initial.epochId)).toEqual({ ends_at: null })
    expect(fixture.database.prepare('SELECT attribution_revision AS revision FROM household_history_state WHERE household_id = ?')
      .get(fixture.owner.householdId)).toEqual({ revision: initial.attributionRevision })
    const records = history.records(fixture.ownerKey, { startsAt: start, endsAt: fixture.clock.now, kind: 'presence' }).records
    expect(records.map(record => record.id)).toEqual([admitted.personRecordId])
    expect(history.records(fixture.memberKey, { startsAt: start, endsAt: fixture.clock.now, kind: 'presence' }).records).toEqual([])
  })
})

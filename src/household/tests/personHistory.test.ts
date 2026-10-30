import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { HouseholdStore } from '../store'
import { PersonHistoryStore } from '../personHistory'
import type { AttributionEpochInput, SourceObservation } from '../historyContract'

const hour = 3600_000
const day = 24 * hour
const setupAt = Date.parse('2026-10-29T22:00:00Z')
const secret = () => randomBytes(32).toString('base64url')
function requiredValue(value: string | null | undefined): string {
  if (!value) throw new Error('Expected a saved record or continuation cursor')
  return value
}
let database: Database.Database, identities: HouseholdStore, history: PersonHistoryStore
let ownerKey: string, memberKey: string, datasetId: string, now: number
let householdId: string, ownerId: string, ownerSleeper: string, memberSleeper: string
const context = () => ({ requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1 })
function epoch(overrides: Partial<AttributionEpochInput> = {}): AttributionEpochInput {
  return { householdId, datasetId, startsAt: setupAt, endsAt: null, mode: 'solo_merged',
    assignments: [{ sleeperId: ownerSleeper, recordedSide: 'left' }], basis: 'verified_arrangement',
    reviewReceiptId: randomUUID(), reviewedBy: ownerId, expectedAttributionRevision: 1, ...overrides }
}
function observation(overrides: Partial<SourceObservation> = {}): SourceObservation {
  return { householdId, datasetId, sourceRecordKey: randomUUID(), recordedSide: 'left',
    startsAt: setupAt + hour, endsAt: setupAt + 9 * hour,
    payload: { kind: 'presence', reportedPresenceSeconds: 8 * 3600, exits: 1, interpretation: 'bed_presence_not_sleep' }, ...overrides }
}
const query = () => ({ startsAt: setupAt - 10 * day, endsAt: setupAt + 10 * day, kind: 'presence', limit: 30 })
function transition(previousEpochId: string, startsAt = setupAt + day) {
  return history.transitionReviewedEpoch(previousEpochId, epoch({ startsAt, expectedAttributionRevision: 2, mode: 'assigned',
    assignments: [{ sleeperId: memberSleeper, recordedSide: 'left' }, { sleeperId: ownerSleeper, recordedSide: 'right' }] }))
}

beforeEach(() => {
  database = migratedComfortDatabase()
  database.pragma('foreign_keys = ON')
  now = setupAt
  identities = new HouseholdStore(database, () => now)
  ownerKey = secret()
  memberKey = secret()
  datasetId = randomUUID()
  const owner = identities.setup({ requestId: randomUUID(), displayName: 'Owner', deviceName: 'Owner phone', deviceSecret: ownerKey,
    currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  householdId = owner.householdId
  ownerId = owner.accountId
  ownerSleeper = owner.selfSleeperId
  const invitation = identities.createInvitation(ownerKey, { ...context(), invitation: secret(), kind: 'new_person', expiresInMinutes: 30 })
  memberSleeper = identities.join({ invitation: invitation.invitation, deviceSecret: memberKey, deviceName: 'Member phone', displayName: 'Member' }).selfSleeperId
  history = new PersonHistoryStore(database, identities, () => now)
  now = setupAt + 10 * day
})
afterEach(() => database.close())

describe('dated private history ownership', () => {
  it('does not claim raw history or change live settings when either person signs up', () => {
    expect(database.prepare('SELECT count(*) AS count FROM household_attribution_epochs').get()).toEqual({ count: 0 })
    expect(history.records(ownerKey, query()).records).toEqual([])
    expect(history.records(memberKey, query()).records).toEqual([])
    expect(identities.session(ownerKey).capabilities.personalHistory).toBe(false)
    expect(database.prepare('SELECT count(*) AS count FROM device_settings').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT count(*) AS count FROM bedtime_routines').get()).toEqual({ count: 0 })
  })

  it('preserves Luca-like solo history across a Marissa-like left / owner-right transition', () => {
    const first = history.appendReviewedEpoch(epoch())
    const original = history.admitObservation(observation())
    transition(first.epochId)
    const memberNight = history.admitObservation(observation({ startsAt: setupAt + day + hour, endsAt: setupAt + day + 9 * hour }))
    const ownerNight = history.admitObservation(observation({ recordedSide: 'right', startsAt: setupAt + day + hour, endsAt: setupAt + day + 9 * hour }))
    expect([original.status, memberNight.status, ownerNight.status]).toEqual(['admitted', 'admitted', 'admitted'])
    const ownerRecords = history.records(ownerKey, query()).records
    expect(ownerRecords.map(record => record.id)).toEqual([ownerNight.personRecordId, original.personRecordId])
    expect(ownerRecords.map(record => record.recordedSide)).toEqual(['right', 'left'])
    expect(history.records(memberKey, query()).records.map(record => record.id)).toEqual([memberNight.personRecordId])
    expect(history.record(ownerKey, requiredValue(memberNight.personRecordId))).toBeNull()
    expect(history.record(memberKey, requiredValue(original.personRecordId))).toBeNull()
    expect(history.record(ownerKey, randomUUID())).toBeNull()
    expect(ownerRecords[1].attribution.identity).toBe('reviewed_arrangement_not_biometric_identification')
    expect(ownerRecords[1].payload.kind).toBe('presence')
  })

  it('withholds a whole record spanning a change, but admits exact half-open boundaries', () => {
    const first = history.appendReviewedEpoch(epoch())
    transition(first.epochId)
    expect(history.admitObservation(observation({ startsAt: setupAt + 20 * hour, endsAt: setupAt + 28 * hour })).status).toBe('withheld')
    const earlier = history.admitObservation(observation({ startsAt: setupAt + 16 * hour, endsAt: setupAt + day }))
    const later = history.admitObservation(observation({ startsAt: setupAt + day, endsAt: setupAt + 32 * hour }))
    expect(history.record(ownerKey, requiredValue(earlier.personRecordId))?.endsAt).toBe(setupAt + day)
    expect(history.record(memberKey, requiredValue(later.personRecordId))?.startsAt).toBe(setupAt + day)
    expect(history.admitObservation(observation({ startsAt: setupAt + day - 1, endsAt: setupAt + day + 1,
      payload: { kind: 'vitals', heartRateBpm: 60, breathingRatePerMinute: 14, hrvMs: 30, hrvMetric: 'unknown' } })).status).toBe('withheld')
  })

  it('merges no extra duration from the other solo zone and withholds overlapping retries', () => {
    history.appendReviewedEpoch(epoch())
    const input = observation()
    const first = history.admitObservation(input)
    expect(history.admitObservation(input)).toEqual({ status: 'unchanged', personRecordId: first.personRecordId })
    expect(history.admitObservation({ ...input, sourceRecordKey: randomUUID() })).toEqual({ status: 'withheld', reason: 'overlapping_presence' })
    expect(history.admitObservation({ ...input, sourceRecordKey: randomUUID(), recordedSide: 'right' })).toEqual({ status: 'withheld', reason: 'unassigned' })
    expect(history.records(ownerKey, query()).records).toHaveLength(1)
  })

  it('requires an explicit owner-only legacy review without assigning those rows to a new member', () => {
    const legacy = epoch({ startsAt: setupAt - 2 * day, endsAt: setupAt, basis: 'legacy_owner_review' })
    const input = observation({ startsAt: setupAt - day, endsAt: setupAt - day + 8 * hour })
    expect(history.admitObservation(input).status).toBe('withheld')
    expect(() => history.appendReviewedEpoch({ ...legacy, assignments: [{ sleeperId: memberSleeper, recordedSide: 'left' }] })).toThrow('eligible sleeper')
    history.appendReviewedEpoch(legacy)
    expect(history.admitObservation(input).status).toBe('admitted')
    expect(history.records(ownerKey, query()).records[0].attribution.basis).toBe('legacy_owner_review')
    expect(history.records(memberKey, query()).records).toHaveLength(0)
    expect(() => history.appendReviewedEpoch(epoch({ basis: 'legacy_owner_review' }))).toThrow('before household')
    expect(() => history.appendReviewedEpoch(epoch({ startsAt: setupAt - day }))).toThrow('separate legacy review')
  })

  it('rejects stale reviews, overlapping epochs, nonmembers, future claims and changed receipt replays', () => {
    const input = epoch(), first = history.appendReviewedEpoch(input)
    expect(history.appendReviewedEpoch(input)).toEqual(first)
    expect(() => history.appendReviewedEpoch({ ...input, mode: 'assigned' })).toThrow('receipt')
    expect(() => history.appendReviewedEpoch(epoch())).toThrow('Attribution changed')
    expect(() => history.appendReviewedEpoch(epoch({ expectedAttributionRevision: 2 }))).toThrow('cannot overlap')
    expect(() => history.appendReviewedEpoch(epoch({ reviewedBy: identities.session(memberKey).accountId }))).toThrow('active household owner')
    expect(() => history.appendReviewedEpoch(epoch({ assignments: [{ sleeperId: randomUUID(), recordedSide: 'left' }] }))).toThrow('eligible sleeper')
    expect(() => history.appendReviewedEpoch(epoch({ startsAt: now + 1 }))).toThrow('Future attribution')
    expect(() => history.appendReviewedEpoch(epoch({ assignments: [{ sleeperId: ownerSleeper, recordedSide: 'left' }, { sleeperId: ownerSleeper, recordedSide: 'right' }] }))).toThrow()
  })

  it('rolls back a failed transition and never moves records already admitted to a person', () => {
    const first = history.appendReviewedEpoch(epoch())
    history.admitObservation(observation())
    expect(() => transition(first.epochId, setupAt + 5 * hour)).toThrow('already-attributed')
    expect(database.prepare('SELECT ends_at FROM household_attribution_epochs WHERE id = ?').get(first.epochId)).toEqual({ ends_at: null })
    const bad = epoch({ startsAt: setupAt + day, expectedAttributionRevision: 2, assignments: [{ sleeperId: randomUUID(), recordedSide: 'left' }] })
    expect(() => history.transitionReviewedEpoch(first.epochId, bad)).toThrow('eligible sleeper')
    expect(database.prepare('SELECT ends_at FROM household_attribution_epochs WHERE id = ?').get(first.epochId)).toEqual({ ends_at: null })
    const valid = epoch({ startsAt: setupAt + day, expectedAttributionRevision: 2 })
    const saved = history.transitionReviewedEpoch(first.epochId, valid)
    expect(history.transitionReviewedEpoch(first.epochId, valid)).toEqual(saved)
    expect(() => history.transitionReviewedEpoch(randomUUID(), valid)).toThrow('receipt')
    expect(() => history.appendReviewedEpoch(valid)).toThrow('receipt')
  })

  it('quarantines changed sources and does not revive them through old replays or another claimant', () => {
    history.appendReviewedEpoch(epoch())
    const input = observation(), saved = history.admitObservation(input)
    const changed = { ...input, payload: { ...input.payload, reportedPresenceSeconds: 3600 } }
    expect(history.admitObservation(changed)).toEqual({ status: 'withheld', reason: 'source_changed' })
    expect(history.record(ownerKey, requiredValue(saved.personRecordId))).toBeNull()
    expect(history.admitObservation(input)).toEqual({ status: 'withheld', reason: 'source_changed' })
    expect(history.records(ownerKey, query()).records).toHaveLength(0)
  })

  it('pins pagination to self, filter, revision and watermark while new rows wait for refresh', () => {
    history.appendReviewedEpoch(epoch())
    for (let index = 0; index < 3; index++)
      history.admitObservation(observation({ startsAt: setupAt + index * day + hour, endsAt: setupAt + index * day + 9 * hour }))
    const pageQuery = { ...query(), limit: 1 }
    const first = history.records(ownerKey, pageQuery)
    const incoming = observation({ startsAt: setupAt + 4 * day, endsAt: setupAt + 4 * day + 8 * hour })
    const added = history.admitObservation(incoming)
    const second = history.records(ownerKey, { ...pageQuery, cursor: first.nextCursor })
    expect(second.records[0].id).not.toBe(added.personRecordId)
    expect(() => history.records(memberKey, { ...pageQuery, cursor: first.nextCursor })).toThrow('different context')
    expect(() => history.records(ownerKey, { ...pageQuery, limit: 2, cursor: first.nextCursor })).toThrow('different context')
    const [encoded, signature] = requiredValue(first.nextCursor).split('.')
    const forged = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    forged.watermark += 100
    expect(() => history.records(ownerKey, { ...pageQuery, cursor: `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}` })).toThrow('expired')
    expect(() => new PersonHistoryStore(database, identities).records(ownerKey, { ...pageQuery, cursor: first.nextCursor })).toThrow('expired')
    history.admitObservation({ ...incoming, payload: { kind: 'presence', exits: 3, interpretation: 'bed_presence_not_sleep', reportedPresenceSeconds: 3600 } })
    expect(() => history.records(ownerKey, { ...pageQuery, cursor: second.nextCursor })).toThrow('expired')
  })

  it('rechecks revoked credentials on list and detail, including retained cursor requests', () => {
    history.appendReviewedEpoch(epoch())
    const saved = history.admitObservation(observation())
    const device = identities.deviceIdentity(ownerKey)
    database.prepare('UPDATE household_devices SET revoked_at = ? WHERE id = ?').run(now, device)
    expect(() => history.records(ownerKey, query())).toThrow('revoked')
    expect(() => history.record({ deviceId: device }, requiredValue(saved.personRecordId))).toThrow('revoked')
    expect(() => history.records(secret(), query())).toThrow('unavailable')
  })

  it('orders late-arriving historical rows by observation time and keeps foreign data out of aggregates', () => {
    const first = history.appendReviewedEpoch(epoch())
    transition(first.epochId)
    const later = history.admitObservation(observation({ recordedSide: 'right', startsAt: setupAt + 3 * day, endsAt: setupAt + 3 * day + 8 * hour }))
    const earlier = history.admitObservation(observation())
    history.admitObservation(observation({ recordedSide: 'left', startsAt: setupAt + 3 * day, endsAt: setupAt + 3 * day + 8 * hour }))
    const page = history.records(ownerKey, { ...query(), limit: 1 })
    expect(page.records.map(record => record.id)).toEqual([later.personRecordId])
    const next = history.records(ownerKey, { ...query(), limit: 1, cursor: page.nextCursor })
    expect(next.records.map(record => record.id)).toEqual([earlier.personRecordId])
    expect(next.nextCursor).toBeNull()
    expect(history.records(ownerKey, { ...query(), kind: 'vitals' }).records).toEqual([])
  })

  it('rejects malformed units, unknown fields, open/future records and impossible reported durations', () => {
    history.appendReviewedEpoch(epoch())
    expect(() => history.admitObservation({ ...observation(), sleeperId: ownerSleeper })).toThrow()
    expect(() => history.admitObservation(observation({ endsAt: setupAt + hour }))).toThrow()
    expect(() => history.admitObservation(observation({ endsAt: now + 1, startsAt: now - 8 * hour }))).toThrow('Future or incomplete')
    expect(() => history.admitObservation(observation({ endsAt: setupAt + 3 * hour }))).toThrow('Reported presence')
    expect(() => history.records(ownerKey, { ...query(), endsAt: setupAt + 200 * day })).toThrow()
    expect(() => history.records(ownerKey, { ...query(), sleeperId: memberSleeper })).toThrow()
    expect(history.admitObservation(observation({ startsAt: setupAt / 1000, endsAt: setupAt / 1000 + 8 * hour })).status).toBe('withheld')
  })
})

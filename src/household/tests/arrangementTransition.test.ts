import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/schema'
import { installHardwareAdmission, beginHardwareWrite, captureHardwareIntent, waitForHardwareDrain } from '@/src/hardware/admission'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { readBedtimeRoutineState, replaceBedtimeRoutineBatch } from '@/src/server/bedtimeRoutineTransaction'
import { createComfortLimitStore } from '@/src/temperature/limitStore'
import { defaultComfortState } from '@/src/comfort/policy'
import type { BedtimeDraft } from '@/src/lib/bedtimeRoutines'
import { ArrangementReviewService } from '../arrangementReviews'
import { ArrangementTransitionStore } from '../arrangementTransition'
import { PersonHistoryStore } from '../personHistory'
import { committedArrangementDigest } from '../arrangementTransitionState'
import { historySourceFixture } from './historySourceFixture'
import { personalRuntimeFixture } from './runtimeFixture'
import type { ArrangementObservation, ArrangementTransitionRequest } from '../arrangementTransitionContract'

const night: BedtimeDraft = {
  power: { onTime: '22:00', offTime: '07:15', onTemperature: 70, enabled: true, endAction: 'maintain' }, temperatures: [],
  alarm: { time: '07:00', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 20, alarmTemperature: 105, enabled: true,
    wakeWindow: 0, snoozeDuration: 540, snoozeTaper: 30 }, notes: 'Owner private operating week',
}
let fixture: ReturnType<typeof personalRuntimeFixture>, source: ReturnType<typeof historySourceFixture>
let reviews: ArrangementReviewService, history: PersonHistoryStore, transition: ArrangementTransitionStore, admission: HardwareAdmissionStore
let request: ArrangementTransitionRequest, proof: ArrangementObservation, uninstall: () => void, folder: string, runId: string, enabled: boolean
let finishes: (() => void)[]
const context = (key = fixture.ownerKey) => {
  const session = fixture.identities.session(key)
  return { requestId: randomUUID(), expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision }
}
const state = () => ['hardware_admission', 'households', 'household_accounts', 'side_settings', 'device_settings', 'household_personal_settings',
  'bedtime_routines', 'power_schedules', 'temperature_schedules', 'alarm_schedules', 'temperature_limits', 'comfort_states',
  'household_arrangement_reviews', 'household_arrangement_transitions', 'household_attribution_epochs', 'household_history_state',
  'biometric_profile_bindings', 'biometric_profile_revisions', 'biometric_activation_events', 'biometric_config_outbox']
  .map(table => fixture.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
const generation = () => ({ version: 1, invocationId: 'a'.repeat(32), bootId: runId, pid: 1234, startTicks: '1000', observedAt: fixture.clock.now })
const makeStore = (runtimeId = runId, controllerGeneration: () => unknown = generation) => new ArrangementTransitionStore({ database: fixture.database, identities: fixture.identities,
  reviews, history, historySource: source.source, enabled: () => enabled, observe: () => proof, runId: runtimeId, now: () => fixture.clock.now,
  controllerGeneration })
const ownWeek = (side: 'left' | 'right') => readBedtimeRoutineState(drizzle(fixture.database, { schema }), side).records.map(row => row.snapshot)

beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), 'sleepypod-arrangement-'))
  fixture = personalRuntimeFixture(path.join(folder, 'configuration.db'))
  fixture.database.pragma('journal_mode = WAL')
  source = historySourceFixture(fixture.database, fixture.owner, () => fixture.clock.now)
  history = new PersonHistoryStore(fixture.database, fixture.identities, source.source, () => fixture.clock.now)
  history.appendReviewedEpoch({ householdId: fixture.owner.householdId, datasetId: source.identity.datasetId, expectedAttributionRevision: 1,
    startsAt: fixture.clock.now, endsAt: null, mode: 'solo_merged', basis: 'verified_arrangement', reviewReceiptId: randomUUID(),
    reviewedBy: fixture.owner.accountId, assignments: [{ sleeperId: fixture.owner.selfSleeperId, recordedSide: 'left' }] })
  fixture.clock.now += 2000
  for (const key of [fixture.ownerKey, fixture.memberKey]) {
    const prior = fixture.identities.preferences(key)
    fixture.identities.updatePreferences(key, { ...context(key), expectedRevision: prior.revision,
      preferences: { ...prior.preferences, preferredTemperatureF: key === fixture.ownerKey ? 70 : 82 } })
    fixture.identities.updateRoutines(key, { ...context(key), expectedRevision: fixture.identities.routines(key).revision,
      routines: [{ dayOfWeek: 'friday', draft: { ...night, alarm: null, power: { ...night.power, onTemperature: key === fixture.ownerKey ? 90 : 82 },
        notes: key === fixture.ownerKey ? 'Unpublished owner draft' : 'Partner private draft' } }] })
  }
  replaceBedtimeRoutineBatch(fixture.database, [{ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: night }] }])
  createComfortLimitStore(fixture.database).save('left', 0, { enabled: true, minF: 68, maxF: 72 })
  fixture.database.prepare('INSERT INTO comfort_states(side, state) VALUES (?, ?)').run('left', JSON.stringify({ ...defaultComfortState(), config: { mode: 'preview', minimumF: 68, maximumF: 72 }, offsetF: -2 }))
  reviews = new ArrangementReviewService({ database: fixture.database, identities: fixture.identities, enabled: () => true, now: () => fixture.clock.now })
  const review = reviews.propose(fixture.ownerKey, { ...context(), version: 1, ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true })
  for (const key of [fixture.ownerKey, fixture.memberKey]) reviews.approve(key, { ...context(key), version: 1, reviewId: review.reviewId,
    issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000, confirmMySide: true, confirmMyRoutine: true, acknowledgeSeparateActivation: true })
  runId = randomUUID()
  enabled = true
  proof = { runId, presence: { observedAt: fixture.clock.now, left: 'empty', right: 'empty' },
    thermal: { observedAt: fixture.clock.now, leftPowered: false, rightPowered: false, water: 'ok', priming: false },
    alarm: { observedAt: fixture.clock.now, vibrating: false, snoozing: false }, base: { observedAt: fixture.clock.now, state: 'stationary' } }
  request = { ...context(), version: 1, reviewId: review.reviewId, issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000,
    confirmEmptyAndAttended: true, confirmClearTemporaryActions: true, confirmPauseLearningAndSharedAutomations: true, acknowledgeHeldUntilRecovery: true }
  admission = new HardwareAdmissionStore(fixture.database, () => fixture.clock.now)
  uninstall = installHardwareAdmission(admission)
  finishes = []
  transition = makeStore()
})
afterEach(() => {
  for (const finish of finishes) finish()
  uninstall?.()
  source?.biometrics.close()
  fixture?.database.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('atomic reviewed arrangement storage', () => {
  it.each(['missing', 'stale', 'future'])('requires %s controller proof to be corrected before holding', (problem) => {
    const controller = generation()
    if (problem === 'stale') controller.observedAt -= 5001
    if (problem === 'future') controller.observedAt++
    const store = makeStore(runId, () => problem === 'missing' ? null : controller)
    expect(() => store.begin(fixture.ownerKey, request)).toThrow()
    expect(admission.read().holdId).toBeNull()
  })

  it.each(['invocationId', 'pid', 'startTicks', 'bootId'] as const)('keeps held after actual %s changes even with an unchanged app run ID', (field) => {
    const controller = generation()
    const store = makeStore(runId, () => controller)
    store.begin(fixture.ownerKey, request)
    if (field === 'invocationId') controller.invocationId = 'b'.repeat(32)
    if (field === 'pid') controller.pid++
    if (field === 'startTicks') controller.startTicks = '2000'
    if (field === 'bootId') controller.bootId = randomUUID()
    const before = state()
    expect(() => store.commit(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
    expect(admission.read().holdId).toBe(request.requestId)
  })

  it('holds and records together, changes both weeks and identities together, and stays closed for recovery', async () => {
    const operating = ownWeek('left')[0]?.draft
    const draft = fixture.identities.routines(fixture.ownerKey)
    const held = transition.begin(fixture.ownerKey, request)
    expect(held).toMatchObject({ state: 'held', admissionRevision: 2 })
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
    await waitForHardwareDrain(request.requestId)
    const committed = transition.commit(fixture.ownerKey, request)
    expect(committed).toMatchObject({ state: 'committed', hardware: 'held_for_runtime_recovery' })
    expect(ownWeek('right')).toMatchObject([{ dayOfWeek: 'monday', draft: operating }])
    expect(ownWeek('left')).toMatchObject([{ dayOfWeek: 'friday', draft: { notes: 'Partner private draft', power: { onTemperature: 82 }, alarm: null } }])
    expect(fixture.identities.routines(fixture.ownerKey)).toMatchObject({ revision: draft.revision, routines: draft.routines })
    expect(fixture.identities.session(fixture.ownerKey)).toMatchObject({ sessionRevision: 2, assignmentRevision: 2, self: { assignment: 'right' } })
    expect(fixture.identities.session(fixture.memberKey)).toMatchObject({ sessionRevision: 2, assignmentRevision: 2, self: { assignment: 'left' } })
    expect(createComfortLimitStore(fixture.database).read('right').config).toEqual({ enabled: true, minF: 68, maxF: 72 })
    expect(createComfortLimitStore(fixture.database).read('left').config.enabled).toBe(false)
    expect(fixture.database.prepare('SELECT state FROM comfort_states').all().map(row => JSON.parse((row as { state: string }).state).config.mode)).toEqual(['off', 'off'])
    expect(fixture.database.prepare('SELECT bed_mode, autopilot_enabled FROM device_settings').get()).toEqual({ bed_mode: 'two', autopilot_enabled: 0 })
    expect(admission.read()).toEqual({ revision: 2, holdId: request.requestId })
    const saved = fixture.database.prepare('SELECT archive, committed_hash FROM household_arrangement_transitions').get() as { archive: string, committed_hash: string }
    expect(saved.archive).toContain('offsetF')
    expect(saved.archive).not.toContain('mqtt_password')
    expect(saved.committed_hash).toBe(committedArrangementDigest(fixture.database, fixture.owner.householdId))
    expect(JSON.stringify(committed)).not.toMatch(/Partner private draft|Owner private operating|offsetF/)
  })

  it('retains private copies and withholds the reload interval instead of attributing old pipeline output to the new sleeper', () => {
    const sample = { householdId: fixture.owner.householdId, datasetId: source.identity.datasetId, sourceRecordKey: 'old-night', recordedSide: 'left',
      startsAt: fixture.clock.now - 1500, endsAt: fixture.clock.now - 500, payload: { kind: 'presence', reportedPresenceSeconds: 1, exits: 0, interpretation: 'bed_presence_not_sleep' } }
    expect(history.admitObservation(sample).status).toBe('admitted')
    const before = fixture.database.prepare('SELECT * FROM household_person_records').all()
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    expect(fixture.database.prepare('SELECT * FROM household_person_records').all()).toEqual(before)
    const boundary = fixture.clock.now
    fixture.clock.now += 2000
    expect(history.admitObservation({ ...sample, sourceRecordKey: 'new-night', startsAt: boundary, endsAt: boundary + 1000 }).status).toBe('withheld')
    expect(history.admitObservation({ ...sample, sourceRecordKey: 'crossing-night', startsAt: boundary - 500, endsAt: boundary + 500 }).status).toBe('withheld')
    expect(fixture.database.prepare('SELECT source_record_key, sleeper_id FROM household_person_records ORDER BY sequence').all()).toEqual([
      { source_record_key: 'old-night', sleeper_id: fixture.owner.selfSleeperId },
    ])
  })

  it('makes lost-response replays idempotent without replaying writes after request expiry or restart', () => {
    expect(transition.begin(fixture.ownerKey, request)).toEqual(transition.begin(fixture.ownerKey, request))
    transition.commit(fixture.ownerKey, request)
    const before = state()
    fixture.clock.now += 60_000
    expect(makeStore(randomUUID()).commit(fixture.ownerKey, request).state).toBe('committed')
    expect(transition.begin(fixture.ownerKey, request).state).toBe('committed')
    expect(state()).toEqual(before)
    expect(() => transition.commit(fixture.ownerKey, { ...request, expiresAt: request.expiresAt + 1 })).toThrow()
  })

  it.each(['receipt', 'routine', 'identity', 'final_receipt'] as const)('rolls back every related table when %s cannot be written', (failure) => {
    const table = failure === 'receipt' || failure === 'final_receipt' ? 'household_arrangement_transitions' : failure === 'routine' ? 'alarm_schedules' : 'households'
    const event = failure === 'receipt' || failure === 'routine' ? 'INSERT' : 'UPDATE'
    if (failure !== 'receipt') transition.begin(fixture.ownerKey, request)
    const before = state()
    fixture.database.exec(`CREATE TRIGGER fail_transition BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected_disk_failure'); END`)
    expect(() => failure === 'receipt' ? transition.begin(fixture.ownerKey, request) : transition.commit(fixture.ownerKey, request)).toThrow('injected_disk_failure')
    expect(state()).toEqual(before)
    expect(admission.read().holdId).toBe(failure === 'receipt' ? null : request.requestId)
  })

  it.each(['expired', 'stop'])('rechecks %s after the final receipt write and rolls back the whole configuration', (problem) => {
    transition.begin(fixture.ownerKey, request)
    fixture.database.function('interrupt_commit', () => {
      if (problem === 'expired') fixture.clock.now = request.expiresAt
      else finishes.push(beginHardwareWrite(captureHardwareIntent(), true))
      return 1
    })
    fixture.database.exec('CREATE TRIGGER interrupt_transition AFTER UPDATE OF state ON household_arrangement_transitions BEGIN SELECT interrupt_commit(); END')
    const before = state()
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
    expect(admission.read()).toEqual({ revision: 2, holdId: request.requestId })
  })

  it.each(['presence', 'thermal', 'alarm', 'base'] as const)('rejects independently stale or future %s evidence before hold and before commit', (sourceName) => {
    const fresh = proof[sourceName].observedAt
    proof[sourceName].observedAt -= 5001
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    expect(admission.read().holdId).toBeNull()
    proof[sourceName].observedAt = fresh
    transition.begin(fixture.ownerKey, request)
    const before = state()
    proof[sourceName].observedAt = fresh + 1
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
  })

  it.each(['presence', 'thermal', 'alarm', 'base'] as const)('rejects active, unknown or missing %s observations', (sourceName) => {
    const bad = {
      presence: { ...proof.presence, left: 'unknown' }, thermal: { ...proof.thermal, leftPowered: true },
      alarm: { ...proof.alarm, snoozing: true }, base: { ...proof.base, state: 'moving' },
    }
    proof = { ...proof, [sourceName]: bad[sourceName] } as ArrangementObservation
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    expect(admission.read().holdId).toBeNull()
  })

  it.each(['cancel', 'revoke', 'routine', 'preference', 'limits', 'source', 'epoch'] as const)('keeps admission held when %s changes after the hold', (change) => {
    transition.begin(fixture.ownerKey, request)
    if (change === 'cancel') reviews.cancel(fixture.memberKey, { ...context(fixture.memberKey), version: 1, reviewId: request.reviewId })
    if (change === 'revoke') fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?').run(fixture.clock.now, fixture.member.accountId)
    if (change === 'routine') fixture.database.prepare('UPDATE household_personal_settings SET routines_revision = routines_revision + 1 WHERE account_id = ?').run(fixture.member.accountId)
    if (change === 'preference') fixture.database.prepare('UPDATE household_personal_settings SET preferences_revision = preferences_revision + 1 WHERE account_id = ?').run(fixture.owner.accountId)
    if (change === 'limits') createComfortLimitStore(fixture.database).save('left', 1, { enabled: true, minF: 69, maxF: 73 })
    if (change === 'source') source.biometrics.prepare('UPDATE biometric_history_identity SET dataset_id = ?').run(randomUUID())
    if (change === 'epoch') fixture.database.prepare('UPDATE household_attribution_epochs SET revoked_at = ?').run(fixture.clock.now)
    const before = state()
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
    expect(admission.read().holdId).toBe(request.requestId)
  })

  it('cannot begin as a member, use another request ID or take an unrelated hold', () => {
    expect(() => transition.begin(fixture.memberKey, { ...request, ...context(fixture.memberKey) })).toThrow()
    expect(admission.read().holdId).toBeNull()
    transition.begin(fixture.ownerKey, request)
    expect(() => transition.begin(fixture.ownerKey, { ...request, requestId: randomUUID() })).toThrow()
    expect(() => transition.commit(fixture.memberKey, request)).toThrow()
    expect(admission.read().holdId).toBe(request.requestId)
  })

  it('requires both approvals and an existing reviewed solo history source, never creating either', () => {
    const approvals = fixture.database.prepare('SELECT * FROM household_arrangement_approvals').all() as Record<string, string | number>[]
    fixture.database.prepare('DELETE FROM household_arrangement_approvals WHERE account_id = ?').run(fixture.member.accountId)
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    for (const row of approvals.filter(row => row.account_id === fixture.member.accountId)) fixture.database.prepare('INSERT INTO household_arrangement_approvals (request_id, review_id, account_id, device_id, request_hash, created_at) VALUES (@request_id, @review_id, @account_id, @device_id, @request_hash, @created_at)').run(row)
    fixture.database.prepare('DELETE FROM household_history_sources').run()
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    expect(admission.read().holdId).toBeNull()
    expect(fixture.database.prepare('SELECT * FROM household_history_sources').all()).toEqual([])
  })

  it('does not invent a missing receipt for an orphaned hardware hold', () => {
    admission.hold(request.requestId)
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    expect(fixture.database.prepare('SELECT * FROM household_arrangement_transitions').all()).toEqual([])
    expect(admission.read()).toEqual({ revision: 2, holdId: request.requestId })
  })

  it.each(['request_hash', 'request', 'context', 'state'] as const)('rejects a corrupt saved %s without releasing admission', (column) => {
    transition.begin(fixture.ownerKey, request)
    fixture.database.prepare(`UPDATE household_arrangement_transitions SET ${column} = ?`).run('corrupt')
    const before = state()
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
    expect(admission.read().holdId).toBe(request.requestId)
  })

  it('retains holds and complete committed state when the database is reopened', () => {
    transition.begin(fixture.ownerKey, request)
    let reopened = new Database(path.join(folder, 'configuration.db'))
    expect(new HardwareAdmissionStore(reopened).read()).toEqual({ revision: 2, holdId: request.requestId })
    expect(reopened.prepare('SELECT state FROM household_arrangement_transitions').get()).toEqual({ state: 'held' })
    reopened.close()
    transition.commit(fixture.ownerKey, request)
    reopened = new Database(path.join(folder, 'configuration.db'))
    try {
      expect(new HardwareAdmissionStore(reopened).read()).toEqual({ revision: 2, holdId: request.requestId })
      expect(reopened.prepare('SELECT state FROM household_arrangement_transitions').get()).toEqual({ state: 'committed' })
      expect(committedArrangementDigest(reopened, fixture.owner.householdId)).toBe(committedArrangementDigest(fixture.database, fixture.owner.householdId))
    }
    finally { reopened.close() }
  })

  it('clears transient actions and disables old automatic owners while preserving their recovery archive', () => {
    fixture.database.prepare('INSERT INTO temperature_holds VALUES (?, ?, ?, ?)').run('left', 70, fixture.clock.now, fixture.clock.now + 60_000)
    fixture.database.prepare('INSERT INTO temporary_cooling VALUES (?, ?)').run('left', JSON.stringify({ fixture: 'temporary cooling' }))
    fixture.database.prepare('INSERT INTO alarm_overrides VALUES (?, ?, ?)').run('left', randomUUID(), JSON.stringify({ fixture: 'temporary alarm' }))
    fixture.database.prepare('INSERT INTO run_once_sessions (side, set_points, wake_time, expires_at) VALUES (?, ?, ?, ?)').run('left', '[]', '08:00', Math.floor(fixture.clock.now / 1000) + 60)
    fixture.database.prepare('UPDATE side_settings SET auto_on_enabled = 1, always_on = 1, stage_classifier = ?').run(JSON.stringify({ fixture: 'personal classifier' }))
    // Changes before either person sees the review require a replacement review.
    reviews.cancel(fixture.ownerKey, { ...context(), version: 1, reviewId: request.reviewId })
    const next = reviews.propose(fixture.ownerKey, { ...context(), version: 1, ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true })
    for (const key of [fixture.ownerKey, fixture.memberKey]) reviews.approve(key, { ...context(key), version: 1, reviewId: next.reviewId,
      issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000, confirmMySide: true, confirmMyRoutine: true, acknowledgeSeparateActivation: true })
    request = { ...request, reviewId: next.reviewId }
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    expect(fixture.database.prepare('SELECT * FROM temperature_holds').all()).toEqual([])
    expect(fixture.database.prepare('SELECT * FROM temporary_cooling').all()).toEqual([])
    expect(fixture.database.prepare('SELECT record FROM alarm_overrides').all()).toEqual([{ record: null }, { record: null }])
    expect(fixture.database.prepare('SELECT status FROM run_once_sessions').get()).toEqual({ status: 'cancelled' })
    expect(fixture.database.prepare('SELECT auto_on_enabled, always_on, stage_classifier FROM side_settings').all()).toEqual([
      { auto_on_enabled: 0, always_on: 0, stage_classifier: null }, { auto_on_enabled: 0, always_on: 0, stage_classifier: null },
    ])
    const archive = (fixture.database.prepare('SELECT archive FROM household_arrangement_transitions').get() as { archive: string }).archive
    expect(archive).toContain('temporary cooling')
    expect(archive).toContain('temporary alarm')
    expect(archive).toContain('personal classifier')
  })

  it('rechecks in-flight Stop work after drain and before the atomic commit', async () => {
    const oldIntent = captureHardwareIntent()
    const finish = beginHardwareWrite(oldIntent)
    finishes.push(finish)
    transition.begin(fixture.ownerKey, request)
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    finish()
    await waitForHardwareDrain(request.requestId)
    const finishStop = beginHardwareWrite(captureHardwareIntent(), true)
    finishes.push(finishStop)
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    finishStop()
    expect(transition.commit(fixture.ownerKey, request).state).toBe('committed')
    expect(() => beginHardwareWrite(oldIntent)).toThrow()
  })

  it('will not commit a held operation after runtime restart, expiry, or feature withdrawal', () => {
    transition.begin(fixture.ownerKey, request)
    expect(() => makeStore(randomUUID()).commit(fixture.ownerKey, request)).toThrow()
    enabled = false
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    enabled = true
    fixture.clock.now = request.expiresAt
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    expect(admission.read().holdId).toBe(request.requestId)
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
  })
})

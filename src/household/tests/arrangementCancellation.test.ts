import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/schema'
import { installHardwareAdmission, beginHardwareWrite, captureHardwareIntent } from '@/src/hardware/admission'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { readBedtimeRoutineState, replaceBedtimeRoutineBatch } from '@/src/server/bedtimeRoutineTransaction'
import type { ControllerGeneration } from '@/src/server/controllerGeneration'
import { defaultComfortState } from '@/src/comfort/policy'
import { ArrangementReviewService } from '../arrangementReviews'
import { ArrangementTransitionStore } from '../arrangementTransition'
import { ArrangementCancellationStore } from '../arrangementCancellation'
import { arrangementResumeDigest } from '../arrangementResumeState'
import { PersonHistoryStore } from '../personHistory'
import { personalRuntimeFixture } from './runtimeFixture'
import { historySourceFixture } from './historySourceFixture'
import type { ArrangementObservation, ArrangementTransitionRequest } from '../arrangementTransitionContract'
import type { ArrangementCancellationRequest } from '../arrangementCancellationContract'

let fixture: ReturnType<typeof personalRuntimeFixture>, source: ReturnType<typeof historySourceFixture>
let transition: ArrangementTransitionStore, cancellation: ArrangementCancellationStore, reviews: ArrangementReviewService
let admission: HardwareAdmissionStore, activation: ArrangementTransitionRequest, request: ArrangementCancellationRequest
let controller: ControllerGeneration, originalController: ControllerGeneration, observations: ArrangementObservation
let folder: string, runId: string, originalRunId: string, enabled: boolean, uninstall: () => void
let finishes: (() => void)[]
const context = (key = fixture.ownerKey) => {
  const session = fixture.identities.session(key)
  return { requestId: randomUUID(), expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision }
}
const preservedTables = ['households', 'household_accounts', 'household_personal_settings', 'device_settings', 'side_settings',
  'bedtime_routines', 'power_schedules', 'temperature_schedules', 'alarm_schedules', 'comfort_states', 'temperature_limits',
  'temperature_holds', 'temporary_cooling', 'automations', 'household_attribution_epochs', 'household_history_state',
  'household_history_sources', 'household_person_records', 'biometric_profile_bindings', 'biometric_config_outbox']
const rows = (tables: string[]) => tables.map(table => fixture.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
const state = () => rows([...preservedTables, 'hardware_admission', 'household_arrangement_reviews', 'household_arrangement_transitions'])
const freshObservations = (): ArrangementObservation => ({ runId,
  presence: { observedAt: fixture.clock.now, left: 'empty', right: 'empty' },
  thermal: { observedAt: fixture.clock.now, leftPowered: false, rightPowered: false, water: 'ok', priming: false },
  alarm: { observedAt: fixture.clock.now, vibrating: false, snoozing: false },
  base: { observedAt: fixture.clock.now, state: 'stationary' },
})
const makeCancellation = (generation = () => controller) => new ArrangementCancellationStore({ database: fixture.database,
  biometrics: source.biometrics, identities: fixture.identities, historySource: source.source, enabled: () => enabled,
  observe: () => observations, controllerGeneration: generation, runId, now: () => fixture.clock.now })

beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), 'sleepypod-cancellation-'))
  fixture = personalRuntimeFixture(path.join(folder, 'configuration.db'))
  fixture.database.pragma('journal_mode = WAL')
  source = historySourceFixture(fixture.database, fixture.owner, () => fixture.clock.now, path.join(folder, 'biometrics.db'))
  const history = new PersonHistoryStore(fixture.database, fixture.identities, source.source, () => fixture.clock.now)
  history.appendReviewedEpoch({ householdId: fixture.owner.householdId, datasetId: source.identity.datasetId, expectedAttributionRevision: 1,
    startsAt: fixture.clock.now, endsAt: null, mode: 'solo_merged', basis: 'verified_arrangement', reviewReceiptId: randomUUID(),
    reviewedBy: fixture.owner.accountId, assignments: [{ sleeperId: fixture.owner.selfSleeperId, recordedSide: 'left' }] })
  fixture.clock.now += 2000
  for (const key of [fixture.ownerKey, fixture.memberKey]) {
    const preferences = fixture.identities.preferences(key)
    fixture.identities.updatePreferences(key, { ...context(key), expectedRevision: preferences.revision,
      preferences: { ...preferences.preferences, preferredTemperatureF: key === fixture.ownerKey ? 70 : 82 } })
    fixture.identities.updateRoutines(key, { ...context(key), expectedRevision: fixture.identities.routines(key).revision, routines: [] })
  }
  replaceBedtimeRoutineBatch(fixture.database, [{ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: {
    power: { onTime: '22:00', offTime: '07:15', onTemperature: 70, enabled: true, endAction: 'maintain' }, temperatures: [],
    alarm: { time: '07:00', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 20, alarmTemperature: 105,
      enabled: true, wakeWindow: 0, snoozeDuration: 540, snoozeTaper: 30 }, notes: 'Saved owner week',
  } }] }])
  fixture.database.prepare('INSERT INTO comfort_states(side, state) VALUES (?, ?)').run('left', JSON.stringify(defaultComfortState()))
  reviews = new ArrangementReviewService({ database: fixture.database, identities: fixture.identities, enabled: () => true, now: () => fixture.clock.now })
  const review = reviews.propose(fixture.ownerKey, { ...context(), version: 1, ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true })
  for (const key of [fixture.ownerKey, fixture.memberKey]) reviews.approve(key, { ...context(key), version: 1, reviewId: review.reviewId,
    issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000, confirmMySide: true, confirmMyRoutine: true, acknowledgeSeparateActivation: true })
  runId = originalRunId = randomUUID()
  enabled = true
  originalController = controller = { version: 1, invocationId: 'a'.repeat(32), bootId: randomUUID(), pid: 1234, startTicks: '1000', observedAt: fixture.clock.now }
  observations = freshObservations()
  activation = { ...context(), version: 1, reviewId: review.reviewId, issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000,
    confirmEmptyAndAttended: true, confirmClearTemporaryActions: true, confirmPauseLearningAndSharedAutomations: true, acknowledgeHeldUntilRecovery: true }
  admission = new HardwareAdmissionStore(fixture.database, () => fixture.clock.now)
  uninstall = installHardwareAdmission(admission)
  finishes = []
  transition = new ArrangementTransitionStore({ database: fixture.database, identities: fixture.identities, reviews, history,
    historySource: source.source, enabled: () => enabled, observe: () => observations, runId, controllerGeneration: () => controller, now: () => fixture.clock.now })
  transition.begin(fixture.ownerKey, activation)
  fixture.clock.now += 2000
  runId = randomUUID()
  controller = { ...controller, invocationId: 'b'.repeat(32), pid: 1235, startTicks: '2000', observedAt: fixture.clock.now }
  observations = freshObservations()
  uninstall()
  uninstall = installHardwareAdmission(admission)
  cancellation = makeCancellation()
  request = { ...context(), version: 1, operationId: activation.requestId, issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000,
    expectedControlDigest: cancellation.preview(fixture.ownerKey, activation.requestId).controlDigest,
    confirmEmptyAndAttended: true, confirmKeepSoloArrangement: true, acknowledgeSavedRoutinesMayResume: true }
})
afterEach(() => {
  for (const finish of finishes) finish()
  uninstall?.()
  source?.biometrics.close()
  fixture?.database.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('attended cancellation before arrangement commit', () => {
  it('durably cancels the review and releases admission, preserving solo controls, private settings and history', () => {
    const before = rows(preservedTables)
    const receipt = cancellation.cancel(fixture.ownerKey, request)
    expect(receipt).toMatchObject({ operationId: activation.requestId, requestId: request.requestId, state: 'cancelled',
      admissionRevision: 3, arrangement: 'solo-anywhere', physicalMovement: 'not_requested' })
    expect(rows(preservedTables)).toEqual(before)
    expect(admission.read()).toEqual({ revision: 3, holdId: null })
    const reopened = new Database(path.join(folder, 'configuration.db'))
    try {
      expect(new HardwareAdmissionStore(reopened).read()).toEqual({ revision: 3, holdId: null })
      expect(reopened.prepare('SELECT state FROM household_arrangement_reviews').get()).toEqual({ state: 'cancelled' })
      const saved = reopened.prepare('SELECT state, cancellation, recovery, archive FROM household_arrangement_transitions').get() as { state: string, cancellation: string }
      expect(saved).toMatchObject({ state: 'cancelled', recovery: null, archive: null })
      expect(JSON.parse(saved.cancellation).receipt).toEqual(receipt)
      expect(JSON.stringify(receipt)).not.toMatch(/invocation|sleeperId|accountId|preferences|notes/)
    }
    finally { reopened.close() }
  })

  it('allows a partner-cancelled review and later private edits without publishing or losing them', () => {
    reviews.cancel(fixture.memberKey, { ...context(fixture.memberKey), version: 1, reviewId: activation.reviewId })
    const previous = fixture.identities.preferences(fixture.memberKey)
    fixture.identities.updatePreferences(fixture.memberKey, { ...context(fixture.memberKey), expectedRevision: previous.revision,
      preferences: { ...previous.preferences, preferredTemperatureF: 80 } })
    const before = rows(preservedTables)
    expect(cancellation.preview(fixture.ownerKey, activation.requestId).controlDigest).toBe(request.expectedControlDigest)
    cancellation.cancel(fixture.ownerKey, request)
    expect(rows(preservedTables)).toEqual(before)
    expect(fixture.identities.preferences(fixture.memberKey).preferences.preferredTemperatureF).toBe(80)
  })

  it('allows a fresh cancellation after the original activation request expires', () => {
    fixture.clock.now = activation.expiresAt + 1
    controller.observedAt = fixture.clock.now
    observations = freshObservations()
    const fresh = { ...request, issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000 }
    expect(cancellation.cancel(fixture.ownerKey, fresh).state).toBe('cancelled')
  })

  it('replays exactly after expiry and a later hold without releasing or rewriting anything', () => {
    const receipt = cancellation.cancel(fixture.ownerKey, request)
    fixture.clock.now += 60_000
    enabled = false
    admission.hold(randomUUID())
    const before = state()
    expect(makeCancellation().cancel(fixture.ownerKey, request)).toEqual(receipt)
    expect(() => cancellation.cancel(fixture.ownerKey, { ...request, requestId: randomUUID() })).toThrow()
    expect(() => cancellation.cancel(fixture.ownerKey, { ...request, expiresAt: request.expiresAt + 1 })).toThrow()
    expect(() => cancellation.cancel(fixture.memberKey, request)).toThrow()
    expect(state()).toEqual(before)
  })

  it('never reopens the old activation after cancellation', () => {
    cancellation.cancel(fixture.ownerKey, request)
    const before = state()
    expect(() => transition.begin(fixture.ownerKey, activation)).toThrow()
    expect(() => transition.commit(fixture.ownerKey, activation)).toThrow()
    expect(() => cancellation.preview(fixture.ownerKey, activation.requestId)).toThrow()
    expect(state()).toEqual(before)
  })

  it('cannot undo an already committed arrangement', () => {
    runId = originalRunId
    observations = freshObservations()
    controller = { ...originalController, observedAt: fixture.clock.now }
    transition.commit(fixture.ownerKey, activation)
    const before = state()
    expect(() => cancellation.cancel(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
    expect(admission.read().holdId).toBe(activation.requestId)
  })

  it.each(['review', 'receipt', 'release'])('rolls back cancellation and release when the %s write fails', (failure) => {
    const table = failure === 'review' ? 'household_arrangement_reviews' : failure === 'receipt' ? 'household_arrangement_transitions' : 'hardware_admission'
    fixture.database.exec(`CREATE TRIGGER fail_cancellation BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'injected_write_failure'); END`)
    const before = state()
    expect(() => cancellation.cancel(fixture.ownerKey, request)).toThrow('injected_write_failure')
    expect(state()).toEqual(before)
  })

  it.each(['timezone', 'thermal', 'routine', 'rule', 'priming', 'profile', 'temporary'])('requires a fresh preview after operating %s settings change', (change) => {
    if (change === 'timezone') fixture.database.prepare('UPDATE device_settings SET timezone = \'Europe/Rome\'').run()
    if (change === 'thermal') fixture.database.prepare('UPDATE side_settings SET always_on = 1').run()
    if (change === 'routine') {
      const record = readBedtimeRoutineState(drizzle(fixture.database, { schema }), 'left').records[0]
      if (!record) throw new Error('Expected the saved owner routine in this fixture')
      const snapshot = record.snapshot
      replaceBedtimeRoutineBatch(fixture.database, [{ side: 'left', changes: [{ dayOfWeek: snapshot.dayOfWeek,
        expectedRevision: snapshot.revision, replacement: { ...snapshot.draft, power: { ...snapshot.draft.power, onTemperature: 69 } } }] }])
    }
    if (change === 'rule') fixture.database.prepare('INSERT INTO automations(name, trigger, conditions, actions) VALUES (?, ?, ?, ?)').run('New rule', '{}', '{}', '[]')
    if (change === 'priming') fixture.database.prepare('UPDATE device_settings SET prime_pod_daily = 1').run()
    if (change === 'profile') fixture.database.prepare('UPDATE device_settings SET autopilot_enabled = 1').run()
    if (change === 'temporary') fixture.database.prepare('INSERT INTO temperature_holds(side, temperature, started_at, expires_at) VALUES (?, ?, ?, ?)')
      .run('left', 69, fixture.clock.now, fixture.clock.now + 60_000)
    const before = state()
    expect(() => cancellation.cancel(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
    const refreshed = cancellation.preview(fixture.ownerKey, activation.requestId)
    expect(refreshed.controlDigest).not.toBe(request.expectedControlDigest)
    cancellation.cancel(fixture.ownerKey, { ...request, expectedControlDigest: refreshed.controlDigest })
    expect(rows(preservedTables)).toEqual(before.slice(0, preservedTables.length))
  })

  it.each(['presence', 'thermal', 'alarm', 'base'] as const)('requires independent fresh %s observations', (sourceName) => {
    for (const observedAt of [fixture.clock.now - 5001, fixture.clock.now + 1]) {
      observations[sourceName].observedAt = observedAt
      const before = state()
      expect(() => cancellation.cancel(fixture.ownerKey, request)).toThrow()
      expect(state()).toEqual(before)
    }
    observations = freshObservations()
    const invalid = { presence: { ...observations.presence, right: 'occupied' }, thermal: { ...observations.thermal, leftPowered: true },
      alarm: { ...observations.alarm, snoozing: true }, base: { ...observations.base, state: 'moving' } }
    observations = { ...observations, [sourceName]: invalid[sourceName] } as ArrangementObservation
    expect(() => cancellation.cancel(fixture.ownerKey, request)).toThrow()
  })

  it.each(['same-service', 'same-process', 'stale', 'future', 'changed'])('rejects %s controller evidence', (problem) => {
    if (problem === 'same-service') controller.invocationId = originalController.invocationId
    if (problem === 'same-process') controller.startTicks = originalController.startTicks
    if (problem === 'stale') controller.observedAt -= 5001
    if (problem === 'future') controller.observedAt++
    if (problem === 'changed') {
      let calls = 0
      cancellation = makeCancellation(() => ({ ...controller, invocationId: (++calls === 1 ? 'b' : 'c').repeat(32) }))
    }
    const before = state()
    expect(() => cancellation.cancel(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
  })

  it.each(['source', 'binding', 'epoch', 'attribution', 'source-side', 'assignment', 'owner-device', 'review'])('retains the hold after %s integrity changes', (problem) => {
    if (problem === 'source') source.biometrics.prepare('UPDATE biometric_history_identity SET dataset_id = ?').run(randomUUID())
    if (problem === 'binding') fixture.database.prepare('UPDATE household_history_sources SET review_receipt_id = ?').run(randomUUID())
    if (problem === 'epoch') fixture.database.prepare('UPDATE household_attribution_epochs SET revoked_at = ?').run(fixture.clock.now)
    if (problem === 'attribution') fixture.database.prepare('UPDATE household_history_state SET attribution_revision = attribution_revision + 1').run()
    if (problem === 'source-side') fixture.database.prepare('UPDATE households SET source_side = \'right\'').run()
    if (problem === 'assignment') fixture.database.prepare('UPDATE households SET assignment_revision = assignment_revision + 1').run()
    if (problem === 'owner-device') fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?').run(fixture.clock.now, fixture.owner.accountId)
    if (problem === 'review') fixture.database.prepare('UPDATE household_arrangement_reviews SET state = \'consumed\'').run()
    const before = state()
    expect(() => cancellation.cancel(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
  })

  it.each(['expired', 'future', 'session', 'assignment', 'attendance', 'disabled', 'other-run'])('rejects a %s cancellation request', (problem) => {
    const input = { ...request }
    if (problem === 'expired') {
      input.issuedAt -= 30_000
      input.expiresAt = fixture.clock.now
    }
    if (problem === 'future') {
      input.issuedAt++
      input.expiresAt++
    }
    if (problem === 'session') input.expectedSessionRevision--
    if (problem === 'assignment') input.expectedAssignmentRevision--
    if (problem === 'attendance') Object.assign(input, { confirmEmptyAndAttended: false })
    if (problem === 'disabled') enabled = false
    if (problem === 'other-run') observations.runId = randomUUID()
    const before = state()
    expect(() => cancellation.cancel(fixture.ownerKey, input)).toThrow()
    expect(state()).toEqual(before)
  })

  it('rejects another owner device even when its credential is valid', () => {
    const key = randomBytes(32).toString('base64url')
    const invitation = fixture.identities.createInvitation(fixture.ownerKey, { ...context(), kind: 'own_device',
      invitation: randomBytes(32).toString('base64url'), expiresInMinutes: 30 })
    fixture.identities.join({ invitation: invitation.invitation, deviceName: 'Other owner phone', deviceSecret: key, displayName: 'Owner' })
    const before = state()
    expect(() => cancellation.cancel(key, request)).toThrow()
    expect(state()).toEqual(before)
  })

  it.each(['request', 'digest', 'operation', 'revision', 'time', 'controller'])('rejects a corrupted saved %s receipt', (problem) => {
    cancellation.cancel(fixture.ownerKey, request)
    const row = fixture.database.prepare('SELECT cancellation FROM household_arrangement_transitions').get() as { cancellation: string }
    const saved = JSON.parse(row.cancellation)
    if (problem === 'request') saved.request.requestId = randomUUID()
    if (problem === 'digest') saved.receipt.controlDigest = 'e'.repeat(64)
    if (problem === 'operation') saved.receipt.operationId = randomUUID()
    if (problem === 'revision') saved.receipt.admissionRevision++
    if (problem === 'time') saved.receipt.completedAt = saved.request.expiresAt
    if (problem === 'controller') saved.controller.invocationId = originalController.invocationId
    fixture.database.prepare('UPDATE household_arrangement_transitions SET cancellation = ?').run(JSON.stringify(saved))
    const before = state()
    expect(() => cancellation.cancel(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
  })

  it('does not include new MQTT credentials or unpublished drafts in the operating-control digest', () => {
    const before = arrangementResumeDigest(fixture.database, fixture.owner.householdId)
    fixture.database.prepare('UPDATE device_settings SET mqtt_password = ?, updated_at = updated_at + 1').run('test-only-secret')
    expect(arrangementResumeDigest(fixture.database, fixture.owner.householdId)).toBe(before)
  })

  it('waits for explicit Stop, including one dispatched during cancellation persistence', () => {
    finishes.push(beginHardwareWrite(captureHardwareIntent(), true))
    expect(() => cancellation.cancel(fixture.ownerKey, request)).toThrow()
    finishes.pop()?.()
    fixture.database.function('inject_stop', () => {
      finishes.push(beginHardwareWrite(captureHardwareIntent(), true))
      return 1
    })
    fixture.database.exec('CREATE TRIGGER stop_during_cancel BEFORE UPDATE OF cancellation ON household_arrangement_transitions BEGIN SELECT inject_stop(); END')
    const before = state()
    expect(() => cancellation.cancel(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
  })

  it('rolls back if the attended request expires during receipt persistence', () => {
    fixture.database.function('expire_request', () => {
      fixture.clock.now = request.expiresAt
      return 1
    })
    fixture.database.exec('CREATE TRIGGER expire_during_cancel BEFORE UPDATE OF cancellation ON household_arrangement_transitions BEGIN SELECT expire_request(); END')
    const before = state()
    expect(() => cancellation.cancel(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
  })

  it('holds a separate source reservation until the configuration release finishes', () => {
    const competing = new Database(path.join(folder, 'biometrics.db'))
    competing.pragma('busy_timeout = 1')
    let checked = false
    fixture.database.function('check_source_reservation', () => {
      expect(() => competing.prepare('UPDATE biometric_history_identity SET dataset_id = ?').run(randomUUID())).toThrow(/locked/)
      checked = true
      return 1
    })
    fixture.database.exec('CREATE TRIGGER check_source_lock BEFORE UPDATE OF cancellation ON household_arrangement_transitions BEGIN SELECT check_source_reservation(); END')
    try {
      cancellation.cancel(fixture.ownerKey, request)
      expect(checked).toBe(true)
      expect(() => competing.prepare('UPDATE biometric_history_identity SET dataset_id = dataset_id').run()).not.toThrow()
    }
    finally { competing.close() }
  })
})

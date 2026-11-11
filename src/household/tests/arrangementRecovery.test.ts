import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installHardwareAdmission, beginHardwareWrite, captureHardwareIntent } from '@/src/hardware/admission'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { configHash } from '@/src/biometrics/algorithms/canonical'
import type { ControllerGeneration } from '@/src/server/controllerGeneration'
import { ArrangementReviewService } from '../arrangementReviews'
import { ArrangementTransitionStore } from '../arrangementTransition'
import { ArrangementRecoveryStore } from '../arrangementRecovery'
import { committedArrangementDigest } from '../arrangementTransitionState'
import { PersonHistoryStore } from '../personHistory'
import { historySourceFixture } from './historySourceFixture'
import { personalRuntimeFixture } from './runtimeFixture'
import type { ArrangementObservation, ArrangementTransitionRequest } from '../arrangementTransitionContract'
import type { ArrangementRecoveryRequest } from '../arrangementRecoveryContract'

let fixture: ReturnType<typeof personalRuntimeFixture>, source: ReturnType<typeof historySourceFixture>
let history: PersonHistoryStore, transition: ArrangementTransitionStore, recovery: ArrangementRecoveryStore, admission: HardwareAdmissionStore
let request: ArrangementRecoveryRequest, activation: ArrangementTransitionRequest, observations: ArrangementObservation, controller: ControllerGeneration
let uninstall: () => void, folder: string, runId: string, enabled: boolean
let finishes: (() => void)[]
const context = (key = fixture.ownerKey) => {
  const session = fixture.identities.session(key)
  return { requestId: randomUUID(), expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision }
}
const state = () => ['hardware_admission', 'households', 'household_accounts', 'household_arrangement_transitions',
  'household_attribution_epochs', 'household_history_state', 'household_person_records']
  .map(table => fixture.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
const held = () => {
  expect(admission.read()).toEqual({ revision: 2, holdId: activation.requestId })
  expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_attribution_epochs').get()).toEqual({ count: 1 })
  expect(fixture.database.prepare('SELECT recovery FROM household_arrangement_transitions').get()).toEqual({ recovery: null })
}
const freshObservations = (): ArrangementObservation => ({ runId,
  presence: { observedAt: fixture.clock.now, left: 'empty', right: 'empty' },
  thermal: { observedAt: fixture.clock.now, leftPowered: false, rightPowered: false, water: 'ok', priming: false },
  alarm: { observedAt: fixture.clock.now, vibrating: false, snoozing: false },
  base: { observedAt: fixture.clock.now, state: 'stationary' },
})
const makeRecovery = (generation = () => controller) => new ArrangementRecoveryStore({ database: fixture.database, biometrics: source.biometrics,
  identities: fixture.identities, historySource: source.source, history, enabled: () => enabled,
  observe: () => observations, controllerGeneration: generation, runId, now: () => fixture.clock.now })

beforeEach(() => {
  finishes = []
  folder = mkdtempSync(path.join(tmpdir(), 'sleepypod-recovery-'))
  fixture = personalRuntimeFixture(path.join(folder, 'configuration.db'))
  fixture.database.pragma('journal_mode = WAL')
  source = historySourceFixture(fixture.database, fixture.owner, () => fixture.clock.now, path.join(folder, 'biometrics.db'))
  history = new PersonHistoryStore(fixture.database, fixture.identities, source.source, () => fixture.clock.now)
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
  const reviews = new ArrangementReviewService({ database: fixture.database, identities: fixture.identities, enabled: () => true, now: () => fixture.clock.now })
  const review = reviews.propose(fixture.ownerKey, { ...context(), version: 1, ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true })
  for (const key of [fixture.ownerKey, fixture.memberKey]) reviews.approve(key, { ...context(key), version: 1, reviewId: review.reviewId,
    issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000, confirmMySide: true, confirmMyRoutine: true, acknowledgeSeparateActivation: true })
  runId = randomUUID()
  enabled = true
  controller = { version: 1, invocationId: 'a'.repeat(32), bootId: randomUUID(), pid: 1234, startTicks: '1000', observedAt: fixture.clock.now }
  observations = freshObservations()
  activation = { ...context(), version: 1, reviewId: review.reviewId, issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000,
    confirmEmptyAndAttended: true, confirmClearTemporaryActions: true, confirmPauseLearningAndSharedAutomations: true, acknowledgeHeldUntilRecovery: true }
  admission = new HardwareAdmissionStore(fixture.database, () => fixture.clock.now)
  uninstall = installHardwareAdmission(admission)
  finishes = []
  transition = new ArrangementTransitionStore({ database: fixture.database, identities: fixture.identities, reviews, history,
    historySource: source.source, enabled: () => enabled, observe: () => observations, runId, controllerGeneration: () => controller, now: () => fixture.clock.now })
  transition.begin(fixture.ownerKey, activation)
  transition.commit(fixture.ownerKey, activation)
  // Model an actual restart using a new service invocation and kernel process-start identity.
  fixture.clock.now += 2000
  runId = randomUUID()
  controller = { ...controller, invocationId: 'b'.repeat(32), pid: 1235, startTicks: '2000', observedAt: fixture.clock.now }
  observations = freshObservations()
  uninstall()
  uninstall = installHardwareAdmission(admission)
  const saved = fixture.database.prepare('SELECT processing FROM household_arrangement_transitions').get() as { processing: string }
  for (const component of ['sleep-detector', 'piezo-processor']) source.biometrics.prepare(`INSERT INTO household_processing_receipts
    (operation_id, component, process_id, intent_hash, first_sample_ms, latest_sample_ms, heartbeat_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(activation.requestId, component, randomUUID(), configHash(JSON.parse(saved.processing)), fixture.clock.now, fixture.clock.now, fixture.clock.now)
  fixture.clock.now += 500
  request = { ...context(), version: 1, operationId: activation.requestId, issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000,
    confirmEmptyAndAttended: true, confirmAssignedSides: true, acknowledgeRecordingGap: true, acknowledgeLearningRemainsOff: true }
  recovery = makeRecovery()
})
afterEach(() => {
  for (const finish of finishes) finish()
  uninstall?.()
  source?.biometrics.close()
  fixture?.database.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('attended arrangement recovery storage', () => {
  it('recovers a receipt committed before learning archives without rewriting its historical evidence', () => {
    const saved = fixture.database.prepare('SELECT context FROM household_arrangement_transitions').get() as { context: string }
    const legacyContext = JSON.parse(saved.context)
    delete legacyContext.learningArchiveVersion
    fixture.database.prepare('DELETE FROM household_learning_archives WHERE operation_id = ?').run(activation.requestId)
    fixture.database.prepare('UPDATE household_arrangement_transitions SET context = ?, committed_hash = ? WHERE id = ?')
      .run(JSON.stringify(legacyContext), committedArrangementDigest(fixture.database, fixture.owner.householdId, 'legacy'), activation.requestId)
    expect(recovery.recover(fixture.ownerKey, request)).toMatchObject({ state: 'completed', hardware: 'admission_released' })
    expect(fixture.database.prepare('SELECT count(*) AS count FROM household_learning_archives').get()).toEqual({ count: 0 })
  })

  it.each(['version_only', 'version_and_archive'])('does not downgrade a new committed receipt when %s is missing', (change) => {
    const saved = fixture.database.prepare('SELECT context FROM household_arrangement_transitions').get() as { context: string }
    const changedContext = JSON.parse(saved.context)
    delete changedContext.learningArchiveVersion
    fixture.database.prepare('UPDATE household_arrangement_transitions SET context = ?').run(JSON.stringify(changedContext))
    if (change === 'version_and_archive') fixture.database.prepare('DELETE FROM household_learning_archives').run()
    expect(() => recovery.recover(fixture.ownerKey, request)).toThrow()
    held()
  })

  it.each(['missing_archive', 'changed_count', 'changed_owner'])('keeps hardware held when learning preservation has %s', (failure) => {
    if (failure === 'missing_archive') fixture.database.prepare('DELETE FROM household_learning_archives WHERE operation_id = ?').run(activation.requestId)
    if (failure === 'changed_count') fixture.database.prepare('UPDATE household_learning_archives SET record_count = record_count + 1 WHERE operation_id = ?').run(activation.requestId)
    if (failure === 'changed_owner') fixture.database.prepare('UPDATE household_learning_archives SET account_id = ? WHERE operation_id = ?').run(fixture.member.accountId, activation.requestId)
    expect(() => recovery.recover(fixture.ownerKey, request)).toThrow()
    held()
  })

  it('commits separate attribution, a private recovery record and open admission together, surviving database reopen', () => {
    const receipt = recovery.recover(fixture.ownerKey, request)
    expect(receipt).toMatchObject({ operationId: activation.requestId, state: 'completed', admissionRevision: 3,
      completedAt: fixture.clock.now, recordingStartsAt: fixture.clock.now, hardware: 'admission_released', physicalMovement: 'not_requested' })
    expect(admission.read()).toEqual({ revision: 3, holdId: null })
    const reopened = new Database(path.join(folder, 'configuration.db'))
    try {
      const epochs = reopened.prepare('SELECT mode, starts_at, ends_at, assignments FROM household_attribution_epochs ORDER BY starts_at').all() as { mode: string, starts_at: number, ends_at: number | null, assignments: string }[]
      expect(epochs).toHaveLength(2)
      expect(epochs[0]?.ends_at).toBe(activation.issuedAt)
      expect(epochs[1]).toMatchObject({ mode: 'assigned', starts_at: fixture.clock.now, ends_at: null })
      expect(JSON.parse(epochs[1]?.assignments ?? 'null')).toEqual([
        { sleeperId: fixture.member.selfSleeperId, recordedSide: 'left' }, { sleeperId: fixture.owner.selfSleeperId, recordedSide: 'right' },
      ])
      expect(new HardwareAdmissionStore(reopened).read()).toEqual({ revision: 3, holdId: null })
      expect(reopened.prepare('SELECT state FROM household_arrangement_transitions').get()).toEqual({ state: 'committed' })
      const saved = reopened.prepare('SELECT recovery FROM household_arrangement_transitions').get() as { recovery: string }
      expect(JSON.parse(saved.recovery).receipt).toEqual(receipt)
      expect(JSON.stringify(receipt)).not.toMatch(/invocation|process_id|sleeperId|accountId|preferences/)
    }
    finally { reopened.close() }
  })

  it('withholds the entire reload gap and crossing intervals, then admits new observations to their reviewed people', () => {
    const releasedAt = fixture.clock.now
    recovery.recover(fixture.ownerKey, request)
    fixture.clock.now += 2000
    const sample = { householdId: fixture.owner.householdId, datasetId: source.identity.datasetId, recordedSide: 'left',
      payload: { kind: 'presence', reportedPresenceSeconds: 1, exits: 0, interpretation: 'bed_presence_not_sleep' } }
    expect(history.admitObservation({ ...sample, sourceRecordKey: 'gap', startsAt: activation.issuedAt, endsAt: releasedAt }).status).toBe('withheld')
    expect(history.admitObservation({ ...sample, sourceRecordKey: 'crossing', startsAt: releasedAt - 500, endsAt: releasedAt + 500 }).status).toBe('withheld')
    expect(history.admitObservation({ ...sample, sourceRecordKey: 'member', startsAt: releasedAt, endsAt: releasedAt + 1000 }).status).toBe('admitted')
    expect(history.admitObservation({ ...sample, recordedSide: 'right', sourceRecordKey: 'owner', startsAt: releasedAt, endsAt: releasedAt + 1000 }).status).toBe('admitted')
    expect(fixture.database.prepare('SELECT sleeper_id FROM household_person_records ORDER BY sequence').all()).toEqual([
      { sleeper_id: fixture.member.selfSleeperId }, { sleeper_id: fixture.owner.selfSleeperId },
    ])
  })

  it('replays only the exact saved receipt after expiry or another hold, without reopening or attributing twice', () => {
    const receipt = recovery.recover(fixture.ownerKey, request)
    fixture.clock.now += 60_000
    enabled = false
    admission.hold(randomUUID())
    const before = state()
    expect(makeRecovery().recover(fixture.ownerKey, request)).toEqual(receipt)
    expect(state()).toEqual(before)
    expect(() => recovery.recover(fixture.ownerKey, { ...request, requestId: randomUUID() })).toThrow()
    expect(() => recovery.recover(fixture.ownerKey, { ...request, expiresAt: request.expiresAt + 1 })).toThrow()
    expect(() => recovery.recover(fixture.memberKey, request)).toThrow()
    expect(state()).toEqual(before)
  })

  it.each(['epoch', 'receipt', 'release'])('rolls back attribution and recovery if the %s write fails', (failure) => {
    const table = failure === 'epoch' ? 'household_attribution_epochs' : failure === 'receipt' ? 'household_arrangement_transitions' : 'hardware_admission'
    fixture.database.exec(`CREATE TRIGGER fail_recovery BEFORE ${failure === 'epoch' ? 'INSERT' : 'UPDATE'} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'injected_write_failure'); END`)
    const before = state()
    expect(() => recovery.recover(fixture.ownerKey, request)).toThrow('injected_write_failure')
    expect(state()).toEqual(before)
    held()
  })

  it.each(['request', 'response', 'time', 'controller', 'consumer', 'processing', 'boundary'])('rejects a corrupted saved %s receipt without writing anything', (problem) => {
    recovery.recover(fixture.ownerKey, request)
    const row = fixture.database.prepare('SELECT recovery FROM household_arrangement_transitions').get() as { recovery: string }
    const saved = JSON.parse(row.recovery)
    if (problem === 'request') saved.request.requestId = randomUUID()
    if (problem === 'response') saved.receipt.admissionRevision++
    if (problem === 'time') saved.receipt.completedAt = saved.request.expiresAt
    if (problem === 'controller') saved.controller.invocationId = 'a'.repeat(32)
    if (problem === 'consumer') saved.processing.receipts[1].component = saved.processing.receipts[0].component
    if (problem === 'processing') saved.processing.receipts[0].intent_hash = 'e'.repeat(64)
    if (problem === 'boundary') saved.processing.earliestAssignedSampleAt++
    fixture.database.prepare('UPDATE household_arrangement_transitions SET recovery = ?').run(JSON.stringify(saved))
    const before = state()
    expect(() => recovery.recover(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
  })

  it.each(['presence', 'thermal', 'alarm', 'base'] as const)('requires independent current %s observations', (sourceName) => {
    const observedAt = observations[sourceName].observedAt
    for (const invalid of [fixture.clock.now - 5001, fixture.clock.now + 1]) {
      observations[sourceName].observedAt = invalid
      expect(() => recovery.recover(fixture.ownerKey, request)).toThrow()
      held()
    }
    observations[sourceName].observedAt = observedAt
    const invalid = { presence: { ...observations.presence, right: 'unknown' }, thermal: { ...observations.thermal, priming: true },
      alarm: { ...observations.alarm, vibrating: true }, base: { ...observations.base, state: 'moving' } }
    observations = { ...observations, [sourceName]: invalid[sourceName] } as ArrangementObservation
    expect(() => recovery.recover(fixture.ownerKey, request)).toThrow()
    held()
  })

  it.each(['same-service', 'same-process', 'stale', 'future', 'app-only', 'generation-changed'])('rejects %s restart evidence', (problem) => {
    if (problem === 'same-service') controller.invocationId = 'a'.repeat(32)
    if (problem === 'same-process') controller.startTicks = '1000'
    if (problem === 'stale') controller.observedAt = fixture.clock.now - 5001
    if (problem === 'future') controller.observedAt = fixture.clock.now + 1
    if (problem === 'app-only') controller = { ...controller, invocationId: 'a'.repeat(32), startTicks: '1000', pid: 1234 }
    if (problem === 'generation-changed') {
      let calls = 0
      recovery = makeRecovery(() => ({ ...controller, invocationId: (++calls === 1 ? 'b' : 'c').repeat(32) }))
    }
    expect(() => recovery.recover(fixture.ownerKey, request)).toThrow()
    held()
  })

  it.each(['source', 'binding', 'settings', 'attribution', 'owner-device', 'member-device', 'member-account', 'review', 'processing', 'missing-consumer', 'old-frame', 'corrupt-record'])(
    'keeps the hold when %s no longer matches the committed arrangement', (problem) => {
      if (problem === 'source') source.biometrics.prepare('UPDATE biometric_history_identity SET dataset_id = ?').run(randomUUID())
      if (problem === 'binding') fixture.database.prepare('UPDATE household_history_sources SET review_receipt_id = ?').run(randomUUID())
      if (problem === 'settings') fixture.database.prepare('UPDATE side_settings SET always_on = 1').run()
      if (problem === 'attribution') fixture.database.prepare('UPDATE household_history_state SET attribution_revision = attribution_revision + 1').run()
      if (problem === 'owner-device' || problem === 'member-device') fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?')
        .run(fixture.clock.now, problem === 'owner-device' ? fixture.owner.accountId : fixture.member.accountId)
      if (problem === 'member-account') fixture.database.prepare('UPDATE household_accounts SET session_revision = session_revision + 1 WHERE id = ?').run(fixture.member.accountId)
      if (problem === 'review') fixture.database.prepare('UPDATE household_arrangement_reviews SET state = \'cancelled\'').run()
      if (problem === 'processing') source.biometrics.prepare('UPDATE household_processing_receipts SET intent_hash = ?').run('c'.repeat(64))
      if (problem === 'missing-consumer') source.biometrics.prepare('DELETE FROM household_processing_receipts WHERE component = \'piezo-processor\'').run()
      if (problem === 'old-frame') source.biometrics.prepare('UPDATE household_processing_receipts SET latest_sample_ms = ?').run(fixture.clock.now - 10001)
      if (problem === 'corrupt-record') fixture.database.prepare('UPDATE household_arrangement_transitions SET committed_hash = ?').run('c'.repeat(64))
      const before = state()
      expect(() => recovery.recover(fixture.ownerKey, request)).toThrow()
      expect(state()).toEqual(before)
      held()
    })

  it.each(['expired', 'future', 'old-session', 'old-assignment', 'not-attended', 'disabled', 'other-run'])('rejects a %s recovery request', (problem) => {
    const input = { ...request }
    if (problem === 'expired') {
      input.issuedAt -= 30_000
      input.expiresAt = fixture.clock.now
    }
    if (problem === 'future') {
      input.issuedAt++
      input.expiresAt++
    }
    if (problem === 'old-session') input.expectedSessionRevision--
    if (problem === 'old-assignment') input.expectedAssignmentRevision--
    if (problem === 'not-attended') Object.assign(input, { confirmEmptyAndAttended: false })
    if (problem === 'disabled') enabled = false
    if (problem === 'other-run') observations.runId = randomUUID()
    expect(() => recovery.recover(fixture.ownerKey, input)).toThrow()
    held()
  })

  it('cannot release while an explicit Stop is awaiting acknowledgment, including one dispatched during receipt persistence', () => {
    finishes.push(beginHardwareWrite(captureHardwareIntent(), true))
    expect(() => recovery.recover(fixture.ownerKey, request)).toThrow()
    held()
    finishes.pop()?.()
    fixture.database.function('inject_stop', () => {
      finishes.push(beginHardwareWrite(captureHardwareIntent(), true))
      return 1
    })
    fixture.database.exec('CREATE TRIGGER stop_during_recovery BEFORE UPDATE OF recovery ON household_arrangement_transitions BEGIN SELECT inject_stop(); END')
    expect(() => recovery.recover(fixture.ownerKey, request)).toThrow()
    held()
  })

  it('reserves the source while writing attribution, and releases that reservation afterward', () => {
    const competing = new Database(path.join(folder, 'biometrics.db'))
    competing.pragma('busy_timeout = 1')
    let checked = false
    fixture.database.function('check_source_reservation', () => {
      expect(() => competing.prepare('UPDATE biometric_history_identity SET dataset_id = ?').run(randomUUID())).toThrow(/locked/)
      checked = true
      return 1
    })
    fixture.database.exec('CREATE TRIGGER check_source_lock BEFORE INSERT ON household_attribution_epochs BEGIN SELECT check_source_reservation(); END')
    try {
      recovery.recover(fixture.ownerKey, request)
      expect(checked).toBe(true)
      expect(() => competing.prepare('UPDATE biometric_history_identity SET dataset_id = dataset_id').run()).not.toThrow()
    }
    finally { competing.close() }
  })
})

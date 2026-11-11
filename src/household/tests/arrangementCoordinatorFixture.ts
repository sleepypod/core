import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { installHardwareAdmission, waitForHardwareDrain } from '@/src/hardware/admission'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { configHash } from '@/src/biometrics/algorithms/canonical'
import { ArrangementCoordinator } from '../arrangementCoordinator'
import { ArrangementReviewService } from '../arrangementReviews'
import { PersonHistoryStore } from '../personHistory'
import type { ArrangementEvidence } from '../arrangementEvidence'
import { historySourceFixture } from './historySourceFixture'
import { personalRuntimeFixture } from './runtimeFixture'

/** Real migrated configuration/biometric stores; only external services and live readings are simulated. */
export function arrangementCoordinatorFixture() {
  const fixture = personalRuntimeFixture()
  const source = historySourceFixture(fixture.database, fixture.owner, () => fixture.clock.now)
  const history = new PersonHistoryStore(fixture.database, fixture.identities, source.source, () => fixture.clock.now)
  history.appendReviewedEpoch({ householdId: fixture.owner.householdId, datasetId: source.identity.datasetId, expectedAttributionRevision: 1,
    startsAt: fixture.clock.now, endsAt: null, mode: 'solo_merged', basis: 'verified_arrangement', reviewReceiptId: randomUUID(),
    reviewedBy: fixture.owner.accountId, assignments: [{ sleeperId: fixture.owner.selfSleeperId, recordedSide: 'left' }] })
  fixture.clock.now += 2000
  const context = (key = fixture.ownerKey) => {
    const session = fixture.identities.session(key)
    return { requestId: randomUUID(), expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision }
  }
  for (const key of [fixture.ownerKey, fixture.memberKey]) {
    const saved = fixture.identities.preferences(key)
    fixture.identities.updatePreferences(key, { ...context(key), expectedRevision: saved.revision, preferences: saved.preferences })
    fixture.identities.updateRoutines(key, { ...context(key), expectedRevision: fixture.identities.routines(key).revision, routines: [] })
  }
  const reviews = new ArrangementReviewService({ database: fixture.database, identities: fixture.identities, enabled: () => true, now: () => fixture.clock.now })
  const review = reviews.propose(fixture.ownerKey, { ...context(), version: 1, ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true })
  for (const key of [fixture.ownerKey, fixture.memberKey]) reviews.approve(key, { ...context(key), version: 1, reviewId: review.reviewId,
    issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30000, confirmMySide: true, confirmMyRoutine: true, acknowledgeSeparateActivation: true })
  const runtime = { runId: randomUUID(), invocationId: 'a'.repeat(32), pid: 1000, ticks: '1000', bootId: randomUUID() }
  const request = { ...context(), version: 1 as const, reviewId: review.reviewId, issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30000,
    confirmEmptyAndAttended: true as const, confirmClearTemporaryActions: true as const,
    confirmPauseLearningAndSharedAutomations: true as const, acknowledgeHeldUntilRecovery: true as const }
  const events: string[] = []
  const admission = new HardwareAdmissionStore(fixture.database, () => fixture.clock.now)
  const uninstall = installHardwareAdmission(admission)
  const readEvidence = vi.fn(async (): Promise<ArrangementEvidence> => {
    events.push('read')
    const observedAt = fixture.clock.now
    return { controller: { version: 1, invocationId: runtime.invocationId, bootId: runtime.bootId,
      pid: runtime.pid, startTicks: runtime.ticks, observedAt },
    observation: { runId: runtime.runId, presence: { observedAt, left: 'empty', right: 'empty' },
      thermal: { observedAt, leftPowered: false, rightPowered: false, water: 'ok', priming: false },
      alarm: { observedAt, vibrating: false, snoozing: false }, base: { observedAt, state: 'stationary' } } }
  })
  const suspend = vi.fn(async () => {
    events.push('suspend')
  })
  const drainBase = vi.fn(async () => {
    events.push('base')
  })
  const drainHardware = vi.fn(async (operationId: string) => {
    events.push('hardware')
    await waitForHardwareDrain(operationId)
  })
  const resume = vi.fn(async () => {
    if (admission.read().holdId !== null) throw new Error('Resume attempted before release')
    events.push('resume')
  })
  const makeCoordinator = () => new ArrangementCoordinator({ database: fixture.database, biometrics: source.biometrics,
    identities: fixture.identities, reviews, historySource: source.source, history, enabled: () => fixture.clock.enabled,
    runId: runtime.runId, now: () => fixture.clock.now, readEvidence, suspend, drainBase, drainHardware, resume })
  const restart = (withProcessing = true) => {
    fixture.clock.now += 2000
    runtime.runId = randomUUID()
    runtime.invocationId = 'b'.repeat(32)
    runtime.pid++
    runtime.ticks = '2000'
    if (withProcessing) {
      const row = fixture.database.prepare('SELECT processing FROM household_arrangement_transitions WHERE id = ?').get(request.requestId) as { processing: string }
      for (const component of ['sleep-detector', 'piezo-processor']) source.biometrics.prepare(`INSERT INTO household_processing_receipts
        (operation_id, component, process_id, intent_hash, first_sample_ms, latest_sample_ms, heartbeat_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(request.requestId, component, randomUUID(), configHash(JSON.parse(row.processing)), fixture.clock.now, fixture.clock.now, fixture.clock.now)
    }
    return makeCoordinator()
  }
  const recoveryRequest = () => ({ ...context(), version: 1 as const, operationId: request.requestId,
    issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30000,
    confirmEmptyAndAttended: true as const, confirmAssignedSides: true as const,
    acknowledgeRecordingGap: true as const, acknowledgeLearningRemainsOff: true as const })
  return { ...fixture, source, history, context, request, events, admission, readEvidence, suspend, drainBase, drainHardware, resume,
    makeCoordinator, restart, recoveryRequest,
    close: () => {
      uninstall()
      source.biometrics.close()
      fixture.database.close()
    } }
}

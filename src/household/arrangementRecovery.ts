import type Database from 'better-sqlite3'
import { z } from 'zod'
import { assertHardwareDrained } from '@/src/hardware/admission'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { controllerGenerationSchema, isNewControllerGeneration } from '@/src/server/controllerGeneration'
import { configHash } from '@/src/biometrics/algorithms/canonical'
import { householdIdSchema, revisionSchema } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import type { PersonHistorySource } from './historySource'
import type { PersonHistoryStore } from './personHistory'
import { arrangementProcessingSchema, readArrangementProcessing } from './arrangementProcessing'
import { arrangementObservationSchema } from './arrangementTransitionContract'
import { arrangementDigest, committedArrangementDigest } from './arrangementTransitionState'
import { arrangementTransitionContextSchema, readArrangementTransition, rejectArrangementTransition as reject, type ArrangementTransitionRow } from './arrangementTransitionRecord'
import { arrangementRecoveryReceiptSchema, arrangementRecoveryRequestSchema, savedArrangementRecoverySchema,
  type ArrangementRecoveryReceipt, type ArrangementRecoveryRequest } from './arrangementRecoveryContract'

interface Dependencies {
  database: Database.Database
  biometrics: Database.Database
  identities: HouseholdStore
  historySource: PersonHistorySource
  history: PersonHistoryStore
  enabled: () => boolean
  observe: () => unknown
  controllerGeneration: () => unknown
  runId: string
  now?: () => number
}
const assignmentsSchema = z.array(z.object({
  sleeperId: householdIdSchema, recordedSide: z.enum(['left', 'right']),
}).strict()).length(2).refine(rows => new Set(rows.map(row => row.sleeperId)).size === 2
  && new Set(rows.map(row => row.recordedSide)).size === 2)

/** Internal attended recovery. No route/startup calls it until the full runtime and UI lifecycle is qualified. */
export class ArrangementRecoveryStore {
  private readonly now: () => number
  private readonly admission: HardwareAdmissionStore
  constructor(private readonly dependencies: Dependencies) {
    householdIdSchema.parse(dependencies.runId)
    this.now = dependencies.now ?? Date.now
    this.admission = new HardwareAdmissionStore(dependencies.database, this.now)
  }

  private authorize(credential: HouseholdCredential, row: ArrangementTransitionRow) {
    const session = this.dependencies.identities.session(credential)
    const deviceId = typeof credential === 'string' ? this.dependencies.identities.deviceIdentity(credential) : credential.deviceId
    if (session.role !== 'owner') throw new HouseholdError('forbidden', 403, 'Only the current owner can recover a reviewed side transition.')
    if (session.householdId !== row.household_id || session.accountId !== row.account_id || deviceId !== row.device_id) throw reject()
    return session
  }

  private replay(row: ArrangementTransitionRow, request: ArrangementRecoveryRequest): ArrangementRecoveryReceipt | null {
    if (row.recovery === null) return null
    const saved = savedArrangementRecoverySchema.parse(JSON.parse(row.recovery))
    if (row.processing === null || row.committed_at === null) throw reject()
    const intent = arrangementProcessingSchema.parse(JSON.parse(row.processing))
    const context = arrangementTransitionContextSchema.parse(JSON.parse(row.context))
    const completedAt = saved.receipt.completedAt
    if (saved.requestHash !== arrangementDigest(saved.request) || saved.requestHash !== arrangementDigest(request)
      || saved.receipt.operationId !== row.id || saved.request.operationId !== row.id
      || saved.receipt.requestId !== saved.request.requestId || saved.receipt.reviewId !== row.review_id
      || saved.receipt.admissionRevision !== row.admission_revision + 1
      || saved.receipt.recordingStartsAt !== completedAt || completedAt < row.committed_at
      || completedAt < saved.request.issuedAt || completedAt >= saved.request.expiresAt
      || !isNewControllerGeneration(context.controller, saved.controller, completedAt)
      || new Set(saved.processing.receipts.map(receipt => receipt.component)).size !== 2
      || saved.processing.earliestAssignedSampleAt !== Math.max(...saved.processing.receipts.map(receipt => receipt.first_sample_ms))
      || saved.processing.receipts.some(receipt => receipt.intent_hash !== configHash(intent)
        || receipt.first_sample_ms < intent.committedAt || receipt.latest_sample_ms < receipt.first_sample_ms
        || receipt.latest_sample_ms > receipt.heartbeat_at_ms || receipt.heartbeat_at_ms > completedAt
        || completedAt - receipt.latest_sample_ms > 10000 || completedAt - receipt.heartbeat_at_ms > 5000)) throw reject()
    return saved.receipt
  }

  /** Read a validated completion without entering the release path, even if its request has expired. */
  readReceipt(credential: HouseholdCredential, operationId: string): ArrangementRecoveryReceipt | null {
    const row = readArrangementTransition(this.dependencies.database, operationId)
    if (!row || row.state !== 'committed') throw reject()
    this.authorize(credential, row)
    if (row.recovery === null) return null
    const saved = savedArrangementRecoverySchema.parse(JSON.parse(row.recovery))
    return this.replay(row, saved.request)
  }

  private current(credential: HouseholdCredential, row: ArrangementTransitionRow, request: ArrangementRecoveryRequest) {
    const session = this.authorize(credential, row)
    const observed = arrangementObservationSchema.parse(this.dependencies.observe())
    const context = arrangementTransitionContextSchema.parse(JSON.parse(row.context))
    const controller = controllerGenerationSchema.parse(this.dependencies.controllerGeneration())
    const now = this.now()
    if (!this.dependencies.enabled() || request.issuedAt > now || request.expiresAt <= now
      || session.sessionRevision !== request.expectedSessionRevision || session.assignmentRevision !== request.expectedAssignmentRevision
      || session.arrangement.mode !== 'assigned') throw reject()
    if (observed.runId !== this.dependencies.runId || [observed.presence, observed.thermal, observed.alarm, observed.base]
      .some(source => source.observedAt > now || now - source.observedAt > 5000)) throw reject()
    if (!isNewControllerGeneration(context.controller, controller, now)) throw reject()
    assertHardwareDrained(row.id, row.admission_revision)
    return { session, context, controller }
  }

  private approvedAssignments(row: ArrangementTransitionRow) {
    const database = this.dependencies.database
    const review = database.prepare('SELECT state FROM household_arrangement_reviews WHERE id = ? AND household_id = ?')
      .get(row.review_id, row.household_id) as { state: string } | undefined
    if (review?.state !== 'consumed') throw reject()
    const approvals = database.prepare(`SELECT account.sleeper_id AS sleeperId, account.assigned_side AS recordedSide
      FROM household_arrangement_approvals approval
      JOIN household_accounts account ON account.id = approval.account_id
      JOIN household_devices device ON device.id = approval.device_id AND device.account_id = account.id
      WHERE approval.review_id = ? AND account.household_id = ? AND account.state = 'active' AND device.revoked_at IS NULL
      ORDER BY account.assigned_side`).all(row.review_id, row.household_id)
    return assignmentsSchema.parse(approvals)
  }

  /** Keep the source reserved through the FULL-durability configuration commit; no source rows are changed. */
  recover(credential: HouseholdCredential, input: unknown): ArrangementRecoveryReceipt {
    const request = arrangementRecoveryRequestSchema.parse(input)
    const prior = readArrangementTransition(this.dependencies.database, request.operationId)
    if (!prior || prior.state !== 'committed') throw reject()
    this.authorize(credential, prior)
    const replay = this.replay(prior, request)
    if (replay) return replay
    if (this.dependencies.biometrics.inTransaction) throw reject()
    return this.dependencies.biometrics.transaction(() => this.admission.releaseWithReceipt(prior.id, prior.admission_revision, () => {
      const row = readArrangementTransition(this.dependencies.database, prior.id)
      if (!row || row.state !== 'committed' || row.recovery !== null) throw reject()
      const initial = this.current(credential, row, request)
      const binding = this.dependencies.historySource.verify(row.household_id, initial.context.history.datasetId)
      // Older committed receipts predate preservation. Never infer that format from a missing archive.
      const digestFormat = initial.context.learningArchiveVersion === 1 ? 'learning_v1' : 'legacy'
      if (arrangementDigest(binding) !== initial.context.history.bindingHash
        || committedArrangementDigest(this.dependencies.database, row.household_id, digestFormat) !== row.committed_hash) throw reject()
      const assignments = this.approvedAssignments(row)
      if (row.processing === null) throw reject()
      const intent = arrangementProcessingSchema.parse(JSON.parse(row.processing))
      if (intent.operationId !== row.id || intent.householdId !== row.household_id || intent.datasetId !== binding.datasetId
        || intent.committedAt !== row.committed_at || intent.assignmentRevision !== initial.session.assignmentRevision) throw reject()
      const attribution = this.dependencies.database.prepare('SELECT attribution_revision AS revision FROM household_history_state WHERE household_id = ?')
        .get(row.household_id) as { revision: number } | undefined
      const expectedRevision = revisionSchema.parse(initial.context.history.attributionRevision + 1)
      if (attribution?.revision !== expectedRevision) throw reject()
      revisionSchema.parse(expectedRevision + 1)
      // Recheck after all reads. The epoch begins here, never retroactively at the first processing sample.
      const final = this.current(credential, row, request)
      const completedAt = this.now()
      if (completedAt < final.controller.observedAt || completedAt - final.controller.observedAt > 5000
        || arrangementDigest({ ...initial.controller, observedAt: 0 }) !== arrangementDigest({ ...final.controller, observedAt: 0 })
        || completedAt >= request.expiresAt || completedAt < request.issuedAt) throw reject()
      const processing = readArrangementProcessing(this.dependencies.biometrics, intent, completedAt)
      if (!processing) throw reject()
      const epoch = this.dependencies.history.appendReviewedEpoch({ householdId: row.household_id, datasetId: binding.datasetId,
        expectedAttributionRevision: expectedRevision, startsAt: completedAt, endsAt: null, mode: 'assigned', assignments,
        basis: 'verified_arrangement', reviewReceiptId: request.requestId, reviewedBy: final.session.accountId })
      const receipt = arrangementRecoveryReceiptSchema.parse({ operationId: row.id, requestId: request.requestId, reviewId: row.review_id,
        state: 'completed', completedAt, admissionRevision: row.admission_revision + 1, epochId: epoch.epochId,
        recordingStartsAt: completedAt, hardware: 'admission_released', physicalMovement: 'not_requested' })
      const saved = savedArrangementRecoverySchema.parse({ request, requestHash: arrangementDigest(request), receipt,
        controller: final.controller, processing })
      const changed = this.dependencies.database.prepare('UPDATE household_arrangement_transitions SET recovery = ? WHERE id = ? AND recovery IS NULL')
        .run(JSON.stringify(saved), row.id)
      if (changed.changes !== 1) throw reject()
      this.current(credential, row, request)
      return receipt
    }).result).immediate()
  }
}

import type Database from 'better-sqlite3'
import { assertHardwareDrained } from '@/src/hardware/admission'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { controllerGenerationSchema, isNewControllerGeneration } from '@/src/server/controllerGeneration'
import { householdIdSchema } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import type { PersonHistorySource } from './historySource'
import { attributionEpochSchema } from './historyContract'
import { arrangementObservationSchema, arrangementTransitionRequestSchema } from './arrangementTransitionContract'
import { arrangementDigest } from './arrangementTransitionState'
import { arrangementResumeDigest } from './arrangementResumeState'
import { arrangementTransitionContextSchema, readArrangementTransition, rejectArrangementTransition as reject, type ArrangementTransitionRow } from './arrangementTransitionRecord'
import { arrangementCancellationReceiptSchema, arrangementCancellationRequestSchema, savedArrangementCancellationSchema,
  type ArrangementCancellationReceipt, type ArrangementCancellationRequest } from './arrangementCancellationContract'

interface Dependencies {
  database: Database.Database
  biometrics: Database.Database
  identities: HouseholdStore
  historySource: PersonHistorySource
  enabled: () => boolean
  observe: () => unknown
  controllerGeneration: () => unknown
  runId: string
  now?: () => number
}

/** Only uncommitted holds can be abandoned. The runtime/UI coordinator is registered separately. */
export class ArrangementCancellationStore {
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
    if (session.role !== 'owner') throw new HouseholdError('forbidden', 403, 'Only the current owner can cancel a held side transition.')
    if (session.householdId !== row.household_id || session.accountId !== row.account_id || deviceId !== row.device_id) throw reject()
    return session
  }

  private verifySoloHistory(row: ArrangementTransitionRow, sleeperId: string) {
    const database = this.dependencies.database
    const context = arrangementTransitionContextSchema.parse(JSON.parse(row.context))
    const binding = this.dependencies.historySource.verify(row.household_id, context.history.datasetId)
    const epochs = database.prepare(`SELECT * FROM household_attribution_epochs
      WHERE household_id = ? AND dataset_id = ? AND ends_at IS NULL ORDER BY starts_at`).all(row.household_id, binding.datasetId)
    const attribution = database.prepare('SELECT attribution_revision AS revision FROM household_history_state WHERE household_id = ?')
      .get(row.household_id) as { revision: number } | undefined
    if (arrangementDigest(binding) !== context.history.bindingHash || epochs.length !== 1
      || arrangementDigest(epochs[0]) !== context.history.epochHash || attribution?.revision !== context.history.attributionRevision) throw reject()
    const household = database.prepare('SELECT source_side FROM households WHERE id = ?').get(row.household_id) as { source_side: string } | undefined
    const epoch = epochs[0] as { assignments: string }
    const assignments = attributionEpochSchema.shape.assignments.parse(JSON.parse(epoch.assignments))
    if (assignments.length !== 1 || assignments[0]?.sleeperId !== sleeperId || assignments[0]?.recordedSide !== household?.source_side) throw reject()
    return context
  }

  /** A fresh preview may replace an outdated control digest without restoring or modifying any settings. */
  preview(credential: HouseholdCredential, operationId: string) {
    const row = readArrangementTransition(this.dependencies.database, operationId)
    if (!row || row.state !== 'held') throw reject()
    return this.snapshot(credential, row)
  }

  /** Receipt lookup cannot release a hold or resume services. */
  readReceipt(credential: HouseholdCredential, operationId: string): ArrangementCancellationReceipt | null {
    const row = readArrangementTransition(this.dependencies.database, operationId)
    if (!row) throw reject()
    this.authorize(credential, row)
    if (row.state !== 'cancelled' || row.cancellation === null) return null
    const saved = savedArrangementCancellationSchema.parse(JSON.parse(row.cancellation))
    return this.replay(row, saved.request)
  }

  private snapshot(credential: HouseholdCredential, row: ArrangementTransitionRow) {
    if (!this.dependencies.enabled()) throw reject()
    const session = this.authorize(credential, row)
    this.verifySoloHistory(row, session.selfSleeperId)
    const original = arrangementTransitionRequestSchema.parse(JSON.parse(row.request))
    const held = this.admission.read()
    if (session.arrangement.mode !== 'solo-anywhere' || session.assignmentRevision !== original.expectedAssignmentRevision
      || held.holdId !== row.id || held.revision !== row.admission_revision) throw reject()
    return { operationId: row.id, expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision,
      controlDigest: arrangementResumeDigest(this.dependencies.database, row.household_id), observedAt: this.now() }
  }

  private replay(row: ArrangementTransitionRow, request: ArrangementCancellationRequest): ArrangementCancellationReceipt {
    if (row.state !== 'cancelled' || row.cancellation === null) throw reject()
    const saved = savedArrangementCancellationSchema.parse(JSON.parse(row.cancellation))
    const context = arrangementTransitionContextSchema.parse(JSON.parse(row.context))
    if (saved.requestHash !== arrangementDigest(saved.request) || saved.requestHash !== arrangementDigest(request)
      || saved.receipt.operationId !== row.id || saved.request.operationId !== row.id
      || saved.receipt.requestId !== saved.request.requestId || saved.receipt.reviewId !== row.review_id
      || saved.receipt.admissionRevision !== row.admission_revision + 1
      || saved.receipt.controlDigest !== saved.request.expectedControlDigest || saved.receipt.completedAt < row.created_at
      || saved.receipt.completedAt < saved.request.issuedAt || saved.receipt.completedAt >= saved.request.expiresAt
      || !isNewControllerGeneration(context.controller, saved.controller, saved.receipt.completedAt)) throw reject()
    return saved.receipt
  }

  private current(credential: HouseholdCredential, row: ArrangementTransitionRow, request: ArrangementCancellationRequest) {
    const preview = this.snapshot(credential, row)
    const observed = arrangementObservationSchema.parse(this.dependencies.observe())
    const controller = controllerGenerationSchema.parse(this.dependencies.controllerGeneration())
    const context = arrangementTransitionContextSchema.parse(JSON.parse(row.context))
    const now = this.now()
    if (request.issuedAt > now || request.expiresAt <= now || preview.expectedSessionRevision !== request.expectedSessionRevision
      || preview.expectedAssignmentRevision !== request.expectedAssignmentRevision || preview.controlDigest !== request.expectedControlDigest
      || observed.runId !== this.dependencies.runId || [observed.presence, observed.thermal, observed.alarm, observed.base]
      .some(source => source.observedAt > now || now - source.observedAt > 5000)
      || !isNewControllerGeneration(context.controller, controller, now)) throw reject()
    assertHardwareDrained(row.id, row.admission_revision)
    return controller
  }

  /** Receipt, review cancellation and release are atomic. Personal settings and attribution never change. */
  cancel(credential: HouseholdCredential, input: unknown): ArrangementCancellationReceipt {
    const request = arrangementCancellationRequestSchema.parse(input)
    const prior = readArrangementTransition(this.dependencies.database, request.operationId)
    if (!prior || prior.state === 'committed') throw reject()
    this.authorize(credential, prior)
    if (prior.state === 'cancelled') return this.replay(prior, request)
    if (this.dependencies.biometrics.inTransaction) throw reject()
    return this.dependencies.biometrics.transaction(() => this.admission.releaseWithReceipt(prior.id, prior.admission_revision, () => {
      const row = readArrangementTransition(this.dependencies.database, prior.id)
      if (!row || row.state !== 'held') throw reject()
      const initial = this.current(credential, row, request)
      const changed = this.dependencies.database.prepare(`UPDATE household_arrangement_reviews SET state = 'cancelled'
        WHERE id = ? AND household_id = ? AND state IN ('open', 'cancelled')`).run(row.review_id, row.household_id)
      if (changed.changes !== 1) throw reject()
      const completedAt = this.now()
      const receipt = arrangementCancellationReceiptSchema.parse({ operationId: row.id, requestId: request.requestId, reviewId: row.review_id,
        state: 'cancelled', completedAt, admissionRevision: row.admission_revision + 1, controlDigest: request.expectedControlDigest,
        arrangement: 'solo-anywhere', hardware: 'admission_released', physicalMovement: 'not_requested' })
      const final = this.current(credential, row, request)
      if (arrangementDigest({ ...initial, observedAt: 0 }) !== arrangementDigest({ ...final, observedAt: 0 })
        || final.observedAt > completedAt || completedAt - final.observedAt > 5000) throw reject()
      const saved = savedArrangementCancellationSchema.parse({ request, requestHash: arrangementDigest(request), receipt, controller: final })
      const recorded = this.dependencies.database.prepare(`UPDATE household_arrangement_transitions SET state = 'cancelled', cancellation = ?
        WHERE id = ? AND state = 'held' AND cancellation IS NULL`).run(JSON.stringify(saved), row.id)
      if (recorded.changes !== 1) throw reject()
      // Recheck all sources after persistence too, including Stop dispatched by a concurrent callback.
      const ending = this.current(credential, row, request)
      if (arrangementDigest({ ...final, observedAt: 0 }) !== arrangementDigest({ ...ending, observedAt: 0 })) throw reject()
      const verified = readArrangementTransition(this.dependencies.database, row.id)
      if (!verified || arrangementDigest(this.replay(verified, request)) !== arrangementDigest(receipt)) throw reject()
      return receipt
    }).result).immediate()
  }
}

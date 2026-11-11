import type Database from 'better-sqlite3'
import { z } from 'zod'
import { assertHardwareDrained } from '@/src/hardware/admission'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { householdIdSchema, revisionSchema } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import type { ArrangementReviewService } from './arrangementReviews'
import type { PersonHistorySource } from './historySource'
import type { PersonHistoryStore } from './personHistory'
import { attributionEpochSchema } from './historyContract'
import { arrangementObservationSchema, arrangementTransitionRequestSchema, type ArrangementTransitionRequest, type ArrangementTransitionReceipt } from './arrangementTransitionContract'
import { arrangementDigest, arrangementPolicyDigest, commitArrangementWeeks, committedArrangementDigest, readArrangementArchive, resetArrangementControls } from './arrangementTransitionState'

interface Dependencies {
  database: Database.Database
  identities: HouseholdStore
  reviews: ArrangementReviewService
  historySource: PersonHistorySource
  history: PersonHistoryStore
  enabled: () => boolean
  // These observations must be collected by the runtime, never taken from HTTP input.
  observe: () => unknown
  runId: string
  now?: () => number
}
interface TransitionRow {
  id: string
  household_id: string
  review_id: string
  account_id: string
  device_id: string
  request_hash: string
  request: string
  run_id: string
  admission_revision: number
  state: 'held' | 'committed'
  created_at: number
  committed_at: number | null
  context: string
}
const reject = () => new HouseholdError('conflict', 409, 'The arrangement transition needs a fresh review or recovery. Hardware changes remain paused if a hold was already saved.')
const historyContextSchema = z.object({
  datasetId: householdIdSchema, attributionRevision: revisionSchema, epochId: householdIdSchema,
  startsAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  epochHash: z.string().regex(/^[a-f0-9]{64}$/), bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const contextSchema = z.object({ policy: z.string().regex(/^[a-f0-9]{64}$/), history: historyContextSchema }).strict()
const persistedRowSchema = z.object({
  id: householdIdSchema, household_id: householdIdSchema, review_id: householdIdSchema,
  account_id: householdIdSchema, device_id: householdIdSchema, run_id: householdIdSchema,
  request_hash: z.string().regex(/^[a-f0-9]{64}$/), request: z.string().max(8192),
  admission_revision: revisionSchema, state: z.enum(['held', 'committed']),
  created_at: z.number().int().positive(), committed_at: z.number().int().positive().nullable(), context: z.string().max(8192),
}).refine(row => (row.state === 'committed') === (row.committed_at !== null))

/** Atomic storage portion of attended activation. It never releases the hold or starts hardware.
 * A separate coordinator must drain writers and recover/reload all producer and biometric identities.
 * This class is intentionally not registered on the public API until that lifecycle is complete. */
export class ArrangementTransitionStore {
  private readonly now: () => number
  private readonly admission: HardwareAdmissionStore
  constructor(private readonly dependencies: Dependencies) {
    householdIdSchema.parse(dependencies.runId)
    this.now = dependencies.now ?? Date.now
    this.admission = new HardwareAdmissionStore(dependencies.database, this.now)
  }

  private receipt(row: TransitionRow): ArrangementTransitionReceipt {
    return { operationId: row.id, reviewId: row.review_id, state: row.state, admissionRevision: row.admission_revision,
      createdAt: row.created_at, committedAt: row.committed_at, hardware: 'held_for_runtime_recovery' }
  }

  private row(operationId: string) {
    const raw = this.dependencies.database.prepare('SELECT * FROM household_arrangement_transitions WHERE id = ?').get(operationId)
    if (!raw) return undefined
    const row = persistedRowSchema.parse(raw)
    const request = arrangementTransitionRequestSchema.parse(JSON.parse(row.request))
    if (request.requestId !== row.id || request.reviewId !== row.review_id || arrangementDigest(request) !== row.request_hash) throw reject()
    contextSchema.parse(JSON.parse(row.context))
    return row
  }

  private authorize(credential: HouseholdCredential, input: ArrangementTransitionRequest, row?: TransitionRow) {
    const session = this.dependencies.identities.session(credential)
    const deviceId = typeof credential === 'string' ? this.dependencies.identities.deviceIdentity(credential) : credential.deviceId
    if (session.role !== 'owner') throw new HouseholdError('forbidden', 403, 'Only the current owner can coordinate a reviewed side transition.')
    if (row && (row.household_id !== session.householdId || row.account_id !== session.accountId
      || row.device_id !== deviceId || row.request_hash !== arrangementDigest(input))) throw reject()
    return { session, deviceId }
  }

  private assertCurrent(input: ArrangementTransitionRequest) {
    if (!this.dependencies.enabled() || input.issuedAt > this.now() || input.expiresAt <= this.now()) throw reject()
    const observed = arrangementObservationSchema.parse(this.dependencies.observe())
    if (observed.runId !== this.dependencies.runId
      || [observed.presence, observed.thermal, observed.alarm, observed.base].some(source => source.observedAt > this.now() || this.now() - source.observedAt > 5_000)) throw reject()
  }

  private historyContext(householdId: string, ownerSleeperId: string, sourceSide: 'left' | 'right') {
    const database = this.dependencies.database
    const binding = database.prepare('SELECT dataset_id FROM household_history_sources WHERE household_id = ?').get(householdId) as { dataset_id: string } | undefined
    if (!binding) throw reject()
    const verified = this.dependencies.historySource.verify(householdId, binding.dataset_id)
    const epochs = database.prepare('SELECT * FROM household_attribution_epochs WHERE household_id = ? AND dataset_id = ? AND ends_at IS NULL ORDER BY starts_at').all(householdId, verified.datasetId) as { id: string, starts_at: number, mode: string, assignments: string, revoked_at: number | null }[]
    const epoch = epochs[0]
    if (epochs.length !== 1 || !epoch || epoch.revoked_at !== null || epoch.mode !== 'solo_merged' || epoch.starts_at >= this.now()) throw reject()
    const assignments = attributionEpochSchema.shape.assignments.parse(JSON.parse(epoch.assignments))
    if (assignments.length !== 1 || assignments[0]?.sleeperId !== ownerSleeperId || assignments[0]?.recordedSide !== sourceSide) throw reject()
    const state = database.prepare('SELECT attribution_revision FROM household_history_state WHERE household_id = ?').get(householdId) as { attribution_revision: number } | undefined
    return historyContextSchema.parse({ datasetId: verified.datasetId, attributionRevision: state?.attribution_revision ?? 1,
      epochId: epoch.id, startsAt: epoch.starts_at, epochHash: arrangementDigest(epoch), bindingHash: arrangementDigest(verified) })
  }

  /** No crash window can leave a receipt without its hold, or a new hold without its receipt. */
  begin(credential: HouseholdCredential, input: unknown): ArrangementTransitionReceipt {
    const request = arrangementTransitionRequestSchema.parse(input)
    return this.admission.holdWithReceipt(request.requestId, (admission, created) => {
      const prior = this.row(request.requestId)
      const { session, deviceId } = this.authorize(credential, request, prior)
      if (prior) {
        if (prior.admission_revision !== admission.revision) throw reject()
        return this.receipt(prior)
      }
      if (!created) throw reject()
      this.assertCurrent(request)
      const plan = this.dependencies.reviews.approvedForCommit(credential, request)
      // Validate every archive field before admitting this operation; retain the actual archive at commit.
      readArrangementArchive(this.dependencies.database)
      const context = contextSchema.parse({ policy: arrangementPolicyDigest(this.dependencies.database),
        history: this.historyContext(session.householdId, session.selfSleeperId, plan.sourceSide) })
      this.dependencies.database.prepare(`INSERT INTO household_arrangement_transitions
        (id, household_id, review_id, account_id, device_id, request_hash, request, run_id, admission_revision, state, created_at, context)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?)`).run(request.requestId, session.householdId, request.reviewId,
        session.accountId, deviceId, arrangementDigest(request), JSON.stringify(request), this.dependencies.runId,
        admission.revision, this.now(), JSON.stringify(context))
      const saved = this.row(request.requestId)
      if (!saved) throw reject()
      return this.receipt(saved)
    }).result
  }

  /** The caller drains first. All evidence, approvals and source identity are checked again at commit. */
  commit(credential: HouseholdCredential, input: unknown): ArrangementTransitionReceipt {
    const request = arrangementTransitionRequestSchema.parse(input)
    const row = this.row(request.requestId)
    if (!row) throw reject()
    this.authorize(credential, request, row)
    return this.admission.transactionWhileHeld(row.id, row.admission_revision, () => {
      const current = this.row(row.id)
      if (!current) throw reject()
      const { session } = this.authorize(credential, request, current)
      if (current.state === 'committed') return this.receipt(current)
      if (current.state !== 'held' || current.run_id !== this.dependencies.runId) throw reject()
      this.assertCurrent(request)
      assertHardwareDrained(current.id, current.admission_revision)
      const plan = this.dependencies.reviews.approvedForCommit(credential, request)
      const context = contextSchema.parse(JSON.parse(current.context))
      if (context.policy !== arrangementPolicyDigest(this.dependencies.database)
        || arrangementDigest(context.history) !== arrangementDigest(this.historyContext(session.householdId, session.selfSleeperId, plan.sourceSide))) throw reject()
      const database = this.dependencies.database
      const now = this.now()
      revisionSchema.parse(context.history.attributionRevision + 1)
      const archive = JSON.stringify(readArrangementArchive(database))
      // Consuming approval, both complete weeks, attribution and control reset share this transaction.
      this.dependencies.reviews.consumeForCommit(credential, request)
      commitArrangementWeeks(database, plan)
      this.dependencies.history.closeReviewedEpoch(context.history.epochId, {
        householdId: session.householdId, datasetId: context.history.datasetId,
        expectedAttributionRevision: context.history.attributionRevision, startsAt: context.history.startsAt, endsAt: now,
        mode: 'solo_merged', assignments: [{ sleeperId: session.selfSleeperId, recordedSide: plan.sourceSide }],
        basis: 'verified_arrangement', reviewReceiptId: current.id, reviewedBy: session.accountId,
      })
      resetArrangementControls(database, plan, now)
      for (const person of plan.participants) {
        revisionSchema.parse(person.sessionRevision + 1)
        const changed = database.prepare('UPDATE household_accounts SET assigned_side = ?, session_revision = session_revision + 1 WHERE id = ? AND state = \'active\' AND assigned_side IS NULL AND session_revision = ?')
          .run(person.side, person.accountId, person.sessionRevision)
        if (changed.changes !== 1) throw reject()
      }
      revisionSchema.parse(plan.householdRevision + 1)
      revisionSchema.parse(plan.assignmentRevision + 1)
      const changed = database.prepare('UPDATE households SET mode = \'assigned\', revision = revision + 1, assignment_revision = assignment_revision + 1, effective_at = ? WHERE id = ? AND revision = ? AND assignment_revision = ? AND mode = \'solo-anywhere\'')
        .run(now, session.householdId, plan.householdRevision, plan.assignmentRevision)
      if (changed.changes !== 1) throw reject()
      database.prepare('UPDATE household_arrangement_transitions SET state = \'committed\', committed_at = ?, archive = ?, committed_hash = ? WHERE id = ?')
        .run(now, archive, committedArrangementDigest(database, session.householdId), current.id)
      const saved = this.row(current.id)
      if (!saved) throw reject()
      return this.receipt(saved)
    }).result
  }
}

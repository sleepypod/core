import type Database from 'better-sqlite3'
import { assertHardwareDrained, blockHardwareUntilRestart, waitForHardwareDrain } from '@/src/hardware/admission'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { readControllerGeneration, isNewControllerGeneration, controllerGenerationSchema, type ControllerGeneration } from '@/src/server/controllerGeneration'
import { outsideControlRequest } from '@/src/controls/context'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import { ArrangementTransitionStore } from './arrangementTransition'
import { ArrangementRecoveryStore } from './arrangementRecovery'
import { ArrangementCancellationStore } from './arrangementCancellation'
import type { ArrangementReviewService } from './arrangementReviews'
import type { PersonHistorySource } from './historySource'
import type { PersonHistoryStore } from './personHistory'
import { arrangementObservationSchema, arrangementTransitionRequestSchema } from './arrangementTransitionContract'
import { arrangementRecoveryRequestSchema } from './arrangementRecoveryContract'
import { arrangementCancellationRequestSchema } from './arrangementCancellationContract'
import { arrangementTransitionContextSchema, readArrangementTransition } from './arrangementTransitionRecord'
import { readArrangementEvidence, type ArrangementEvidence } from './arrangementEvidence'
import { householdIdSchema, type HouseholdSession } from './contract'
import type { ArrangementReview } from './arrangementContract'
import { arrangementCanStart, arrangementCanActivateReview } from './arrangementAvailability'
import { arrangementMaintenanceStatusSchema, type ArrangementMaintenanceStatus } from './arrangementMaintenanceContract'
import { ArrangementRestartStore } from './arrangementRestart'
import { arrangementRestartRequestSchema, type ArrangementRestartRequest } from './arrangementRestartContract'
import { arrangementDigest } from './arrangementTransitionState'
import { submitControllerRestart } from '@/src/server/restartController'

interface Dependencies {
  database: Database.Database
  biometrics: Database.Database
  identities: HouseholdStore
  reviews: ArrangementReviewService
  historySource: PersonHistorySource
  history: PersonHistoryStore
  enabled: () => boolean
  runId: string
  now?: () => number
  readEvidence?: () => Promise<ArrangementEvidence>
  suspend?: () => Promise<void>
  resume?: () => Promise<void>
  drainBase?: () => Promise<void>
  drainHardware?: (operationId: string) => Promise<void>
  readGeneration?: () => Promise<ControllerGeneration>
  restartService?: () => Promise<void>
}
export type ArrangementAutomaticResult = 'resumed' | 'unavailable' | 'unchanged_by_replay'
const shared = globalThis as typeof globalThis & { __sp_arrangementCoordinators?: WeakMap<Database.Database, { busy: boolean }> }

/** Runtime orchestration; constructed once by the household host, never run by startup or import. */
export class ArrangementCoordinator {
  private readonly operation: { busy: boolean }
  private evidence: ArrangementEvidence | null = null
  private readonly transition: ArrangementTransitionStore
  private readonly recovery: ArrangementRecoveryStore
  private readonly cancellation: ArrangementCancellationStore
  private readonly restarts: ArrangementRestartStore
  private readonly now: () => number

  constructor(private readonly dependencies: Dependencies) {
    const operations = shared.__sp_arrangementCoordinators ??= new WeakMap()
    this.operation = operations.get(dependencies.database) ?? { busy: false }
    operations.set(dependencies.database, this.operation)
    this.now = dependencies.now ?? Date.now
    const storage = { ...dependencies, observe: () => this.evidence?.observation,
      controllerGeneration: () => this.evidence?.controller, now: this.now }
    this.transition = new ArrangementTransitionStore(storage)
    this.recovery = new ArrangementRecoveryStore(storage)
    this.cancellation = new ArrangementCancellationStore(storage)
    this.restarts = new ArrangementRestartStore(dependencies.database, this.now)
  }

  present(session: HouseholdSession): HouseholdSession {
    const available = arrangementCanStart(this.dependencies.database, session, this.dependencies.enabled() && !this.operation.busy)
    return { ...session, capabilities: { ...session.capabilities,
      arrangementReview: session.capabilities.arrangementReview === true && session.arrangement.mode === 'solo-anywhere',
      arrangementMaintenance: session.role === 'owner', activateArrangement: available } }
  }

  presentReview(session: HouseholdSession, review: ArrangementReview | null): ArrangementReview | null {
    if (!review) return null
    return { ...review, canActivate: arrangementCanActivateReview(session, review, this.present(session).capabilities.activateArrangement)
      && review.createdAt <= this.now() && review.expiresAt > this.now() }
  }

  private owner(credential: HouseholdCredential, assertRequestCurrent: () => void) {
    assertRequestCurrent()
    const session = this.dependencies.identities.session(credential)
    if (session.role !== 'owner') throw new HouseholdError('forbidden', 403, 'Only the current owner can coordinate the side transition.')
    return session
  }

  private async exclusive<Result>(credential: HouseholdCredential, assertRequestCurrent: () => void, operation: () => Promise<Result>): Promise<Result> {
    this.owner(credential, assertRequestCurrent)
    if (this.operation.busy) throw new HouseholdError('conflict', 409, 'A side transition is already being checked. Read its result before trying again.')
    this.operation.busy = true
    try {
      return await operation()
    }
    finally {
      this.evidence = null
      this.operation.busy = false
    }
  }

  private async refresh(issuedAt: number, expiresAt: number) {
    this.evidence = null
    if (!this.dependencies.enabled() || issuedAt > this.now() || expiresAt <= this.now()) {
      throw new HouseholdError('conflict', 409, 'Review the current arrangement and confirm a fresh attended request.')
    }
    const evidence = await (this.dependencies.readEvidence?.() ?? readArrangementEvidence(this.dependencies.runId))
    this.evidence = structuredClone(evidence)
  }

  private async drain(operationId: string, assertCurrent: () => void) {
    const suspend = this.dependencies.suspend ?? (await import('@/src/server/instrumentation-node')).suspendAutomaticServices
    assertCurrent()
    await suspend()
    assertCurrent()
    if (this.dependencies.drainBase) await this.dependencies.drainBase()
    else await (await import('@/src/hardware/base/instance')).getBaseControllerIfRunning()?.waitForWrites()
    assertCurrent()
    await (this.dependencies.drainHardware ?? waitForHardwareDrain)(operationId)
    assertCurrent()
  }

  private async resume(): Promise<ArrangementAutomaticResult> {
    try {
      const resume = this.dependencies.resume ?? (await import('@/src/server/instrumentation-node')).resumeAutomaticServices
      // Producers belong to the released arrangement, not the attended request's
      // old hardware intent or personal command lease.
      await outsideControlRequest(resume)
      return 'resumed'
    }
    catch {
      try {
        const suspend = this.dependencies.suspend ?? (await import('@/src/server/instrumentation-node')).suspendAutomaticServices
        await suspend()
      }
      catch { blockHardwareUntilRestart() }
      // Keep the durable release receipt distinct from automatic-service availability;
      // retrying that receipt cannot replay saved actions or a failed startup.
      return 'unavailable'
    }
  }

  async activate(credential: HouseholdCredential, input: unknown, assertRequestCurrent: () => void = () => {}) {
    const request = arrangementTransitionRequestSchema.parse(input)
    const assertCurrent = () => {
      this.owner(credential, assertRequestCurrent)
    }
    return this.exclusive(credential, assertRequestCurrent, async () => {
      const prior = this.transition.readReceipt(credential, request)
      if (prior?.receipt.state === 'committed') {
        if (prior.recovered) this.recovery.readReceipt(credential, request.requestId)
        return { ...prior, replayed: true }
      }
      await this.refresh(request.issuedAt, request.expiresAt)
      assertCurrent()
      const held = this.transition.begin(credential, request)
      await this.drain(held.operationId, assertCurrent)
      await this.refresh(request.issuedAt, request.expiresAt)
      assertCurrent()
      return { receipt: this.transition.commit(credential, request), recovered: false, replayed: false }
    })
  }

  async recover(credential: HouseholdCredential, input: unknown, assertRequestCurrent: () => void = () => {}) {
    const request = arrangementRecoveryRequestSchema.parse(input)
    const assertCurrent = () => {
      this.owner(credential, assertRequestCurrent)
    }
    return this.exclusive(credential, assertRequestCurrent, async () => {
      const row = readArrangementTransition(this.dependencies.database, request.operationId)
      if (row?.recovery !== null && row?.recovery !== undefined) {
        return { receipt: this.recovery.recover(credential, request), automaticServices: 'unchanged_by_replay' as const, replayed: true }
      }
      await this.refresh(request.issuedAt, request.expiresAt)
      assertCurrent()
      // Authorize the original device before suspension; a valid owner session alone
      // must not let another enrolled device operate on someone else's held request.
      this.authorizeOperation(credential, request.operationId, 'committed')
      await this.drain(request.operationId, assertCurrent)
      await this.refresh(request.issuedAt, request.expiresAt)
      assertCurrent()
      const receipt = this.recovery.recover(credential, request)
      const automaticServices = await this.resume()
      assertCurrent()
      return { receipt, automaticServices, replayed: false }
    })
  }

  cancellationPreview(credential: HouseholdCredential, operationId: string, assertRequestCurrent: () => void = () => {}) {
    this.owner(credential, assertRequestCurrent)
    return this.cancellation.preview(credential, operationId)
  }

  async cancel(credential: HouseholdCredential, input: unknown, assertRequestCurrent: () => void = () => {}) {
    const request = arrangementCancellationRequestSchema.parse(input)
    const assertCurrent = () => {
      this.owner(credential, assertRequestCurrent)
    }
    return this.exclusive(credential, assertRequestCurrent, async () => {
      const row = readArrangementTransition(this.dependencies.database, request.operationId)
      if (row?.state === 'cancelled') {
        return { receipt: this.cancellation.cancel(credential, request), automaticServices: 'unchanged_by_replay' as const, replayed: true }
      }
      await this.refresh(request.issuedAt, request.expiresAt)
      assertCurrent()
      this.authorizeOperation(credential, request.operationId, 'held')
      await this.drain(request.operationId, assertCurrent)
      await this.refresh(request.issuedAt, request.expiresAt)
      assertCurrent()
      const receipt = this.cancellation.cancel(credential, request)
      const automaticServices = await this.resume()
      assertCurrent()
      return { receipt, automaticServices, replayed: false }
    })
  }

  /** Reconnect reads current durable state; it never retries a transition or starts a service. */
  async status(credential: HouseholdCredential, operationId?: string, assertRequestCurrent: () => void = () => {}): Promise<ArrangementMaintenanceStatus> {
    this.owner(credential, assertRequestCurrent)
    if (operationId !== undefined) householdIdSchema.parse(operationId)
    let controller: ControllerGeneration | null = null
    try {
      controller = controllerGenerationSchema.parse(await (this.dependencies.readGeneration?.() ?? readControllerGeneration()))
    }
    catch { /* An unavailable generation is unknown, not proof that restart happened. */ }
    return this.dependencies.database.transaction(() => {
      const session = this.owner(credential, assertRequestCurrent)
      if (controller && (controller.observedAt > this.now() || this.now() - controller.observedAt > 5000)) controller = null
      const deviceId = typeof credential === 'string' ? this.dependencies.identities.deviceIdentity(credential) : credential.deviceId
      const latest = this.dependencies.database.prepare(`SELECT id FROM household_arrangement_transitions
        WHERE household_id = ? AND account_id = ? AND device_id = ? AND (? IS NULL OR id = ?)
        ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .get(session.householdId, session.accountId, deviceId, operationId ?? null, operationId ?? null) as { id: string } | undefined
      const row = latest ? readArrangementTransition(this.dependencies.database, latest.id) : undefined
      // Unknown and another device's operation have the same public result.
      const own = row?.household_id === session.householdId && row.account_id === session.accountId && row.device_id === deviceId
      let operation: ArrangementMaintenanceStatus['operation'] = null
      if (row && own) {
        const recovery = row.recovery === null ? null : this.recovery.readReceipt(credential, row.id)
        const cancellation = row.cancellation === null ? null : this.cancellation.readReceipt(credential, row.id)
        let admission: NonNullable<ArrangementMaintenanceStatus['operation']>['admission'] = 'unavailable'
        try {
          const current = new HardwareAdmissionStore(this.dependencies.database, this.now).read()
          admission = current.holdId === null ? 'open' : current.holdId === row.id ? 'held_for_this_transition' : 'held_for_another_transition'
        }
        catch { /* Missing admission is not an open controller. */ }
        const original = arrangementTransitionContextSchema.parse(JSON.parse(row.context))
        operation = { operationId: row.id, reviewId: row.review_id,
          state: recovery ? 'completed' : cancellation ? 'cancelled' : row.state,
          createdAt: row.created_at, committedAt: row.committed_at,
          controllerRestarted: controller ? isNewControllerGeneration(original.controller, controller, this.now()) : null,
          admission, recovery, cancellation, restart: this.restarts.read(row.id)?.receipt ?? null }
      }
      return arrangementMaintenanceStatusSchema.parse({ version: 1, observedAt: this.now(),
        expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision, operation })
    })()
  }

  private restartContext(credential: HouseholdCredential, request: ArrangementRestartRequest, assertRequestCurrent: () => void, requireDrained = true) {
    const session = this.owner(credential, assertRequestCurrent)
    const row = this.authorizeOperation(credential, request.operationId)
    const now = this.now()
    if (!this.dependencies.enabled() || request.issuedAt > now || request.expiresAt <= now
      || session.sessionRevision !== request.expectedSessionRevision || session.assignmentRevision !== request.expectedAssignmentRevision
      || !['held', 'committed'].includes(row.state) || row.recovery !== null) {
      throw new HouseholdError('conflict', 409, 'Read the current transition and confirm a fresh attended restart.')
    }
    const observed = arrangementObservationSchema.parse(this.evidence?.observation)
    const controller = controllerGenerationSchema.parse(this.evidence?.controller)
    const original = arrangementTransitionContextSchema.parse(JSON.parse(row.context)).controller
    if (observed.runId !== this.dependencies.runId || [observed.presence, observed.thermal, observed.alarm, observed.base, controller]
      .some(source => source.observedAt > now || now - source.observedAt > 5000)
      || arrangementDigest({ ...controller, observedAt: 0 }) !== arrangementDigest({ ...original, observedAt: 0 })) {
      throw new HouseholdError('conflict', 409, 'Restart is already observed or current device evidence is unavailable. Read the transition before continuing.')
    }
    if (requireDrained) assertHardwareDrained(row.id, row.admission_revision)
    return { row, controller }
  }

  /** Persist before dispatch. An uncertain or lost result can only be read, never replayed as another restart. */
  async restart(credential: HouseholdCredential, input: unknown, assertRequestCurrent: () => void = () => {}) {
    const request = arrangementRestartRequestSchema.parse(input)
    const assertOwner = () => {
      this.owner(credential, assertRequestCurrent)
    }
    return this.exclusive(credential, assertRequestCurrent, async () => {
      this.authorizeOperation(credential, request.operationId)
      const prior = this.restarts.read(request.operationId)
      if (prior) {
        if (arrangementDigest(prior.request) !== arrangementDigest(request)) {
          throw new HouseholdError('conflict', 409, 'A restart was already requested. Read its saved result; do not submit another restart.')
        }
        return { receipt: prior.receipt, replayed: true }
      }
      await this.refresh(request.issuedAt, request.expiresAt)
      this.restartContext(credential, request, assertRequestCurrent, false)
      await this.drain(request.operationId, assertOwner)
      await this.refresh(request.issuedAt, request.expiresAt)
      const assertCurrent = () => {
        this.restartContext(credential, request, assertRequestCurrent)
      }
      const { row, controller } = this.restartContext(credential, request, assertRequestCurrent)
      this.restarts.prepare(row, request, controller, assertCurrent)
      let outcome: 'submitted' | 'unconfirmed' = 'unconfirmed'
      try {
        assertCurrent()
        await (this.dependencies.restartService ?? submitControllerRestart)()
        outcome = 'submitted'
      }
      catch { /* Never echo subprocess output or retry an uncertain systemd submission. */ }
      const receipt = this.restarts.finish(row, request, outcome)
      assertOwner()
      return { receipt, replayed: false }
    })
  }

  private authorizeOperation(credential: HouseholdCredential, operationId: string, state?: 'held' | 'committed') {
    const row = readArrangementTransition(this.dependencies.database, operationId)
    const session = this.dependencies.identities.session(credential)
    const deviceId = typeof credential === 'string' ? this.dependencies.identities.deviceIdentity(credential) : credential.deviceId
    if (!row || (state !== undefined && row.state !== state) || row.household_id !== session.householdId || row.account_id !== session.accountId || row.device_id !== deviceId) {
      throw new HouseholdError('conflict', 409, 'Use the original owner device and the current transition.')
    }
    return row
  }
}

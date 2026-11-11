import type Database from 'better-sqlite3'
import { blockHardwareUntilRestart, waitForHardwareDrain } from '@/src/hardware/admission'
import { outsideControlRequest } from '@/src/controls/context'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import { ArrangementTransitionStore } from './arrangementTransition'
import { ArrangementRecoveryStore } from './arrangementRecovery'
import { ArrangementCancellationStore } from './arrangementCancellation'
import type { ArrangementReviewService } from './arrangementReviews'
import type { PersonHistorySource } from './historySource'
import type { PersonHistoryStore } from './personHistory'
import { arrangementTransitionRequestSchema } from './arrangementTransitionContract'
import { arrangementRecoveryRequestSchema } from './arrangementRecoveryContract'
import { arrangementCancellationRequestSchema } from './arrangementCancellationContract'
import { readArrangementTransition } from './arrangementTransitionRecord'
import { readArrangementEvidence, type ArrangementEvidence } from './arrangementEvidence'

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
  }

  private async exclusive<Result>(credential: HouseholdCredential, operation: () => Promise<Result>): Promise<Result> {
    const session = this.dependencies.identities.session(credential)
    if (session.role !== 'owner') throw new HouseholdError('forbidden', 403, 'Only the current owner can coordinate the side transition.')
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

  private async drain(operationId: string) {
    const suspend = this.dependencies.suspend ?? (await import('@/src/server/instrumentation-node')).suspendAutomaticServices
    await suspend()
    if (this.dependencies.drainBase) await this.dependencies.drainBase()
    else await (await import('@/src/hardware/base/instance')).getBaseControllerIfRunning()?.waitForWrites()
    await (this.dependencies.drainHardware ?? waitForHardwareDrain)(operationId)
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

  async activate(credential: HouseholdCredential, input: unknown) {
    const request = arrangementTransitionRequestSchema.parse(input)
    return this.exclusive(credential, async () => {
      const prior = this.transition.readReceipt(credential, request)
      if (prior?.receipt.state === 'committed') return { ...prior, replayed: true }
      await this.refresh(request.issuedAt, request.expiresAt)
      const held = this.transition.begin(credential, request)
      await this.drain(held.operationId)
      await this.refresh(request.issuedAt, request.expiresAt)
      return { receipt: this.transition.commit(credential, request), recovered: false, replayed: false }
    })
  }

  async recover(credential: HouseholdCredential, input: unknown) {
    const request = arrangementRecoveryRequestSchema.parse(input)
    return this.exclusive(credential, async () => {
      const row = readArrangementTransition(this.dependencies.database, request.operationId)
      if (row?.recovery !== null && row?.recovery !== undefined) {
        return { receipt: this.recovery.recover(credential, request), automaticServices: 'unchanged_by_replay' as const, replayed: true }
      }
      await this.refresh(request.issuedAt, request.expiresAt)
      // Authorize the original device before suspension; a valid owner session alone
      // must not let another enrolled device operate on someone else's held request.
      this.authorizeOperation(credential, request.operationId, 'committed')
      await this.drain(request.operationId)
      await this.refresh(request.issuedAt, request.expiresAt)
      const receipt = this.recovery.recover(credential, request)
      return { receipt, automaticServices: await this.resume(), replayed: false }
    })
  }

  cancellationPreview(credential: HouseholdCredential, operationId: string) {
    return this.cancellation.preview(credential, operationId)
  }

  async cancel(credential: HouseholdCredential, input: unknown) {
    const request = arrangementCancellationRequestSchema.parse(input)
    return this.exclusive(credential, async () => {
      const row = readArrangementTransition(this.dependencies.database, request.operationId)
      if (row?.state === 'cancelled') {
        return { receipt: this.cancellation.cancel(credential, request), automaticServices: 'unchanged_by_replay' as const, replayed: true }
      }
      await this.refresh(request.issuedAt, request.expiresAt)
      this.authorizeOperation(credential, request.operationId, 'held')
      await this.drain(request.operationId)
      await this.refresh(request.issuedAt, request.expiresAt)
      const receipt = this.cancellation.cancel(credential, request)
      return { receipt, automaticServices: await this.resume(), replayed: false }
    })
  }

  private authorizeOperation(credential: HouseholdCredential, operationId: string, state: 'held' | 'committed') {
    const row = readArrangementTransition(this.dependencies.database, operationId)
    const session = this.dependencies.identities.session(credential)
    const deviceId = typeof credential === 'string' ? this.dependencies.identities.deviceIdentity(credential) : credential.deviceId
    if (!row || row.state !== state || row.household_id !== session.householdId || row.account_id !== session.accountId || row.device_id !== deviceId) {
      throw new HouseholdError('conflict', 409, 'Use the original owner device and the current transition.')
    }
  }
}

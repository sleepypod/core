import type { HouseholdSession } from '../contract'
import { arrangementIndexSchema, type ArrangementReview } from '../arrangementContract'
import type { ArrangementMaintenanceStatus } from '../arrangementMaintenanceContract'
import { arrangementTransitionRequestSchema } from '../arrangementTransitionContract'
import { arrangementRestartRequestSchema } from '../arrangementRestartContract'
import { arrangementRecoveryRequestSchema } from '../arrangementRecoveryContract'
import { arrangementCancellationPreviewSchema, arrangementCancellationRequestSchema, type ArrangementCancellationPreview } from '../arrangementCancellationContract'
import type { PersonalWebTransport } from './client'
import { contextKey, identifier, PersonalWebError, readArrangementReview } from './protocol'
import { cancellationReplySchema, maintenanceOwner, readMaintenanceStatus, recoveryReplySchema, restartReplySchema, transitionReplySchema } from './maintenanceProtocol'

type Confirmation<Keys extends string> = Record<Keys, boolean>
export type ActivationConfirmation = Confirmation<'confirmEmptyAndAttended' | 'confirmClearTemporaryActions' | 'confirmPauseLearningAndSharedAutomations' | 'acknowledgeHeldUntilRecovery'>
export type RestartConfirmation = Confirmation<'confirmEmptyAndAttended' | 'acknowledgeConnectionWillClose' | 'acknowledgeControlsRemainPaused'>
export type RecoveryConfirmation = Confirmation<'confirmEmptyAndAttended' | 'confirmAssignedSides' | 'acknowledgeRecordingGap' | 'acknowledgeLearningRemainsOff'>
export type CancellationConfirmation = Confirmation<'confirmEmptyAndAttended' | 'confirmKeepSoloArrangement' | 'acknowledgeSavedRoutinesMayResume'>
export interface MaintenanceState {
  status: ArrangementMaintenanceStatus | null
  cancellation: ArrangementCancellationPreview | null
  loaded: boolean
  busy: boolean
  entered: boolean
  canActivate: boolean
  message: string
  error: string | null
}
interface Dependencies {
  session: HouseholdSession
  client: PersonalWebTransport
  entered: () => void
  invalidated: () => void
  finished?: () => void
  now?: () => number
}
const unavailable = () => new PersonalWebError('conflict', 'Check the current transition and review its next step before continuing.')

/** A dedicated maintenance view can follow its own assignment change; ordinary controls cannot. */
export class HouseholdMaintenanceWorkspace {
  private disposed = false
  private generation = 0
  private operationId: string | undefined
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private state: MaintenanceState = { status: null, cancellation: null, loaded: false, busy: false,
    entered: false, canActivate: false, message: '', error: null }

  constructor(private readonly dependencies: Dependencies) { this.now = dependencies.now ?? Date.now }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(patch: Partial<MaintenanceState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }

  private current(generation: number) {
    if (this.disposed || generation !== this.generation) throw new PersonalWebError('superseded', 'The maintenance view changed.')
  }

  private async owner(generation: number) {
    const session = maintenanceOwner(await this.dependencies.client.read('household/session'), this.dependencies.session)
    this.current(generation)
    return session
  }

  private enter() {
    if (this.state.entered) return
    this.update({ entered: true })
    this.dependencies.entered()
  }

  private fail(error: unknown, generation: number) {
    if (this.disposed || generation !== this.generation) return
    this.update({ loaded: false, cancellation: null, canActivate: false, error: error instanceof PersonalWebError
      ? error.message
      : 'The result could not be verified. Check the saved transition; nothing will be resent.' })
    if (error instanceof PersonalWebError && ['authentication', 'account_changed'].includes(error.code)) {
      this.dispose()
      this.dependencies.invalidated()
    }
  }

  private async checkedStatus(generation: number) {
    const session = await this.owner(generation)
    const suffix = this.operationId ? `?operationId=${encodeURIComponent(this.operationId)}` : ''
    const input = await this.dependencies.client.read(`household/transition${suffix}`)
    this.current(generation)
    const after = await this.owner(generation)
    if (contextKey(after) !== contextKey(session)) throw unavailable()
    const status = readMaintenanceStatus(input, after, this.now(), this.operationId)
    if (status.operation) this.operationId = status.operation.operationId
    this.update({ status, loaded: true, canActivate: after.capabilities.activateArrangement, error: null })
    if (status.operation && ['held', 'committed'].includes(status.operation.state)) this.enter()
    return { status, session: after }
  }

  async refresh() {
    if (this.disposed || this.state.busy || this.dependencies.session.role !== 'owner') return
    const generation = this.generation
    this.update({ busy: true, cancellation: null, error: null })
    try {
      await this.checkedStatus(generation)
      this.update({ message: 'Saved transition checked. No action was repeated.' })
    }
    catch (error) { this.fail(error, generation) }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }

  private async operation(run: (generation: number, session: HouseholdSession, status: ArrangementMaintenanceStatus) => Promise<void>) {
    if (this.disposed || this.state.busy || !this.state.loaded || !this.state.status) return
    const generation = this.generation, expected = this.state.status
    this.update({ busy: true, error: null, message: '' })
    try {
      const { status, session } = await this.checkedStatus(generation)
      if (status.expectedSessionRevision !== expected.expectedSessionRevision || status.expectedAssignmentRevision !== expected.expectedAssignmentRevision
        || status.operation?.operationId !== expected.operation?.operationId || status.operation?.state !== expected.operation?.state) throw unavailable()
      await run(generation, session, status)
    }
    catch (error) { this.fail(error, generation) }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }

  private context(session: HouseholdSession) {
    const issuedAt = this.now()
    return { version: 1, requestId: identifier(), expectedSessionRevision: session.sessionRevision,
      expectedAssignmentRevision: session.assignmentRevision, issuedAt, expiresAt: issuedAt + 60_000 }
  }

  private pending(status: ArrangementMaintenanceStatus, state?: 'held' | 'committed') {
    const operation = status.operation
    if (!operation || (state ? operation.state !== state : !['held', 'committed'].includes(operation.state))
      || operation.admission !== 'held_for_this_transition') throw unavailable()
    return operation
  }

  private async submit(generation: number, path: string, request: unknown) {
    this.current(generation)
    this.enter()
    this.current(generation)
    this.update({ loaded: false, cancellation: null })
    const result = await this.dependencies.client.read(path, 'POST', request)
    this.current(generation)
    return result
  }

  async activate(review: ArrangementReview, confirmation: ActivationConfirmation) {
    await this.operation(async (generation, session, status) => {
      if (!session.capabilities.activateArrangement || status.operation !== null || session.arrangement.mode !== 'solo-anywhere') throw unavailable()
      const index = arrangementIndexSchema.parse(await this.dependencies.client.read('household/arrangement'))
      this.current(generation)
      const current = readArrangementReview(index.review, session)
      if (current.reviewId !== review.reviewId || current.state !== 'approved_for_separate_activation'
        || !current.canActivate || current.createdAt > this.now() || current.expiresAt <= this.now()) throw unavailable()
      const after = await this.owner(generation)
      if (contextKey(after) !== contextKey(session)) throw unavailable()
      const request = arrangementTransitionRequestSchema.parse({ ...this.context(after), ...confirmation, reviewId: current.reviewId })
      this.operationId = request.requestId
      const result = transitionReplySchema.parse(await this.submit(generation, 'household/transition', request))
      if (result.receipt.operationId !== request.requestId || result.receipt.reviewId !== request.reviewId) throw unavailable()
      await this.checkedStatus(generation)
      this.update({ message: 'Side transition saved. Finish the attended restart and recovery before using the bed.' })
    })
  }

  async restart(confirmation: RestartConfirmation) {
    await this.operation(async (generation, session, status) => {
      const operation = this.pending(status)
      if (operation.restart !== null || operation.controllerRestarted !== false) throw unavailable()
      const request = arrangementRestartRequestSchema.parse({ ...this.context(session), ...confirmation, operationId: operation.operationId })
      const result = restartReplySchema.parse(await this.submit(generation, 'household/transition/restart', request))
      if (result.receipt.requestId !== request.requestId || result.receipt.operationId !== operation.operationId) throw unavailable()
      this.update({ message: result.receipt.state === 'submitted'
        ? 'Restart requested. Reconnect and check the saved result; controls stay paused.'
        : 'The restart could not be confirmed. Check the saved result; it will not be requested again.' })
      // A controller may close this connection now. Only a later explicit read proves its new process.
    })
  }

  async recover(confirmation: RecoveryConfirmation) {
    await this.operation(async (generation, session, status) => {
      const operation = this.pending(status, 'committed')
      if (operation.controllerRestarted !== true) throw unavailable()
      const request = arrangementRecoveryRequestSchema.parse({ ...this.context(session), ...confirmation, operationId: operation.operationId })
      const result = recoveryReplySchema.parse(await this.submit(generation, 'household/transition/recover', request))
      if (result.receipt.requestId !== request.requestId || result.receipt.operationId !== operation.operationId) throw unavailable()
      await this.checkedStatus(generation)
      this.update({ message: result.automaticServices === 'resumed'
        ? 'The controller accepted recovery and resumed its routine services. Check each side before ordinary use.'
        : 'Recovery was recorded, but routine-service startup is not confirmed. Check controller status before ordinary use.' })
    })
  }

  async previewCancellation() {
    await this.operation(async (generation, session, status) => {
      const operation = this.pending(status, 'held')
      if (operation.controllerRestarted !== true) throw unavailable()
      const preview = arrangementCancellationPreviewSchema.parse(await this.dependencies.client.read(`household/transition/cancellation-preview?operationId=${encodeURIComponent(operation.operationId)}`))
      const after = await this.owner(generation)
      if (contextKey(after) !== contextKey(session) || preview.operationId !== operation.operationId
        || preview.expectedSessionRevision !== session.sessionRevision || preview.expectedAssignmentRevision !== session.assignmentRevision
        || preview.observedAt > this.now() || this.now() - preview.observedAt > 15_000) throw unavailable()
      this.update({ cancellation: preview, message: 'Keeping the current solo arrangement is ready to review. Saved routines may resume when you confirm.' })
    })
  }

  async cancel(confirmation: CancellationConfirmation) {
    const preview = this.state.cancellation
    if (!preview) return
    await this.operation(async (generation, session, status) => {
      const operation = this.pending(status, 'held')
      if (operation.controllerRestarted !== true || preview.operationId !== operation.operationId || preview.expectedSessionRevision !== session.sessionRevision
        || preview.expectedAssignmentRevision !== session.assignmentRevision || preview.observedAt > this.now()
        || this.now() - preview.observedAt > 60_000) throw unavailable()
      const request = arrangementCancellationRequestSchema.parse({ ...this.context(session), ...confirmation,
        operationId: operation.operationId, expectedControlDigest: preview.controlDigest })
      const result = cancellationReplySchema.parse(await this.submit(generation, 'household/transition/cancel', request))
      if (result.receipt.requestId !== request.requestId || result.receipt.operationId !== operation.operationId) throw unavailable()
      await this.checkedStatus(generation)
      this.update({ message: result.automaticServices === 'resumed'
        ? 'Solo arrangement kept. The controller resumed its saved routine services.'
        : 'Solo arrangement kept. Routine-service startup is not confirmed; check controller status.' })
    })
  }

  async returnToControls() {
    await this.operation(async (_generation, _session, status) => {
      if (!status.operation || !['completed', 'cancelled'].includes(status.operation.state) || status.operation.admission !== 'open') throw unavailable()
      this.dependencies.finished?.()
    })
  }

  clear() {
    this.generation++
    this.update({ status: null, cancellation: null, loaded: false, busy: false, canActivate: false, error: null, message: '' })
  }

  dispose() {
    if (this.disposed) return
    this.clear()
    this.disposed = true
    this.dependencies.client.dispose()
    this.listeners.clear()
  }
}

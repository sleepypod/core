import { ExperimentBrowserProblem } from './browserError'
import { experimentProposalSchema, type ExperimentFeedback } from './contract'
import { experimentDetailSchema, experimentLibrarySchema, experimentReviewSchema, readExperimentEnvelope, sameExperimentScope, validateExperimentDetail, type ExperimentBrowserScope, type ExperimentDetail, type ExperimentLibrary, type ExperimentReview } from './browserContract'
import { experimentNights } from './nights'
import { readBrowserExperimentExecution, type BrowserExperimentExecution } from './browserExecution'
export interface ExperimentBrowserAccess {
  scope: ExperimentBrowserScope
  revision: string
  execution?: boolean
}
export interface ExperimentBrowserTransport {
  access(signal: AbortSignal): Promise<ExperimentBrowserAccess>
  request(path: string, method: 'GET' | 'POST', body: unknown, signal: AbortSignal): Promise<unknown>
}
export interface ExperimentBrowserState {
  draft: { firstNightDate: string, variantF: number } | null
  library: ExperimentLibrary | null
  review: ExperimentReview | null
  detail: ExperimentDetail | null
  execution: BrowserExperimentExecution | null
  executionAvailable: boolean
  busy: boolean
  error: string | null
  message: string | null
  uncertain: {
    id: string
    action: 'confirm' | 'stop' | 'feedback' | 'execution_confirm' | 'execution_recover'
    controlStopped?: boolean
    planStopped?: boolean
  } | null
  now: number
}
const empty = (now: number): ExperimentBrowserState => ({ draft: null, library: null, review: null, detail: null,
  execution: null, executionAvailable: false,
  busy: false, error: null, message: null, uncertain: null, now })
/** Account-scoped, memory-only workspace. Lost writes are reconciled by reads, never replayed. */
export class ComfortExperimentBrowserWorkspace {
  private state: ExperimentBrowserState
  private listeners = new Set<() => void>()
  private generation = 0
  private controller: AbortController | null = null
  private anchor: ExperimentBrowserAccess | null = null
  private disposed = false
  constructor(private readonly transport: ExperimentBrowserTransport, private readonly now = Date.now) {
    this.state = empty(now())
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(patch: Partial<ExperimentBrowserState>) {
    if (this.disposed)
      return
    this.state = { ...this.state, ...patch, now: this.now() }
    this.listeners.forEach(listener => listener())
  }

  clear() {
    ++this.generation
    this.controller?.abort()
    this.controller = null
    this.update(empty(this.now()))
  }

  dispose() {
    this.clear()
    this.disposed = true
    this.listeners.clear()
  }

  tick() {
    if (this.state.review && this.now() >= this.state.review.expiresAt)
      this.update({ review: null, message: 'The review expired. Preview the nights again before saving.' })
    else if (this.state.execution?.review && this.now() >= this.state.execution.review.expiresAt)
      this.update({ execution: { ...this.state.execution, review: null }, message: 'The control review expired. Review overnight control again before allowing it.' })
    else
      this.update({})
  }

  discardReview() {
    if (!this.state.busy)
      this.update({ review: null, message: null })
  }

  /** Verify identity around every operation; only an explicit action may submit a write. */
  private async perform(work: (access: ExperimentBrowserAccess, signal: AbortSignal) => Promise<Partial<ExperimentBrowserState>>, pending: ExperimentBrowserState['uncertain'] = null) {
    if (this.disposed || this.state.busy)
      return
    this.controller?.abort()
    const generation = ++this.generation, controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), 20000)
    this.update({ busy: true, error: null, message: null })
    const current = () => {
      if (this.disposed || generation !== this.generation || controller.signal.aborted)
        throw new Error('The experiment request was interrupted.')
    }
    let verifiedAccount = false
    try {
      const access = await this.transport.access(controller.signal)
      current()
      if (this.anchor && !sameAccess(access, this.anchor))
        throw new Error('Account changed.')
      this.anchor ??= access
      verifiedAccount = true
      const patch = await work(access, controller.signal)
      current()
      const after = await this.transport.access(controller.signal)
      current()
      if (!sameAccess(access, after)) {
        verifiedAccount = false
        throw new Error('Account changed.')
      }
      this.update({ ...patch, executionAvailable: access.execution === true, busy: false, uncertain: null })
    }
    catch (error) {
      if (!this.disposed && generation === this.generation)
        this.update({ ...empty(this.now()),
          uncertain: verifiedAccount ? pending : null,
          error: verifiedAccount && pending
            ? pending.controlStopped
              ? 'The comparison plan and its control authorization are stopped. The latest status could not be refreshed. Check the saved result; nothing will be resent.'
              : pending.planStopped
                ? 'The comparison plan is closed, but control cancellation is not yet confirmed. Check its saved result; nothing will be resent.'
                : 'The saved result is uncertain. Check it before making another change; nothing will be resent.'
            : error instanceof ExperimentBrowserProblem ? error.message : 'The comparison could not be verified. Reload this page to check your account and routines.' })
    }
    finally {
      clearTimeout(timeout)
      if (generation === this.generation)
        this.controller = null
    }
  }

  open() {
    if (this.state.uncertain) return this.reconcile()
    return this.perform(async (access, signal) => ({ library: readExperimentEnvelope(experimentLibrarySchema, await this.transport.request('', 'GET', undefined, signal), access.scope, this.now()), review: null, detail: null, execution: null }))
  }

  older() {
    const previous = this.state.library
    if (!previous?.nextId)
      return Promise.resolve()
    return this.perform(async (access, signal) => {
      const page = readExperimentEnvelope(experimentLibrarySchema, await this.transport.request(`?afterId=${previous.nextId}`, 'GET', undefined, signal), access.scope, this.now())
      // This is paginated navigation, not an ever-growing cache of private records.
      return { library: page, review: null, detail: null, execution: null }
    })
  }

  private async readDetail(id: string, access: ExperimentBrowserAccess, signal: AbortSignal) {
    return validateExperimentDetail(readExperimentEnvelope(experimentDetailSchema, await this.transport.request(id, 'GET', undefined, signal), access.scope, this.now()), id)
  }

  private async readSelection(id: string, access: ExperimentBrowserAccess, signal: AbortSignal) {
    const detail = await this.readDetail(id, access, signal)
    const execution = access.execution
      ? readBrowserExperimentExecution(await this.transport.request(`${id}/execution`, 'GET', undefined, signal), detail.record, access.scope, this.now())
      : null
    return { detail, execution }
  }

  select(id: string) {
    if (this.state.uncertain) return Promise.resolve()
    return this.perform(async (access, signal) => ({ ...await this.readSelection(id, access, signal), review: null }))
  }

  preview(firstNightDate: string, variantF: number) {
    if (this.state.uncertain)
      return Promise.resolve()
    return this.perform(async (access, signal) => {
      const proposal = experimentProposalSchema.parse({ firstNightDate, variantF })
      const review = readExperimentEnvelope(experimentReviewSchema, await this.transport.request('preview', 'POST', proposal, signal), access.scope, this.now())
      if (review.plan.version !== 2 || review.reviewId !== review.plan.id || review.expiresAt <= this.now()
        || review.plan.variantF !== proposal.variantF || review.schedule.requestedFirstNightDate !== proposal.firstNightDate
        || JSON.stringify(review.schedule) !== JSON.stringify(review.plan.schedule)
        || JSON.stringify(review.nights) !== JSON.stringify(experimentNights(review.plan)))
        throw new Error('Review changed.')
      return { review, detail: null, execution: null, draft: proposal }
    })
  }

  confirm() {
    const review = this.state.review
    if (!review || this.state.uncertain || review.expiresAt <= this.now()) {
      this.tick()
      return Promise.resolve()
    }
    return this.perform(async (access, signal) => {
      const detail = validateExperimentDetail(readExperimentEnvelope(experimentDetailSchema, await this.transport.request('confirm', 'POST', { reviewId: review.reviewId, planHash: review.planHash }, signal), access.scope, this.now()), review.reviewId)
      if (JSON.stringify(detail.record.plan) !== JSON.stringify(review.plan))
        throw new Error('Saved plan differs from the review.')
      const selection = access.execution ? await this.readSelection(review.reviewId, access, signal) : { detail, execution: null }
      return { ...selection, review: null, library: null, message: 'Comparison saved. Overnight control has not been activated.' }
    }, { id: review.reviewId, action: 'confirm' })
  }

  stop() {
    const detail = this.state.detail
    if (!detail || (detail.record.status === 'stopped' && this.state.execution?.state !== 'admitted') || this.state.uncertain)
      return Promise.resolve()
    const pending: NonNullable<ExperimentBrowserState['uncertain']> = { id: detail.record.plan.id, action: 'stop' }
    return this.perform(async (access, signal) => {
      // Close the plan first so another device cannot create a new admission between
      // cancellation and closure. Then drain the retained grant under its side locks.
      const stopped = validateExperimentDetail(readExperimentEnvelope(experimentDetailSchema, await this.transport.request(`${pending.id}/stop`, 'POST', { expectedRevision: detail.record.revision }, signal), access.scope, this.now()), pending.id)
      if (stopped.record.status !== 'stopped') throw new Error('The comparison is still open.')
      pending.planStopped = true
      if (access.execution) {
        const current = await this.readSelection(pending.id, access, signal)
        if (current.execution?.state === 'admitted' && current.execution.admission) {
          const stopped = await this.executionRequest(current.detail, access, signal, 'cancel', { admissionId: current.execution.admission.id })
          if (stopped.state !== 'revoked' || stopped.admission?.id !== current.execution.admission.id)
            throw new Error('The control cancellation could not be verified.')
          pending.controlStopped = true
        }
      }
      const selection = access.execution ? await this.readSelection(pending.id, access, signal) : { detail: stopped, execution: null }
      if (selection.execution?.state === 'admitted') throw new Error('Control cancellation remains unconfirmed.')
      return { ...selection, review: null, library: null,
        message: 'Comparison stopped. Further experiment adjustments are disabled. Check the bed controls for the current target.' }
    }, pending)
  }

  feedback(feedback: Omit<ExperimentFeedback, 'recordedAt'>) {
    const detail = this.state.detail
    if (!detail || this.state.uncertain)
      return Promise.resolve()
    return this.perform(async (access, signal) => {
      const saved = validateExperimentDetail(readExperimentEnvelope(experimentDetailSchema, await this.transport.request(`${detail.record.plan.id}/feedback`, 'POST', { expectedRevision: detail.record.revision, feedback }, signal), access.scope, this.now()), detail.record.plan.id)
      return { ...(access.execution ? await this.readSelection(detail.record.plan.id, access, signal) : { detail: saved, execution: null }),
        message: 'Morning feedback saved. Ratings alone do not confirm the temperature you received.' }
    }, { id: detail.record.plan.id, action: 'feedback' })
  }

  private async executionRequest(detail: ExperimentDetail, access: ExperimentBrowserAccess, signal: AbortSignal,
    action: 'preview' | 'confirm' | 'cancel' | 'recover', body: unknown) {
    if (!access.execution) throw new Error('Overnight comparison control is unavailable.')
    return readBrowserExperimentExecution(await this.transport.request(`${detail.record.plan.id}/execution/${action}`, 'POST', body, signal),
      detail.record, access.scope, this.now())
  }

  reviewExecution() {
    const { detail, uncertain, executionAvailable } = this.state
    if (!detail || uncertain || !executionAvailable || detail.record.status !== 'planned' || !detail.contextCurrent || this.state.execution?.state === 'admitted') return Promise.resolve()
    return this.perform(async (access, signal) => {
      try {
        const execution = await this.executionRequest(detail, access, signal, 'preview', {})
        if (!execution.review || execution.review.expiresAt <= this.now()) throw new Error('No current control review.')
        return { execution }
      }
      catch (error) {
        // Readiness failures do not discard the saved plan or remove its Stop action.
        // perform still checks the account again before showing the explanation.
        if (!(error instanceof ExperimentBrowserProblem)) throw error
        return { execution: this.state.execution ? { ...this.state.execution, review: null } : null, error: error.message }
      }
    })
  }

  discardExecutionReview() {
    if (!this.state.busy && this.state.execution)
      this.update({ execution: { ...this.state.execution, review: null }, message: null })
  }

  confirmExecution() {
    const { detail, execution, uncertain } = this.state, review = execution?.review
    if (!detail || !review || uncertain || review.expiresAt <= this.now()) {
      this.tick()
      return Promise.resolve()
    }
    return this.perform(async (access, signal) => {
      const saved = await this.executionRequest(detail, access, signal, 'confirm', { reviewId: review.id, planHash: review.planHash, confirmed: true })
      if (saved.state !== 'admitted' || saved.admission?.id !== review.id || JSON.stringify(saved.admission.sides) !== JSON.stringify(review.sides))
        throw new Error('The saved control authorization could not be verified.')
      return { execution: saved, message: 'Overnight comparison authorized for its scheduled nights. Wake warming stays separate.' }
    }, { id: detail.record.plan.id, action: 'execution_confirm' })
  }

  recoverExecution(applicationId: string) {
    const { detail, execution, uncertain } = this.state
    const application = execution?.applications.find(item => item.id === applicationId)
    if (!detail || !execution?.admission || uncertain || !application || !['attempting', 'unknown'].includes(application.outcome)) return Promise.resolve()
    const admissionId = execution.admission.id
    return this.perform(async (access, signal) => {
      const saved = await this.executionRequest(detail, access, signal, 'recover', { admissionId, applicationId, confirmed: true })
      if (saved.state !== 'revoked' || saved.admission?.id !== admissionId || saved.applications.find(item => item.id === applicationId)?.outcome !== 'resolved')
        throw new Error('The firmware readback could not be verified.')
      return { execution: saved, message: 'Fresh firmware target checked and old authorization ended. No temperature command was replayed.' }
    }, { id: detail.record.plan.id, action: 'execution_recover' })
  }

  reconcile() {
    const pending = this.state.uncertain
    if (!pending)
      return Promise.resolve()
    return this.perform(async (access, signal) => ({ ...await this.readSelection(pending.id, access, signal), review: null,
      message: 'Current saved record loaded. Review its control status and feedback below; no write was repeated.' }), pending)
  }

  async checkAccess() {
    if (this.disposed || this.state.busy || !this.anchor || (!this.state.library && !this.state.review && !this.state.detail))
      return
    const generation = this.generation, controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const access = await this.transport.access(controller.signal)
      if (generation !== this.generation || this.disposed)
        return
      if (controller.signal.aborted || !sameAccess(access, this.anchor))
        throw new Error('Account changed.')
      // Refresh readback without changing focus or renewing a confirmation review.
      if (this.state.detail && access.execution && !this.state.execution?.review && !this.state.uncertain) {
        const selection = await this.readSelection(this.state.detail.record.plan.id, access, controller.signal)
        const after = await this.transport.access(controller.signal)
        if (generation !== this.generation || this.disposed) return
        if (controller.signal.aborted || !sameAccess(access, after)) throw new Error('Account changed.')
        this.update(selection)
      }
    }
    catch {
      if (generation === this.generation && !this.disposed) {
        this.clear()
        this.update({ error: 'Account access changed. Reopen comparisons to check your current account.' })
      }
    }
    finally {
      clearTimeout(timeout)
    }
  }
}
const sameAccess = (first: ExperimentBrowserAccess, second: ExperimentBrowserAccess) => first.revision === second.revision
  && Boolean(first.execution) === Boolean(second.execution) && sameExperimentScope(first.scope, second.scope)

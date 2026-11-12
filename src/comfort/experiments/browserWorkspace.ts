import { ExperimentBrowserProblem } from './browserError'
import { experimentProposalSchema, type ExperimentFeedback } from './contract'
import { experimentDetailSchema, experimentLibrarySchema, experimentReviewSchema, readExperimentEnvelope, sameExperimentScope, validateExperimentDetail, type ExperimentBrowserScope, type ExperimentDetail, type ExperimentLibrary, type ExperimentReview } from './browserContract'
import { experimentNights } from './nights'
export interface ExperimentBrowserAccess {
  scope: ExperimentBrowserScope
  revision: string
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
  busy: boolean
  error: string | null
  message: string | null
  uncertain: {
    id: string
    action: 'confirm' | 'stop' | 'feedback'
  } | null
  now: number
}
const empty = (now: number): ExperimentBrowserState => ({ draft: null, library: null, review: null, detail: null,
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
    else
      this.update({})
  }

  discardReview() {
    if (!this.state.busy)
      this.update({ review: null, message: null })
  }

  /** Every operation verifies the same account before and after its single request. */
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
      this.update({ ...patch, busy: false, uncertain: null })
    }
    catch (error) {
      if (!this.disposed && generation === this.generation)
        this.update({ ...empty(this.now()),
          uncertain: verifiedAccount ? pending : null,
          error: verifiedAccount && pending
            ? 'The saved result is uncertain. Check it before making another change; nothing will be resent.'
            : error instanceof ExperimentBrowserProblem ? error.message : 'The comparison could not be verified. Reload this page to check your account and routines.' })
    }
    finally {
      clearTimeout(timeout)
      if (generation === this.generation)
        this.controller = null
    }
  }

  open() {
    return this.perform(async (access, signal) => ({ library: readExperimentEnvelope(experimentLibrarySchema, await this.transport.request('', 'GET', undefined, signal), access.scope, this.now()), review: null, detail: null }))
  }

  older() {
    const previous = this.state.library
    if (!previous?.nextId)
      return Promise.resolve()
    return this.perform(async (access, signal) => {
      const page = readExperimentEnvelope(experimentLibrarySchema, await this.transport.request(`?afterId=${previous.nextId}`, 'GET', undefined, signal), access.scope, this.now())
      // This is paginated navigation, not an ever-growing cache of private records.
      return { library: page, review: null, detail: null }
    })
  }

  private async readDetail(id: string, access: ExperimentBrowserAccess, signal: AbortSignal) {
    return validateExperimentDetail(readExperimentEnvelope(experimentDetailSchema, await this.transport.request(id, 'GET', undefined, signal), access.scope, this.now()), id)
  }

  select(id: string) {
    return this.perform(async (access, signal) => ({ detail: await this.readDetail(id, access, signal), review: null }))
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
      return { review, detail: null, draft: proposal }
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
      return { detail, review: null, library: null, message: 'Comparison saved. Overnight control has not been activated.' }
    }, { id: review.reviewId, action: 'confirm' })
  }

  stop() {
    const detail = this.state.detail
    if (!detail || detail.record.status === 'stopped' || this.state.uncertain)
      return Promise.resolve()
    return this.perform(async (access, signal) => ({ detail: validateExperimentDetail(readExperimentEnvelope(experimentDetailSchema, await this.transport.request(`${detail.record.plan.id}/stop`, 'POST', { expectedRevision: detail.record.revision }, signal), access.scope, this.now()), detail.record.plan.id),
      review: null, library: null, message: 'Stop request recorded. The saved status below confirms its result.' }), { id: detail.record.plan.id, action: 'stop' })
  }

  feedback(feedback: Omit<ExperimentFeedback, 'recordedAt'>) {
    const detail = this.state.detail
    if (!detail || this.state.uncertain)
      return Promise.resolve()
    return this.perform(async (access, signal) => ({ detail: validateExperimentDetail(readExperimentEnvelope(experimentDetailSchema, await this.transport.request(`${detail.record.plan.id}/feedback`, 'POST', { expectedRevision: detail.record.revision, feedback }, signal), access.scope, this.now()), detail.record.plan.id),
      message: 'Morning feedback saved. Ratings alone do not confirm the temperature you received.' }), { id: detail.record.plan.id, action: 'feedback' })
  }

  reconcile() {
    const pending = this.state.uncertain
    if (!pending)
      return Promise.resolve()
    return this.perform(async (access, signal) => ({ detail: await this.readDetail(pending.id, access, signal), review: null,
      message: 'Current saved record loaded. Review its status and feedback below; no write was repeated.' }), pending)
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
const sameAccess = (first: ExperimentBrowserAccess, second: ExperimentBrowserAccess) => first.revision === second.revision && sameExperimentScope(first.scope, second.scope)

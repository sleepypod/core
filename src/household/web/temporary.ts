import { z } from 'zod'
import type { HouseholdSession } from '../contract'
import { approveTemporaryReviewSchema, cancelTemporaryReviewSchema, temporaryProposalSchema, temporaryReviewSchema, type TemporaryReview } from '../temporary/contract'
import type { PersonalWebTransport } from './client'
import { identifier, PersonalWebError, samePersonSession } from './protocol'

const latestSchema = z.object({ version: z.literal(1), review: temporaryReviewSchema.nullable() }).strict()
const root = 'household/temporary-arrangement'
interface Pending { reviewId: string, kind: 'prepare' | 'approve' | 'cancel' }
export interface TemporaryWorkspaceState {
  available: boolean
  loaded: boolean
  fresh: boolean
  busy: boolean
  review: TemporaryReview | null
  pending: Pending | null
  error: string | null
  message: string | null
}

/** Private review requests are sent once; reconnect and recovery only read saved state. */
export class TemporaryArrangementWorkspace {
  private generation = 0
  private disposed = false
  private receivedAt = 0
  private receivedUptime = 0
  private listeners = new Set<() => void>()
  private state: TemporaryWorkspaceState
  private now: () => number
  private uptime: () => number
  constructor(readonly dependencies: {
    session: HouseholdSession
    client: PersonalWebTransport
    invalidated: () => void
    now?: () => number
    uptime?: () => number
  }) {
    this.now = dependencies.now ?? Date.now
    this.uptime = dependencies.uptime ?? (() => performance.now())
    this.state = { available: dependencies.session.capabilities.temporaryArrangementReview === true,
      loaded: false, fresh: false, busy: false, review: null, pending: null, error: null, message: null }
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(patch: Partial<TemporaryWorkspaceState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }

  private current(generation: number) {
    if (this.disposed || generation !== this.generation) throw new PersonalWebError('superseded', 'The private review changed.')
  }

  private async session(generation: number) {
    const session = samePersonSession(await this.dependencies.client.read('household/session'), this.dependencies.session)
    this.current(generation)
    if (session.householdRevision !== this.dependencies.session.householdRevision)
      throw new PersonalWebError('account_changed', 'The household changed. Reconnect before reviewing a plan.')
    if (!session.capabilities.temporaryArrangementReview) throw new PersonalWebError('disabled', 'Temporary reviews are unavailable.')
    return session
  }

  private checkReview(input: unknown, session: HouseholdSession) {
    const review = temporaryReviewSchema.parse(input)
    if (review.podId !== session.podId || review.householdId !== session.householdId || review.sleeperId !== session.selfSleeperId)
      throw new PersonalWebError('account_changed', 'This review belongs to another account.')
    if (review.createdAt > this.now() + 5000)
      throw new PersonalWebError('invalid', 'The review time could not be verified.')
    return review
  }

  private async read(generation: number, reviewId?: string) {
    const before = await this.session(generation)
    const response = await this.dependencies.client.read(reviewId ? `${root}/${reviewId}` : root)
    this.current(generation)
    const after = await this.session(generation)
    if (before.householdRevision !== after.householdRevision) throw new PersonalWebError('account_changed', 'The household changed.')
    const value = reviewId ? response : latestSchema.parse(response).review
    const review = value === null ? null : this.checkReview(value, after)
    if (reviewId && review?.reviewId !== reviewId) throw new PersonalWebError('invalid', 'The saved review does not match.')
    return review
  }

  private show(review: TemporaryReview | null) {
    this.receivedAt = this.now()
    this.receivedUptime = this.uptime()
    this.update({ review, loaded: true, fresh: true })
  }

  private fail(error: unknown, generation: number) {
    if (this.disposed || generation !== this.generation) return
    const code = error instanceof PersonalWebError ? error.code : null
    if (['authentication', 'account_changed', 'disabled'].includes(code ?? '')) {
      this.clear()
      this.update({ pending: null, available: code !== 'disabled' })
      if (code !== 'disabled') {
        this.dispose()
        this.dependencies.invalidated()
      }
      return
    }
    this.receivedUptime = NaN
    this.update({ fresh: false, message: null, error: this.state.pending
      ? 'Your review change is not confirmed. Check the saved result; nothing will be sent again.'
      : code === 'conflict'
        ? 'The plan changed or your request was rejected. Refresh and review the current settings.'
        : 'The current review is unavailable. Refresh before preparing or approving a plan.' })
  }

  tick() {
    const elapsed = this.uptime() - this.receivedUptime
    const fresh = this.state.loaded && elapsed >= 0 && elapsed < 30_000
      && this.now() >= this.receivedAt && this.now() - this.receivedAt < 30_000
      && Math.abs((this.now() - this.receivedAt) - elapsed) < 5000
    const review = this.state.review
    if (review && ['awaiting_approval', 'approved_for_separate_activation'].includes(review.state)
      && (this.now() < review.createdAt || this.now() >= review.reviewExpiresAt))
      this.update({ review: { ...review, state: 'expired', canApprove: false } })
    if (fresh !== this.state.fresh) this.update({ fresh })
  }

  clear() {
    this.generation++
    this.receivedUptime = NaN
    this.update({ review: null, loaded: false, fresh: false, busy: false, error: null, message: null })
  }

  async checkAccess() {
    if (this.disposed || !this.state.loaded || this.state.busy) return
    const generation = this.generation
    try {
      await this.session(generation)
    }
    catch (error) { this.fail(error, generation) }
  }

  async refresh() {
    if (this.disposed || !this.state.available || this.state.busy) return
    const generation = this.generation
    this.update({ busy: true, error: null, message: null })
    try {
      const pending = this.state.pending
      const review = await this.read(generation, pending?.reviewId)
      this.show(review)
      if (pending) this.resolve(pending, review)
    }
    catch (error) { this.fail(error, generation) }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }

  private resolve(pending: Pending, review: TemporaryReview | null) {
    const confirmed = review?.reviewId === pending.reviewId && (pending.kind === 'prepare'
      || (pending.kind === 'cancel' ? review.state === 'cancelled' : review.self.approved))
    if (!confirmed) {
      this.update({ error: 'The saved result is not confirmed yet. Check again; your request will not be repeated.' })
      return
    }
    this.update({ pending: null, error: null, message: pending.kind === 'cancel'
      ? 'Review cancelled. The bed is unchanged.'
      : pending.kind === 'approve' ? 'Your approval is saved. The bed has not switched.' : 'Your private review is saved. The bed is unchanged.' })
  }

  canChange() {
    this.tick()
    return this.state.available && this.state.fresh && !this.state.busy && !this.state.pending
  }

  private context() {
    return { version: 1 as const, requestId: identifier(), expectedSessionRevision: this.dependencies.session.sessionRevision,
      expectedAssignmentRevision: this.dependencies.session.assignmentRevision }
  }

  private async write(path: string, request: unknown, pending: Pending) {
    const generation = this.generation
    this.update({ busy: true, error: null, message: null })
    try {
      await this.session(generation)
      this.update({ pending })
      const response = await this.dependencies.client.read(path, 'POST', request)
      this.current(generation)
      const session = await this.session(generation)
      const review = this.checkReview(response, session)
      if (review.reviewId !== pending.reviewId) throw new PersonalWebError('invalid', 'The response belongs to another review.')
      this.show(review)
      this.resolve(pending, review)
    }
    catch (error) {
      // A definite rejected write can be reviewed again; a failed recovery read cannot establish that.
      if (generation === this.generation && error instanceof PersonalWebError && error.code === 'conflict') this.update({ pending: null })
      this.fail(error, generation)
    }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }

  async prepare(kind: 'guest' | 'side_swap', residentSide: 'left' | 'right', hours: number, acknowledged: boolean) {
    if (!this.canChange() || this.dependencies.session.role !== 'owner' || ![8, 12, 24, 48, 72].includes(hours)
      || (kind === 'guest' && !acknowledged) || (kind === 'side_swap' && this.dependencies.session.arrangement.mode !== 'assigned')) return
    if (this.state.review && !['cancelled', 'expired', 'consumed'].includes(this.state.review.state)) return
    const request = temporaryProposalSchema.parse({ ...this.context(), kind, endsAt: this.now() + hours * 3_600_000,
      ...(kind === 'guest' ? { residentSide, acknowledgeGuestRecordingWithheld: true } : {}) })
    await this.write(root, request, { kind: 'prepare', reviewId: request.requestId })
  }

  async approve(confirmed: boolean) {
    const review = this.state.review
    if (!confirmed || !this.canChange() || !review?.canApprove || this.now() >= review.reviewExpiresAt
      || this.now() < review.createdAt || review.assignmentRevision !== this.dependencies.session.assignmentRevision) return
    const request = approveTemporaryReviewSchema.parse({ ...this.context(), reviewId: review.reviewId,
      issuedAt: this.now(), expiresAt: this.now() + 30_000, confirmMySide: true, confirmMyRoutine: true,
      acknowledgeRecordingPolicy: true, acknowledgeSeparateActivation: true })
    await this.write(`${root}/approve`, request, { kind: 'approve', reviewId: review.reviewId })
  }

  async cancel() {
    const review = this.state.review
    if (!this.canChange() || !review?.canCancel) return
    const request = cancelTemporaryReviewSchema.parse({ ...this.context(), reviewId: review.reviewId })
    await this.write(`${root}/cancel`, request, { kind: 'cancel', reviewId: review.reviewId })
  }

  dispose() {
    if (this.disposed) return
    this.clear()
    this.update({ pending: null })
    this.disposed = true
    this.dependencies.client.dispose()
    this.listeners.clear()
  }
}

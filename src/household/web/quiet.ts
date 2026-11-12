import type { z } from 'zod'
import type { HouseholdSession } from '../contract'
import { quietReadResponseSchema, quietWriteResponseSchema, quietWriteSchema } from '../quietContract'
import type { PersonalWebTransport } from './client'
import { identifier, PersonalWebError, samePersonSession } from './protocol'

type QuietPage = z.infer<typeof quietReadResponseSchema>
type QuietRequest = z.infer<typeof quietWriteSchema>
export interface PersonalQuietState {
  available: boolean
  busy: boolean
  fresh: boolean
  page: QuietPage | null
  pending: QuietRequest | null
  error: string | null
  message: string | null
}
const scopeFor = (session: HouseholdSession): QuietPage['scope'] => ({ podId: session.podId, householdId: session.householdId,
  accountId: session.accountId, sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
  assignmentRevision: session.assignmentRevision, householdRevision: session.householdRevision })
const sameScope = (first: QuietPage['scope'], second: QuietPage['scope']) => Object.entries(first).every(([key, value]) => second[key as keyof typeof second] === value)

/** Quiet intent is sent once. Polling and uncertain-result recovery perform reads only. */
export class PersonalQuietWorkspace {
  private generation = 0
  private disposed = false
  private receivedUptime: number | null = null
  private listeners = new Set<() => void>()
  private state: PersonalQuietState
  private readonly now: () => number
  private readonly uptime: () => number
  constructor(private readonly dependencies: { session: HouseholdSession
    client: PersonalWebTransport
    invalidated: () => void
    now?: () => number
    uptime?: () => number }) {
    this.now = dependencies.now ?? Date.now
    this.uptime = dependencies.uptime ?? (() => performance.now())
    this.state = { available: dependencies.session.capabilities.householdQuiet === true, busy: false, fresh: false,
      page: null, pending: null, error: null, message: null }
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(patch: Partial<PersonalQuietState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }

  private current(generation: number) {
    if (this.disposed || generation !== this.generation) throw new PersonalWebError('superseded', 'The quiet view changed.')
  }

  clear() {
    this.generation += 1
    this.receivedUptime = null
    this.update({ page: null, fresh: false, busy: false, message: null, error: null })
  }

  tick() {
    const page = this.state.page, now = this.now(), elapsed = this.receivedUptime === null ? NaN : this.uptime() - this.receivedUptime
    const fresh = !!page && elapsed >= 0 && elapsed < 15_000 && now >= page.generatedAt - 5000 && now < page.generatedAt + 15_000
      && (page.mine.until === null || page.mine.until > now) && (page.shared.until === null || page.shared.until > now)
    if (fresh !== this.state.fresh) this.update({ fresh })
  }

  private async session(generation: number) {
    const session = samePersonSession(await this.dependencies.client.read('household/session'), this.dependencies.session)
    this.current(generation)
    if (!sameScope(scopeFor(session), scopeFor(this.dependencies.session)))
      throw new PersonalWebError('account_changed', 'The household context changed. Reconnect before editing quiet time.')
    this.update({ available: session.capabilities.householdQuiet === true })
    if (!session.capabilities.householdQuiet) throw new PersonalWebError('disabled', 'Quiet time is not enabled on this Pod.')
    return session
  }

  private async scoped<Result extends { generatedAt: number, scope: QuietPage['scope'] }>(path: string,
    parse: (input: unknown) => Result, generation: number, request?: QuietRequest) {
    const before = await this.session(generation)
    const response = parse(await this.dependencies.client.read(path, request ? 'POST' : 'GET', request))
    this.current(generation)
    const after = await this.session(generation)
    if (!sameScope(scopeFor(before), scopeFor(after)) || !sameScope(response.scope, scopeFor(after)))
      throw new PersonalWebError('account_changed', 'The quiet account changed.')
    if (response.generatedAt > this.now() + 5000 || response.generatedAt <= this.now() - 15_000)
      throw new PersonalWebError('stale', 'Quiet status is out of date.')
    return response
  }

  private async reading(generation: number) {
    return this.scoped('me/quiet', quietReadResponseSchema.parse, generation)
  }

  private show(page: QuietPage) {
    this.receivedUptime = this.uptime()
    this.update({ page, error: this.state.pending ? this.state.error : null })
    this.tick()
  }

  private fail(error: unknown, generation: number) {
    if (this.disposed || generation !== this.generation) return
    const code = error instanceof PersonalWebError ? error.code : null
    if (['authentication', 'account_changed', 'disabled'].includes(code ?? '')) {
      this.clear()
      this.update({ pending: null })
      if (code !== 'disabled') {
        this.dispose()
        this.dependencies.invalidated()
      }
      return
    }
    this.update({ fresh: false, error: this.state.pending
      ? 'Your change is not confirmed. Check its saved result; nothing will be sent again.'
      : code === 'conflict'
        ? 'Your quiet request changed on another device. Refresh before choosing again.'
        : 'Quiet status is unavailable. Refresh before changing your request.' })
  }

  async refresh() {
    if (this.disposed || !this.state.available || this.state.busy) return
    const generation = this.generation
    this.update({ busy: true })
    try {
      this.show(await this.reading(generation))
    }
    catch (error) { this.fail(error, generation) }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }

  canChange() {
    this.tick()
    return this.state.available && this.state.fresh && !this.state.busy && !this.state.pending
  }

  async change(minutes: number | null) {
    if (!this.canChange() || (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440))) return
    const generation = this.generation, revision = this.state.page?.mine.revision
    this.update({ busy: true, error: null, message: null })
    try {
      const page = await this.reading(generation)
      if (page.mine.revision !== revision) throw new PersonalWebError('conflict', 'Quiet changed on another device.')
      const now = this.now()
      const request = quietWriteSchema.parse({ requestId: identifier(), expectedSessionRevision: page.scope.sessionRevision,
        expectedAssignmentRevision: page.scope.assignmentRevision, expectedRevision: revision, issuedAt: now,
        expiresAt: now + 30_000, until: minutes === null ? null : now + minutes * 60_000 })
      this.update({ pending: request })
      const response = await this.scoped('me/quiet', quietWriteResponseSchema.parse, generation, request)
      await this.finish(response.receipt, request, generation)
    }
    catch (error) { this.fail(error, generation) }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }

  private async finish(receipt: z.infer<typeof quietWriteResponseSchema>['receipt'], request: QuietRequest, generation: number) {
    if (receipt && (receipt.requestId !== request.requestId || receipt.until !== request.until
      || receipt.savedAt < request.issuedAt - 5000 || receipt.savedAt > request.expiresAt))
      throw new PersonalWebError('invalid', 'This result does not match your request.')
    const page = await this.reading(generation)
    this.show(page)
    if (!receipt && page.generatedAt <= request.expiresAt) {
      this.update({ error: 'No saved result is available yet. Check again shortly. Nothing was resent.' })
      return
    }
    const message = !receipt
      ? 'The request expired without a saved result. Showing the current quiet status.'
      : page.mine.revision !== receipt.revision
        ? 'Your request was saved, then changed again. Showing the current quiet status.'
        : request.until === null ? 'Your quiet request ended. Any other person’s request stays in effect.' : 'Your quiet request is saved on the Pod.'
    this.update({ pending: null, message, error: null })
  }

  async reconcile() {
    if (this.disposed || this.state.busy || !this.state.pending) return
    const generation = this.generation, pending = this.state.pending
    this.update({ busy: true, error: null })
    try {
      const response = await this.scoped(`me/quiet/requests/${pending.requestId}`, quietWriteResponseSchema.parse, generation)
      await this.finish(response.receipt, pending, generation)
    }
    catch (error) { this.fail(error, generation) }
    finally { if (generation === this.generation) this.update({ busy: false }) }
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

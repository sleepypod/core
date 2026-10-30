import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/src/db/schema'
import { normalizeBedtimeDraft, routineDaySchema } from '@/src/lib/bedtimeRoutines'
import { readBedtimeRoutineState, replaceBedtimeRoutineBatch, type RoutineDelta } from '@/src/server/bedtimeRoutineTransaction'
import type { HouseholdCredential, HouseholdStore } from './store'
import { HouseholdError } from './store'
import type { HouseholdSession } from './contract'
import { householdIdSchema } from './contract'
import type { PersonalRuntimeAuthority, ResolvedPersonalBed } from './runtimeAuthority'
import { personalRoutinePublishSchema, personalRoutineReceiptSchema, personalRoutineReviewSchema,
  type PersonalRoutinePublish, type PersonalRoutineReceipt, type PersonalRoutineReview } from './routineContract'

type Side = 'left' | 'right'
interface PublicationRow { account_id: string, kind: string, request_hash: string, result: string }
interface StoredPublication { runId: string, receipt: PersonalRoutineReceipt }
interface Dependencies {
  database: Database.Database
  identities: HouseholdStore
  authority: PersonalRuntimeAuthority
  enabled: () => boolean
  withZones: <Result>(zones: Side[], operation: () => Promise<Result>) => Promise<Result>
  refreshScheduler: (delta: RoutineDelta) => Promise<boolean>
  now?: () => number
  monotonicNow?: () => number
  runId?: string
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const conflict = (message: string) => new HouseholdError('conflict', 409, message)

/** Draft saves remain inert. Only a fresh, explicit review can replace live routines. */
export class PersonalRoutineService {
  private readonly active = new Set<string>()
  private readonly now: () => number
  private readonly monotonicNow: () => number
  private readonly runId: string
  private readonly store: ReturnType<typeof drizzle<typeof schema>>

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? Date.now
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now())
    this.runId = dependencies.runId ?? randomUUID()
    this.store = drizzle(dependencies.database, { schema })
  }

  private current(credential: HouseholdCredential): ResolvedPersonalBed & { routineSide: Side } {
    const resolved = this.dependencies.authority.resolve(credential)
    if (resolved.availability !== 'ready' || !resolved.routineSide)
      throw new HouseholdError('not_ready', 409, 'Your current bed assignment is unavailable. No routine was changed.')
    return { ...resolved, routineSide: resolved.routineSide }
  }

  private reviewFor(credential: HouseholdCredential, resolved: ResolvedPersonalBed & { routineSide: Side }): PersonalRoutineReview {
    const state = readBedtimeRoutineState(this.store, resolved.routineSide)
    const liveWeek = state.records.map(record => record.snapshot).sort((first, second) => routineDaySchema.options.indexOf(first.dayOfWeek) - routineDaySchema.options.indexOf(second.dayOfWeek))
    const drafts = this.dependencies.identities.routines(credential)
    const draftWeek = drafts.routines.map(entry => ({ ...entry, draft: normalizeBedtimeDraft(entry.draft) }))
      .sort((first, second) => routineDaySchema.options.indexOf(first.dayOfWeek) - routineDaySchema.options.indexOf(second.dayOfWeek))
    const settings = this.dependencies.database.prepare('SELECT timezone FROM device_settings ORDER BY id LIMIT 1').get() as { timezone: string } | undefined
    if (!settings?.timezone) throw new HouseholdError('not_ready', 409, 'Set the Pod time zone before publishing routines.')
    try {
      new Intl.DateTimeFormat('en', { timeZone: settings.timezone }).format(0)
    }
    catch { throw new HouseholdError('not_ready', 409, 'The Pod time zone is invalid. No routine was changed.') }
    const changes: PersonalRoutineReview['changes'] = routineDaySchema.options.flatMap((dayOfWeek) => {
      const before = liveWeek.find(entry => entry.dayOfWeek === dayOfWeek)
      const after = draftWeek.find(entry => entry.dayOfWeek === dayOfWeek)
      if (digest(before?.draft ?? null) === digest(after?.draft ?? null)) return []
      return [{ dayOfWeek, operation: before ? after ? 'replace' as const : 'remove' as const : 'create' as const }]
    })
    const liveRevision = digest({ canCreate: state.canCreate, liveWeek })
    const reviewRevision = digest({ scope: resolved.scope, sourceSide: resolved.routineSide, timeZone: settings.timezone, liveRevision, draftRevision: drafts.revision, draftWeek })
    const reason = !this.dependencies.enabled()
      ? 'publication_disabled'
      : !state.canCreate
          ? 'calendar_migration_required'
          : drafts.revision === 1 ? 'draft_not_prepared' : !changes.length ? 'unchanged' : 'ready'
    return personalRoutineReviewSchema.parse({ version: 1, scope: resolved.scope, sourceSide: resolved.routineSide,
      temperatureZones: resolved.zones, timeZone: settings.timezone, draftRevision: drafts.revision,
      liveRevision, reviewRevision, liveWeek, draftWeek, changes, canPublish: reason === 'ready', reason,
      effect: 'saved_routines_can_affect_the_current_target' })
  }

  review(credential: HouseholdCredential, assertRequestCurrent: () => void) {
    assertRequestCurrent()
    return this.reviewFor(credential, this.current(credential))
  }

  present(session: HouseholdSession): HouseholdSession {
    return { ...session, capabilities: { ...session.capabilities,
      personalRoutinePublication: this.dependencies.enabled() && this.dependencies.authority.resolveSession(session).availability === 'ready' } }
  }

  private row(requestId: string) {
    return this.dependencies.database.prepare('SELECT account_id, kind, request_hash, result FROM household_mutation_receipts WHERE request_id = ?').get(requestId) as PublicationRow | undefined
  }

  private receipt(row: PublicationRow, accountId: string) {
    if (row.account_id !== accountId || row.kind !== 'routine_publication') return null
    const stored = JSON.parse(row.result) as StoredPublication
    const receipt = personalRoutineReceiptSchema.parse(stored.receipt)
    return receipt.scheduler === 'pending' && (stored.runId !== this.runId || !this.active.has(receipt.requestId))
      ? { ...receipt, scheduler: 'unconfirmed' as const }
      : receipt
  }

  get(credential: HouseholdCredential, requestId: string, assertRequestCurrent: () => void) {
    householdIdSchema.parse(requestId)
    assertRequestCurrent()
    const session = this.dependencies.identities.session(credential)
    const row = this.row(requestId)
    return row ? this.receipt(row, session.accountId) : null
  }

  private prior(input: PersonalRoutinePublish, accountId: string) {
    const row = this.row(input.requestId)
    if (!row) return null
    if (row.account_id !== accountId || row.kind !== 'routine_publication' || row.request_hash !== digest(input))
      throw conflict('This request identifier is already used. Review your saved result before making another change.')
    return this.receipt(row, accountId)
  }

  private durable<Result>(operation: () => Result): Result {
    const database = this.dependencies.database
    if (database.inTransaction) throw new Error('Routine publication needs an independent durable transaction')
    const previous = database.pragma('synchronous', { simple: true }) as number
    database.pragma('synchronous = FULL')
    try {
      return database.transaction(operation).immediate()
    }
    finally { database.pragma(`synchronous = ${previous}`) }
  }

  private assertCurrent(credential: HouseholdCredential, input: PersonalRoutinePublish, assertRequestCurrent: () => void, monotonicDeadline: number) {
    assertRequestCurrent()
    if (input.issuedAt > this.now() || input.expiresAt <= this.now() || this.monotonicNow() >= monotonicDeadline)
      throw conflict('This publication expired. Review the current plan again.')
    const current = this.current(credential)
    if (digest(current.scope) !== digest(input.scope)) throw conflict('Your account or assignment changed. Review your own current routine before publishing.')
    if (!this.dependencies.enabled()) throw new HouseholdError('not_ready', 409, 'Personal routine publication is not enabled.')
    return current
  }

  async publish(credential: HouseholdCredential, input: unknown, assertRequestCurrent: () => void): Promise<PersonalRoutineReceipt> {
    const parsed = personalRoutinePublishSchema.parse(input)
    assertRequestCurrent()
    const session = this.dependencies.identities.session(credential)
    const prior = this.prior(parsed, session.accountId)
    if (prior) return prior
    const monotonicDeadline = this.monotonicNow() + Math.max(0, parsed.expiresAt - this.now())
    const initial = this.assertCurrent(credential, parsed, assertRequestCurrent, monotonicDeadline)
    // Acquire all affected thermal zones in a consistent order. A solo routine
    // governs the follower as well as its one scheduled vibration source.
    const result = await this.dependencies.withZones([...initial.zones].sort(), async () => {
      this.assertCurrent(credential, parsed, assertRequestCurrent, monotonicDeadline)
      return this.durable(() => {
        const concurrent = this.prior(parsed, session.accountId)
        if (concurrent) return { receipt: concurrent, delta: null }
        const current = this.assertCurrent(credential, parsed, assertRequestCurrent, monotonicDeadline)
        const review = this.reviewFor(credential, current)
        if (!review.canPublish || review.reviewRevision !== parsed.reviewRevision)
          throw conflict('The reviewed draft or live routine changed, or no changes are ready. Refresh the comparison before publishing.')
        const delta = replaceBedtimeRoutineBatch(this.dependencies.database, [{ side: current.routineSide,
          changes: review.changes.map(change => ({ dayOfWeek: change.dayOfWeek,
            expectedRevision: review.liveWeek.find(entry => entry.dayOfWeek === change.dayOfWeek)?.revision ?? null,
            replacement: review.draftWeek.find(entry => entry.dayOfWeek === change.dayOfWeek)?.draft ?? null })) }])
        const receipt = personalRoutineReceiptSchema.parse({ version: 1, requestId: parsed.requestId, scope: current.scope,
          sourceSide: current.routineSide, publishedAt: this.now(), draftRevision: review.draftRevision, reviewRevision: review.reviewRevision,
          state: 'saved', scheduler: 'pending', publishedWeek: delta.snapshots[0].routines, changes: review.changes,
          physicalVerification: 'unverified', replayAllowed: false })
        this.dependencies.database.prepare('INSERT INTO household_mutation_receipts (request_id, account_id, kind, request_hash, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(parsed.requestId, session.accountId, 'routine_publication', digest(parsed), JSON.stringify({ runId: this.runId, receipt }), this.now())
        return { receipt, delta }
      })
    })
    if (!result.delta) {
      assertRequestCurrent()
      this.dependencies.identities.session(credential)
      return result.receipt
    }
    this.active.add(parsed.requestId)
    try {
      let refreshed = false
      try {
        refreshed = await this.dependencies.refreshScheduler(result.delta)
      }
      catch { /* The saved week remains committed; a second publish is not recovery. */ }
      const receipt: PersonalRoutineReceipt = { ...result.receipt, scheduler: refreshed ? 'refreshed' : 'unconfirmed' }
      this.durable(() => {
        const updated = this.dependencies.database.prepare('UPDATE household_mutation_receipts SET result = ? WHERE request_id = ? AND account_id = ? AND request_hash = ?')
          .run(JSON.stringify({ runId: this.runId, receipt }), parsed.requestId, session.accountId, digest(parsed))
        if (updated.changes !== 1) throw new Error('Publication result could not be saved')
      })
      assertRequestCurrent()
      this.dependencies.identities.session(credential)
      return receipt
    }
    finally { this.active.delete(parsed.requestId) }
  }
}

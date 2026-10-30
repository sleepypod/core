import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { z } from 'zod'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/src/db/schema'
import { normalizeBedtimeDraft, routineDaySchema, validateBedtimeWeek } from '@/src/lib/bedtimeRoutines'
import { readBedtimeRoutineState } from '@/src/server/bedtimeRoutineTransaction'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import { householdIdSchema, personalWeekSchema, personPreferencesSchema, type HouseholdSession } from './contract'
import { approveArrangementSchema, arrangementReviewSchema, cancelArrangementSchema, proposeArrangementSchema, type ArrangementReview } from './arrangementContract'

type Side = 'left' | 'right'
type Week = z.infer<typeof personalWeekSchema>
interface AccountRow {
  id: string
  sleeper_id: string
  display_name: string
  role: 'owner' | 'member'
  assigned_side: Side | null
  session_revision: number
  preferences: string
  preferences_revision: number
  routines: string
  routines_revision: number
}
interface Participant {
  accountId: string
  sleeperId: string
  displayName: string
  role: 'owner' | 'member'
  sessionRevision: number
  preferencesRevision: number
  draftRevision: number
  side: Side
  preferences: z.infer<typeof personPreferencesSchema>
  week: Week
}
interface Snapshot {
  householdId: string
  podId: string
  householdRevision: number
  assignmentRevision: number
  ownerSide: Side
  sourceSide: Side
  timeZone: string
  participants: Participant[]
  liveRevision: string
  configurationRevision: string
}
interface ReviewRow {
  id: string
  household_id: string
  creator_account_id: string
  request_hash: string
  payload: string
  created_at: number
  expires_at: number
  state: 'open' | 'cancelled' | 'consumed'
}
interface ApprovalRow { request_id: string, account_id: string, device_id: string, request_hash: string, revoked_at: number | null }
interface Dependencies {
  database: Database.Database
  identities: HouseholdStore
  enabled: () => boolean
  now?: () => number
}
const REVIEW_LIFETIME_MS = 60 * 60 * 1000
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
const conflict = (message: string) => new HouseholdError('conflict', 409, message)
const unavailable = () => new HouseholdError('not_ready', 409, 'This shared arrangement review is unavailable. Prepare a fresh review; the bed has not changed.')
const sortedWeek = (week: Week): Week => week.map(entry => ({ ...entry, draft: normalizeBedtimeDraft(entry.draft) }))
  .sort((first, second) => routineDaySchema.options.indexOf(first.dayOfWeek) - routineDaySchema.options.indexOf(second.dayOfWeek))

/** A review and two independent approvals, never an activation coordinator.
 * Public projections include only the caller's week. Nothing here calls hardware,
 * publishes schedules, attributes history or changes the current bed arrangement. */
export class ArrangementReviewService {
  private readonly now: () => number
  private readonly store: ReturnType<typeof drizzle<typeof schema>>

  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? Date.now
    this.store = drizzle(dependencies.database, { schema })
  }

  present(session: HouseholdSession): HouseholdSession {
    return { ...session, capabilities: { ...session.capabilities, arrangementReview: this.dependencies.enabled(), activateArrangement: false } }
  }

  private durable<Result>(operation: () => Result): Result {
    const database = this.dependencies.database
    if (database.inTransaction) throw new Error('Arrangement review requires an independent durable transaction')
    const previous = database.pragma('synchronous', { simple: true }) as number
    database.pragma('synchronous = FULL')
    try {
      return database.transaction(operation).immediate()
    }
    finally { database.pragma(`synchronous = ${previous}`) }
  }

  private context(credential: HouseholdCredential, input: { expectedSessionRevision: number, expectedAssignmentRevision: number }) {
    const session = this.dependencies.identities.session(credential)
    if (input.expectedSessionRevision !== session.sessionRevision || input.expectedAssignmentRevision !== session.assignmentRevision)
      throw conflict('Your account or assignment changed. Reload before reviewing the shared bed.')
    return session
  }

  private snapshot(session: HouseholdSession, ownerSide: Side): Snapshot {
    const database = this.dependencies.database
    const household = database.prepare('SELECT mode, source_side FROM households WHERE id = ?').get(session.householdId) as { mode: string, source_side: Side } | undefined
    const physical = database.prepare('SELECT bed_mode, unused_zone_mode, timezone FROM device_settings ORDER BY id LIMIT 1').get() as { bed_mode: string, unused_zone_mode: string, timezone: string } | undefined
    const accounts = database.prepare(`SELECT account.id, account.sleeper_id, account.display_name, account.role, account.assigned_side,
      account.session_revision, settings.preferences, settings.preferences_revision, settings.routines, settings.routines_revision
      FROM household_accounts account JOIN household_personal_settings settings ON settings.account_id = account.id
      WHERE account.household_id = ? AND account.state = 'active' ORDER BY account.id`).all(session.householdId) as AccountRow[]
    if (!household || household.mode !== 'solo-anywhere' || !['left', 'right'].includes(household.source_side)
      || !physical || physical.bed_mode !== `solo-${household.source_side}` || physical.unused_zone_mode !== 'follow'
      || accounts.length !== 2 || accounts.filter(account => account.role === 'owner').length !== 1
      || accounts.filter(account => account.role === 'member').length !== 1 || accounts.some(account => account.assigned_side !== null)
      || !accounts.some(account => account.id === session.accountId && account.sleeper_id === session.selfSleeperId)) throw unavailable()
    if (!physical.timezone) throw unavailable()
    try {
      new Intl.DateTimeFormat('en', { timeZone: physical.timezone }).format(0)
    }
    catch { throw unavailable() }
    if (accounts.some(account => account.preferences_revision === 1 || (account.role === 'member' && account.routines_revision === 1)))
      throw new HouseholdError('not_ready', 409, 'Both people must save their own preferences, and the joining person must prepare a private routine draft first.')
    const live = (['left', 'right'] as const).map((side) => {
      const current = readBedtimeRoutineState(this.store, side)
      if (!current.canCreate) throw new HouseholdError('not_ready', 409, 'Review existing calendar schedules before preparing a side change.')
      return { side, week: current.records.map(record => record.snapshot).sort((first, second) => first.dayOfWeek.localeCompare(second.dayOfWeek)) }
    })
    const sourceWeek = live.find(entry => entry.side === household.source_side)?.week
    if (!sourceWeek) throw unavailable()
    const participants = accounts.map((account): Participant => {
      const side = account.role === 'owner' ? ownerSide : ownerSide === 'left' ? 'right' : 'left'
      const week = sortedWeek(account.role === 'owner'
        ? sourceWeek.map(({ dayOfWeek, draft }) => ({ dayOfWeek, draft }))
        : personalWeekSchema.parse(JSON.parse(account.routines)))
      validateBedtimeWeek(side, week)
      return { accountId: account.id, sleeperId: account.sleeper_id, displayName: account.display_name, role: account.role,
        sessionRevision: account.session_revision, preferencesRevision: account.preferences_revision, draftRevision: account.routines_revision,
        side, preferences: personPreferencesSchema.parse(JSON.parse(account.preferences)), week }
    })
    return { householdId: session.householdId, podId: session.podId, householdRevision: session.householdRevision,
      assignmentRevision: session.assignmentRevision, ownerSide, sourceSide: household.source_side, timeZone: physical.timezone,
      participants, liveRevision: digest(live), configurationRevision: digest({ physical,
        sides: database.prepare('SELECT * FROM side_settings ORDER BY side').all() }) }
  }

  private row(session: HouseholdSession, reviewId: string): ReviewRow {
    householdIdSchema.parse(reviewId)
    const row = this.dependencies.database.prepare('SELECT * FROM household_arrangement_reviews WHERE id = ? AND household_id = ?')
      .get(reviewId, session.householdId) as ReviewRow | undefined
    if (!row) throw unavailable()
    return row
  }

  private approvals(reviewId: string): ApprovalRow[] {
    return this.dependencies.database.prepare(`SELECT approval.request_id, approval.account_id, approval.device_id, approval.request_hash,
      device.revoked_at FROM household_arrangement_approvals approval
      JOIN household_devices device ON device.id = approval.device_id AND device.account_id = approval.account_id
      WHERE approval.review_id = ?`).all(reviewId) as ApprovalRow[]
  }

  private project(session: HouseholdSession, row: ReviewRow): ArrangementReview {
    const saved = JSON.parse(row.payload) as Snapshot
    const self = saved.participants.find(person => person.accountId === session.accountId && person.sleeperId === session.selfSleeperId)
    const partner = saved.participants.find(person => person.accountId !== session.accountId)
    if (!self || !partner || saved.householdId !== session.householdId || saved.podId !== session.podId) throw unavailable()
    let current = false
    try {
      current = digest(this.snapshot(session, saved.ownerSide)) === digest(saved)
    }
    catch { /* A changed or unavailable source invalidates approval, never activates stored defaults. */ }
    const approvals = this.approvals(row.id)
    const revoked = approvals.some(approval => approval.revoked_at !== null)
    const approved = (accountId: string) => approvals.some(approval => approval.account_id === accountId && approval.revoked_at === null)
    const state: ArrangementReview['state'] = row.state !== 'open'
      ? row.state
      : row.expires_at <= this.now() || row.created_at > this.now()
        ? 'expired'
        : !current || revoked
            ? 'stale'
            : approved(self.accountId) && approved(partner.accountId) ? 'approved_for_separate_activation' : 'awaiting_approval'
    return arrangementReviewSchema.parse({ version: 1, reviewId: row.id, householdId: saved.householdId, podId: saved.podId,
      sleeperId: self.sleeperId, assignmentRevision: saved.assignmentRevision,
      createdAt: row.created_at, expiresAt: row.expires_at, timeZone: saved.timeZone, state,
      self: { displayName: self.displayName, assignmentAtReview: self.role === 'owner' ? 'solo' : 'unassigned',
        proposedSide: self.side, routineSource: self.role === 'owner' ? 'preserved_operating_week' : 'own_private_draft',
        week: self.week, preferences: self.preferences, approved: approved(self.accountId) },
      partner: { displayName: partner.displayName, proposedSide: partner.side, approved: approved(partner.accountId) },
      canApprove: this.dependencies.enabled() && state === 'awaiting_approval' && !approved(self.accountId),
      canActivate: false, effect: 'review_only_bed_unchanged' })
  }

  latest(credential: HouseholdCredential): ArrangementReview | null {
    return this.dependencies.database.transaction(() => {
      const session = this.dependencies.identities.session(credential)
      const row = this.dependencies.database.prepare('SELECT * FROM household_arrangement_reviews WHERE household_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
        .get(session.householdId) as ReviewRow | undefined
      return row ? this.project(session, row) : null
    })()
  }

  get(credential: HouseholdCredential, reviewId: string): ArrangementReview {
    return this.dependencies.database.transaction(() => {
      const session = this.dependencies.identities.session(credential)
      return this.project(session, this.row(session, reviewId))
    })()
  }

  propose(credential: HouseholdCredential, input: unknown): ArrangementReview {
    const parsed = proposeArrangementSchema.parse(input)
    return this.durable(() => {
      const session = this.context(credential, parsed)
      if (session.role !== 'owner') throw new HouseholdError('forbidden', 403, 'The current owner proposes the shared side arrangement.')
      const prior = this.dependencies.database.prepare('SELECT * FROM household_arrangement_reviews WHERE id = ?').get(parsed.requestId) as ReviewRow | undefined
      if (prior) {
        if (prior.creator_account_id !== session.accountId || prior.request_hash !== digest(parsed)) throw conflict('This review identifier already describes a different proposal.')
        return this.project(session, prior)
      }
      if (!this.dependencies.enabled()) throw unavailable()
      if (this.dependencies.database.prepare('SELECT id FROM household_arrangement_reviews WHERE household_id = ? AND state = \'open\' AND expires_at > ?').get(session.householdId, this.now()))
        throw conflict('Cancel the existing shared review before creating another.')
      const snapshot = this.snapshot(session, parsed.ownerSide)
      this.dependencies.database.prepare(`INSERT INTO household_arrangement_reviews
        (id, household_id, creator_account_id, request_hash, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(parsed.requestId, session.householdId, session.accountId, digest(parsed), JSON.stringify(snapshot), this.now(), this.now() + REVIEW_LIFETIME_MS)
      return this.project(session, this.row(session, parsed.requestId))
    })
  }

  approve(credential: HouseholdCredential, input: unknown): ArrangementReview {
    const parsed = approveArrangementSchema.parse(input)
    return this.durable(() => {
      const session = this.context(credential, parsed)
      const row = this.row(session, parsed.reviewId)
      const current = this.project(session, row)
      const prior = this.dependencies.database.prepare('SELECT account_id, request_hash FROM household_arrangement_approvals WHERE request_id = ?')
        .get(parsed.requestId) as { account_id: string, request_hash: string } | undefined
      if (prior) {
        if (prior.account_id !== session.accountId || prior.request_hash !== digest(parsed)) throw conflict('This approval identifier already describes a different review.')
        return current
      }
      if (!current.canApprove || parsed.issuedAt > this.now() || parsed.expiresAt <= this.now()) throw conflict('This approval is unavailable or expired. Reload the current review.')
      const deviceId = typeof credential === 'string' ? this.dependencies.identities.deviceIdentity(credential) : credential.deviceId
      this.dependencies.database.prepare(`INSERT INTO household_arrangement_approvals
        (request_id, review_id, account_id, device_id, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(parsed.requestId, row.id, session.accountId, deviceId, digest(parsed), this.now())
      return this.project(session, row)
    })
  }

  cancel(credential: HouseholdCredential, input: unknown): ArrangementReview {
    const parsed = cancelArrangementSchema.parse(input)
    return this.durable(() => {
      const session = this.context(credential, parsed)
      const row = this.row(session, parsed.reviewId)
      this.project(session, row)
      if (row.state === 'consumed') throw conflict('This review was already consumed. Check the separate activation result.')
      this.dependencies.database.prepare('UPDATE household_arrangement_reviews SET state = \'cancelled\' WHERE id = ?').run(row.id)
      return this.project(session, this.row(session, row.id))
    })
  }
}

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { householdIdSchema, type HouseholdSession } from '../contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from '../store'
import { prepareTemporaryArrangement, projectTemporaryArrangement, temporaryPlanCurrent,
  temporaryProposalSchema, type TemporaryArrangementPlan } from './plan'
import { approveTemporaryReviewSchema, cancelTemporaryReviewSchema, temporaryReviewSchema } from './contract'
export { approveTemporaryReviewSchema, cancelTemporaryReviewSchema } from './contract'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unavailable = () => new HouseholdError('not_ready', 409, 'This temporary review needs to be prepared again. The bed has not changed.')
const conflict = () => new HouseholdError('conflict', 409, 'The account, request or arrangement changed. Reload the current review.')
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
interface ApprovalRow {
  account_id: string
  device_id: string
  source_digest: string
  revoked_at: number | null
  current_device_id: string | null
}
interface Dependencies {
  database: Database.Database
  identities: HouseholdStore
  // Production source must be collected from current storage inside the same transaction.
  readSource: (householdId: string) => unknown
  enabled: () => boolean
  now?: () => number
}

/** Persist private reviews and separate account approvals; there is deliberately no actuator dependency. */
export class TemporaryArrangementReviews {
  private readonly now: () => number
  constructor(private readonly dependencies: Dependencies) { this.now = dependencies.now ?? Date.now }

  present(session: HouseholdSession): HouseholdSession {
    return { ...session, capabilities: { ...session.capabilities,
      temporaryArrangementReview: this.dependencies.enabled(), activateTemporaryArrangement: false } }
  }

  private durable<Result>(operation: () => Result): Result {
    const database = this.dependencies.database
    if (database.inTransaction) throw new Error('Temporary review writes require an independent durable transaction')
    const previous = database.pragma('synchronous', { simple: true }) as number
    database.pragma('synchronous = FULL')
    try {
      return database.transaction(operation).immediate()
    }
    finally { database.pragma(`synchronous = ${previous}`) }
  }

  private context(credential: HouseholdCredential, input: { expectedSessionRevision: number, expectedAssignmentRevision: number }) {
    const session = this.dependencies.identities.session(credential)
    if (session.sessionRevision !== input.expectedSessionRevision || session.assignmentRevision !== input.expectedAssignmentRevision) throw conflict()
    return session
  }

  private row(reviewId: string, householdId: string) {
    householdIdSchema.parse(reviewId)
    const row = this.dependencies.database.prepare('SELECT * FROM household_temporary_reviews WHERE id = ? AND household_id = ?')
      .get(reviewId, householdId) as ReviewRow | undefined
    if (!row) throw unavailable()
    return row
  }

  private plan(row: ReviewRow): TemporaryArrangementPlan {
    if (Buffer.byteLength(row.payload) > 512 * 1024) throw unavailable()
    const plan = JSON.parse(row.payload) as TemporaryArrangementPlan
    if (!plan || plan.reviewId !== row.id || plan.source?.householdId !== row.household_id || plan.ownerAccountId !== row.creator_account_id
      || plan.createdAt !== row.created_at || plan.expiresAt !== row.expires_at || hash(plan.request) !== row.request_hash) throw unavailable()
    // The projection/current check rebuilds every derived field before it is used.
    return plan
  }

  private approvals(row: ReviewRow): ApprovalRow[] {
    return this.dependencies.database.prepare(`SELECT approval.account_id, approval.device_id, approval.source_digest,
      device.revoked_at, device.id AS current_device_id FROM household_temporary_approvals approval
      LEFT JOIN household_devices device ON device.id = approval.device_id AND device.account_id = approval.account_id
      WHERE approval.review_id = ?`).all(row.id) as ApprovalRow[]
  }

  private project(credential: HouseholdCredential, row: ReviewRow) {
    const session = this.dependencies.identities.session(credential)
    if (session.householdId !== row.household_id) throw unavailable()
    const plan = this.plan(row)
    const self = plan.participants.find(value => value.accountId === session.accountId)
    if (!self || self.sleeperId !== session.selfSleeperId || self.sessionRevision !== session.sessionRevision
      || plan.source.podId !== session.podId) throw new HouseholdError('forbidden', 403, 'This account is not a participant in the current review.')
    let source: unknown = plan.source
    let sourceAvailable = false
    try {
      source = this.dependencies.readSource(session.householdId)
      sourceAvailable = true
    }
    catch { /* A missing current source withdraws approval; it must not prevent cancellation of an inert review. */ }
    const projected = projectTemporaryArrangement(plan, session.accountId, source, this.now())
    const approvals = this.approvals(row)
    const invalidApproval = approvals.some(value => value.current_device_id === null || value.revoked_at !== null || value.source_digest !== plan.sourceDigest
      || !plan.participants.some(person => person.accountId === value.account_id))
    const approved = (accountId: string) => approvals.some(value => value.account_id === accountId
      && value.current_device_id !== null && value.revoked_at === null && value.source_digest === plan.sourceDigest)
    const state = row.state !== 'open'
      ? row.state
      : this.now() < row.created_at || this.now() >= row.expires_at
        ? 'expired' as const
        : !sourceAvailable || invalidApproval || !temporaryPlanCurrent(plan, source, this.now())
            ? 'stale' as const
            : plan.participants.every(value => approved(value.accountId)) ? 'approved_for_separate_activation' as const : 'awaiting_approval' as const
    const others = plan.participants.filter(value => value.accountId !== session.accountId)
    return temporaryReviewSchema.parse({ ...projected, state, self: { ...projected.self, approved: approved(session.accountId) },
      others: projected.others.map((value, index) => ({ ...value, approved: approved(others[index].accountId) })),
      canApprove: this.dependencies.enabled() && state === 'awaiting_approval' && !approved(session.accountId),
      canCancel: row.state === 'open' })
  }

  latest(credential: HouseholdCredential) {
    return this.dependencies.database.transaction(() => {
      const session = this.dependencies.identities.session(credential)
      const row = this.dependencies.database.prepare(`SELECT * FROM household_temporary_reviews
        WHERE household_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(session.householdId) as ReviewRow | undefined
      if (!row || !this.plan(row).participants.some(value => value.accountId === session.accountId)) return null
      return this.project(credential, row)
    })()
  }

  get(credential: HouseholdCredential, reviewId: string) {
    return this.dependencies.database.transaction(() => {
      const session = this.dependencies.identities.session(credential)
      return this.project(credential, this.row(reviewId, session.householdId))
    })()
  }

  propose(credential: HouseholdCredential, input: unknown) {
    const request = temporaryProposalSchema.parse(input)
    return this.durable(() => {
      const session = this.context(credential, request)
      if (session.role !== 'owner') throw new HouseholdError('forbidden', 403, 'Only the current owner proposes the temporary arrangement.')
      const prior = this.dependencies.database.prepare('SELECT * FROM household_temporary_reviews WHERE id = ?').get(request.requestId) as ReviewRow | undefined
      if (prior) {
        if (prior.creator_account_id !== session.accountId || prior.request_hash !== hash(request)) throw conflict()
        return this.project(credential, prior)
      }
      if (!this.dependencies.enabled()) throw unavailable()
      if (this.dependencies.database.prepare('SELECT id FROM household_temporary_reviews WHERE household_id = ? AND state = \'open\' AND expires_at > ?')
        .get(session.householdId, this.now())) throw new HouseholdError('conflict', 409, 'Cancel the existing temporary review before creating another.')
      const plan = prepareTemporaryArrangement(this.dependencies.readSource(session.householdId), session.accountId, request, this.now())
      if (plan.source.householdId !== session.householdId || plan.source.podId !== session.podId) throw unavailable()
      const payload = JSON.stringify(plan)
      if (Buffer.byteLength(payload) > 512 * 1024) throw unavailable()
      this.dependencies.database.prepare(`INSERT INTO household_temporary_reviews
        (id, household_id, creator_account_id, request_hash, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(plan.reviewId, session.householdId, session.accountId, hash(request), payload, plan.createdAt, plan.expiresAt)
      return this.project(credential, this.row(plan.reviewId, session.householdId))
    })
  }

  approve(credential: HouseholdCredential, input: unknown) {
    const request = approveTemporaryReviewSchema.parse(input)
    return this.durable(() => {
      const session = this.context(credential, request)
      const row = this.row(request.reviewId, session.householdId)
      const current = this.project(credential, row)
      const deviceId = typeof credential === 'string' ? this.dependencies.identities.deviceIdentity(credential) : credential.deviceId
      const prior = this.dependencies.database.prepare('SELECT account_id, device_id, request_hash FROM household_temporary_approvals WHERE request_id = ?')
        .get(request.requestId) as { account_id: string, device_id: string, request_hash: string } | undefined
      if (prior) {
        if (prior.account_id !== session.accountId || prior.device_id !== deviceId || prior.request_hash !== hash(request)) throw conflict()
        return current
      }
      if (!current.canApprove || request.issuedAt > this.now() || request.expiresAt <= this.now()) throw conflict()
      this.dependencies.database.prepare(`INSERT INTO household_temporary_approvals
        (request_id, review_id, account_id, device_id, request_hash, source_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(request.requestId, row.id, session.accountId, deviceId, hash(request), this.plan(row).sourceDigest, this.now())
      return this.project(credential, row)
    })
  }

  cancel(credential: HouseholdCredential, input: unknown) {
    const request = cancelTemporaryReviewSchema.parse(input)
    return this.durable(() => {
      const session = this.context(credential, request)
      const row = this.row(request.reviewId, session.householdId)
      this.project(credential, row)
      if (row.state === 'consumed') throw conflict()
      this.dependencies.database.prepare('UPDATE household_temporary_reviews SET state = \'cancelled\' WHERE id = ?').run(row.id)
      return this.project(credential, this.row(row.id, session.householdId))
    })
  }

  /** Internal future coordinator boundary: the caller must hold the whole configuration transaction. */
  approvedForCommit(credential: HouseholdCredential, input: { reviewId: string, expectedSessionRevision: number, expectedAssignmentRevision: number }) {
    if (!this.dependencies.database.inTransaction) throw new Error('Read approval inside its configuration transaction')
    const session = this.context(credential, input)
    const row = this.row(input.reviewId, session.householdId)
    if (!this.dependencies.enabled() || session.role !== 'owner'
      || this.project(credential, row).state !== 'approved_for_separate_activation') throw unavailable()
    return this.plan(row)
  }

  consumeForCommit(credential: HouseholdCredential, input: { reviewId: string, expectedSessionRevision: number, expectedAssignmentRevision: number }) {
    this.approvedForCommit(credential, input)
    const changed = this.dependencies.database.prepare('UPDATE household_temporary_reviews SET state = \'consumed\' WHERE id = ? AND state = \'open\'').run(input.reviewId)
    if (changed.changes !== 1) throw unavailable()
  }
}

import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { householdIdSchema, type HouseholdSession } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import { QUIET_MAX_DURATION_MS, QUIET_OBSERVATION_LIFETIME_MS, quietInstantSchema,
  quietReceiptSchema, quietWriteSchema, type SharedQuiet } from './quietContract'

const rowSchema = z.object({
  account_id: householdIdSchema, household_id: householdIdSchema, revision: householdIdSchema,
  updated_at: quietInstantSchema, quiet_until: quietInstantSchema.nullable(),
}).strict().refine(value => value.quiet_until === null || (value.quiet_until > value.updated_at
  && value.quiet_until - value.updated_at <= QUIET_MAX_DURATION_MS), 'Saved quiet clocks are inconsistent.')
type QuietRow = z.infer<typeof rowSchema>
interface MutationRow { account_id: string, kind: string, request_hash: string, result: string }
const kind = 'household_quiet'
const conflict = (message: string) => new HouseholdError('conflict', 409, message)
const unavailable = () => new HouseholdError('not_ready', 503, 'Quiet status is unavailable. Shared actions must wait.')

/** Shared rest is the union of explicit requests, never an inference about who occupies a side. */
export class HouseholdQuietStore {
  constructor(private readonly database: Database.Database, private readonly identities: HouseholdStore,
    private readonly now = () => Date.now()) {}

  private clock() { return quietInstantSchema.parse(this.now()) }

  private rows(householdId: string, now: number): QuietRow[] {
    try {
      const rows = this.database.prepare('SELECT * FROM household_quiet_requests WHERE household_id = ?').all(householdId).map(value => rowSchema.parse(value))
      if (rows.some(row => row.updated_at > now)) throw unavailable()
      return rows
    }
    catch { throw unavailable() }
  }

  private shared(rows: QuietRow[], now: number): SharedQuiet {
    const ends = rows.flatMap(row => row.quiet_until !== null && row.quiet_until > now ? [row.quiet_until] : [])
    return { paused: ends.length > 0, until: ends.length ? Math.max(...ends) : null }
  }

  private selection(session: HouseholdSession, rows: QuietRow[], now: number) {
    const mine = rows.find(row => row.account_id === session.accountId)
    const until = mine?.quiet_until ?? null
    return { mine: { revision: mine?.revision ?? null, until: until !== null && until > now ? until : null },
      shared: this.shared(rows, now) }
  }

  read(credential: HouseholdCredential) {
    const session = this.identities.session(credential), now = this.clock()
    return this.selection(session, this.rows(session.householdId, now), now)
  }

  /** No account names, individual requests, credentials or biometric data leave this shared signal. */
  sharedState(): SharedQuiet {
    const now = this.clock()
    const households = this.database.prepare('SELECT id FROM households').all() as { id: string }[]
    if (households.length > 1) throw unavailable()
    if (!households.length) {
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM household_quiet_requests').get() as { count: number }
      if (count.count) throw unavailable()
      return { paused: false, until: null }
    }
    return this.shared(this.rows(householdIdSchema.parse(households[0].id), now), now)
  }

  telemetry() {
    try {
      const now = this.clock(), shared = this.sharedState()
      return { schemaVersion: 1, source: 'household_quiet', available: true, ts: now,
        expiresAt: now + QUIET_OBSERVATION_LIFETIME_MS, ...shared }
    }
    catch {
      return { schemaVersion: 1, source: 'household_quiet', available: false, ts: null,
        expiresAt: null, paused: null, until: null }
    }
  }

  receipt(credential: HouseholdCredential, requestId: string) {
    householdIdSchema.parse(requestId)
    const session = this.identities.session(credential)
    const row = this.database.prepare('SELECT result FROM household_mutation_receipts WHERE request_id = ? AND account_id = ? AND kind = ?')
      .get(requestId, session.accountId, kind) as { result: string } | undefined
    try {
      const receipt = row ? quietReceiptSchema.parse(JSON.parse(row.result)) : null
      if (receipt && receipt.requestId !== requestId) throw unavailable()
      return receipt
    }
    catch { throw unavailable() }
  }

  /** The request and its receipt commit together; retries return the old receipt without extending quiet. */
  write(credential: HouseholdCredential, input: unknown) {
    const request = quietWriteSchema.parse(input)
    return this.database.transaction(() => {
      const session = this.identities.session(credential)
      if (session.sessionRevision !== request.expectedSessionRevision || session.assignmentRevision !== request.expectedAssignmentRevision)
        throw conflict('Your account or bed assignment changed. Reload before changing quiet time.')
      const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
      const previous = this.database.prepare('SELECT * FROM household_mutation_receipts WHERE request_id = ?').get(request.requestId) as MutationRow | undefined
      if (previous) {
        if (previous.account_id !== session.accountId || previous.kind !== kind || previous.request_hash !== hash)
          throw conflict('This request identifier was already used.')
        const receipt = this.receipt(credential, request.requestId)
        if (!receipt) throw unavailable()
        return receipt
      }
      const now = this.clock()
      if (request.issuedAt > now + 5_000 || request.expiresAt <= now
        || (request.until !== null && (request.until <= now || request.until > now + QUIET_MAX_DURATION_MS)))
        throw conflict('This quiet request expired or its clock is ahead. Review a fresh request.')
      const current = this.selection(session, this.rows(session.householdId, now), now)
      if (current.mine.revision !== request.expectedRevision) throw conflict('Your quiet request changed on another device. Reload before saving.')
      const revision = randomUUID()
      const receipt = quietReceiptSchema.parse({ requestId: request.requestId, revision, savedAt: now, until: request.until })
      this.database.prepare(`INSERT INTO household_quiet_requests (account_id, household_id, revision, updated_at, quiet_until)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET revision = excluded.revision,
        updated_at = excluded.updated_at, quiet_until = excluded.quiet_until`)
        .run(session.accountId, session.householdId, revision, now, request.until)
      this.database.prepare('INSERT INTO household_mutation_receipts (request_id, account_id, kind, request_hash, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(request.requestId, session.accountId, kind, hash, JSON.stringify(receipt), now)
      return receipt
    }).immediate()
  }
}

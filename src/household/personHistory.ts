import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { householdIdSchema } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import { attributionEpochSchema, historyTimeSchema, personalHistoryQuerySchema, personalHistoryRecordSchema, sourceObservationSchema, type AttributionEpochInput, type PersonalHistoryQuery, type SourceObservation } from './historyContract'

interface EpochRow {
  id: string
  household_id: string
  dataset_id: string
  starts_at: number
  ends_at: number | null
  mode: AttributionEpochInput['mode']
  assignments: string
  basis: AttributionEpochInput['basis']
  request_hash: string
  revoked_at: number | null
}
interface RecordRow {
  sequence: number
  id: string
  household_id: string
  sleeper_id: string
  epoch_id: string
  content_hash: string
  recorded_side: 'left' | 'right'
  starts_at: number
  ends_at: number
  payload: string
  invalidated_at: number | null
  mode: EpochRow['mode']
  basis: EpochRow['basis']
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const conflict = (message: string) => new HouseholdError('conflict', 409, message)
const cursorSchema = z.object({
  scope: z.string().regex(/^[a-f0-9]{64}$/), watermark: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  beforeSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  beforeStartsAt: historyTimeSchema,
}).strict()

/** Internal ownership boundary. No HTTP mutation, hardware change or automatic
 * source importer calls this yet. Only a reviewed coordinator may append epochs. */
export class PersonHistoryStore {
  // Cursors expire when this singleton restarts. They carry no reusable account
  // credential; signatures prevent clients from changing snapshot watermarks.
  private cursorKey = randomBytes(32)
  constructor(private database: Database.Database, private identities: HouseholdStore, private now = () => Date.now()) {}

  private revision(householdId: string) {
    const row = this.database.prepare('SELECT attribution_revision AS revision FROM household_history_state WHERE household_id = ?').get(householdId) as { revision: number } | undefined
    return row?.revision ?? 1
  }

  private bumpRevision(householdId: string) {
    this.database.prepare(`INSERT INTO household_history_state (household_id, attribution_revision) VALUES (?, 2)
      ON CONFLICT(household_id) DO UPDATE SET attribution_revision = attribution_revision + 1`).run(householdId)
  }

  private validateReviewer(input: AttributionEpochInput) {
    const reviewer = this.database.prepare(`SELECT account.id, household.effective_at FROM household_accounts account
      JOIN households household ON household.id = account.household_id
      WHERE account.id = ? AND account.household_id = ? AND account.role = 'owner' AND account.state = 'active'`)
      .get(input.reviewedBy, input.householdId) as { id: string, effective_at: number } | undefined
    if (!reviewer) throw new HouseholdError('forbidden', 403, 'An active household owner must review attribution.')
    if (input.startsAt > this.now() || (input.endsAt !== null && input.endsAt > this.now()))
      throw conflict('Future attribution is not an activation schedule.')
    if (input.basis === 'legacy_owner_review' && (input.endsAt === null || input.endsAt > reviewer.effective_at))
      throw conflict('Legacy review is limited to the period before household setup.')
    if (input.basis === 'verified_arrangement' && input.startsAt < reviewer.effective_at)
      throw conflict('Earlier data requires a separate legacy review.')
    for (const assignment of input.assignments) {
      const account = this.database.prepare('SELECT id, role FROM household_accounts WHERE household_id = ? AND sleeper_id = ? AND state = ?')
        .get(input.householdId, assignment.sleeperId, 'active') as { id: string, role: string } | undefined
      if (!account || (input.basis === 'legacy_owner_review' && account.id !== reviewer.id))
        throw new HouseholdError('forbidden', 403, 'Attribution must name an eligible sleeper in this household.')
    }
  }

  /** Replay uses the retained review receipt; it cannot create a second epoch. */
  appendReviewedEpoch(input: unknown) {
    const parsed = attributionEpochSchema.parse(input)
    return this.database.transaction(() => this.insertEpoch(parsed)).immediate()
  }

  private insertEpoch(parsed: AttributionEpochInput, previousEpochId: string | null = null) {
    this.validateReviewer(parsed)
    const requestHash = digest({ ...parsed, previousEpochId })
    const existing = this.database.prepare('SELECT * FROM household_attribution_epochs WHERE review_receipt_id = ?').get(parsed.reviewReceiptId) as EpochRow | undefined
    if (existing) {
      if (existing.request_hash !== requestHash || existing.revoked_at !== null)
        throw conflict('This attribution review receipt is unavailable or changed.')
      return { epochId: existing.id, attributionRevision: this.revision(parsed.householdId) }
    }
    if (this.revision(parsed.householdId) !== parsed.expectedAttributionRevision)
      throw conflict('Attribution changed. Review the current plan again.')
    // Even revoked intervals reserve their original source period: corrections
    // require a separate reviewed process, never a new claimant on the same rows.
    const overlap = this.database.prepare(`SELECT id FROM household_attribution_epochs WHERE household_id = ? AND dataset_id = ?
      AND (? IS NULL OR starts_at < ?) AND (ends_at IS NULL OR ends_at > ?) LIMIT 1`)
      .get(parsed.householdId, parsed.datasetId, parsed.endsAt, parsed.endsAt, parsed.startsAt)
    if (overlap) throw conflict('Attribution intervals cannot overlap.')
    const epochId = randomUUID()
    this.database.prepare(`INSERT INTO household_attribution_epochs
      (id, household_id, dataset_id, starts_at, ends_at, mode, assignments, basis, review_receipt_id, reviewed_by, request_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(epochId, parsed.householdId, parsed.datasetId, parsed.startsAt, parsed.endsAt, parsed.mode, JSON.stringify(parsed.assignments), parsed.basis, parsed.reviewReceiptId, parsed.reviewedBy, requestHash, this.now())
    this.bumpRevision(parsed.householdId)
    return { epochId, attributionRevision: this.revision(parsed.householdId) }
  }

  /** Close the old period and add its replacement atomically; admitted records
   * can never be retroactively moved across the boundary. No hardware is touched. */
  transitionReviewedEpoch(previousEpochId: string, input: unknown) {
    householdIdSchema.parse(previousEpochId)
    const parsed = attributionEpochSchema.parse(input)
    return this.database.transaction(() => {
      this.validateReviewer(parsed)
      const replay = this.database.prepare('SELECT id FROM household_attribution_epochs WHERE review_receipt_id = ?').get(parsed.reviewReceiptId)
      if (replay) return this.insertEpoch(parsed, previousEpochId)
      if (this.revision(parsed.householdId) !== parsed.expectedAttributionRevision)
        throw conflict('Attribution changed. Review the current plan again.')
      const previous = this.database.prepare('SELECT * FROM household_attribution_epochs WHERE id = ? AND household_id = ? AND dataset_id = ?')
        .get(previousEpochId, parsed.householdId, parsed.datasetId) as EpochRow | undefined
      if (!previous || previous.ends_at !== null || previous.revoked_at !== null || parsed.startsAt <= previous.starts_at
        || parsed.basis !== 'verified_arrangement')
        throw conflict('The previous attribution period is no longer open.')
      const crosses = this.database.prepare('SELECT id FROM household_person_records WHERE epoch_id = ? AND ends_at > ? LIMIT 1').get(previousEpochId, parsed.startsAt)
      if (crosses) throw conflict('This transition would change already-attributed records.')
      this.database.prepare('UPDATE household_attribution_epochs SET ends_at = ? WHERE id = ?').run(parsed.startsAt, previousEpochId)
      return this.insertEpoch(parsed, previousEpochId)
    }).immediate()
  }

  /** Ingest one complete observation. Unknown ownership is withheld, never
   * inferred from the current side picker or a matching display name. */
  admitObservation(input: unknown) {
    const parsed = sourceObservationSchema.parse(input)
    if (parsed.endsAt > this.now()) throw conflict('Future or incomplete observations are not personal history.')
    return this.database.transaction(() => {
      const contentHash = digest(parsed)
      const existing = this.database.prepare('SELECT * FROM household_person_records WHERE dataset_id = ? AND source_kind = ? AND source_record_key = ?')
        .get(parsed.datasetId, parsed.payload.kind, parsed.sourceRecordKey) as RecordRow | undefined
      if (existing) {
        if (existing.household_id !== parsed.householdId) return { status: 'withheld' as const, reason: 'source_conflict' as const }
        if (existing.invalidated_at !== null) return { status: 'withheld' as const, reason: 'source_changed' as const }
        if (existing.content_hash !== contentHash) {
          this.database.prepare('UPDATE household_person_records SET invalidated_at = ? WHERE id = ?').run(this.now(), existing.id)
          this.bumpRevision(parsed.householdId)
          return { status: 'withheld' as const, reason: 'source_changed' as const }
        }
        const epoch = this.database.prepare('SELECT revoked_at FROM household_attribution_epochs WHERE id = ?').get(existing.epoch_id) as { revoked_at: number | null } | undefined
        if (!epoch || epoch.revoked_at !== null) return { status: 'withheld' as const, reason: 'unassigned' as const }
        return { status: 'unchanged' as const, personRecordId: existing.id }
      }
      const epochs = this.database.prepare(`SELECT * FROM household_attribution_epochs WHERE household_id = ? AND dataset_id = ?
        AND starts_at < ? AND (ends_at IS NULL OR ends_at > ?)`).all(parsed.householdId, parsed.datasetId, parsed.endsAt, parsed.startsAt) as EpochRow[]
      const epoch = epochs[0]
      if (epochs.length !== 1 || !epoch || epoch.revoked_at !== null || epoch.starts_at > parsed.startsAt || (epoch.ends_at !== null && epoch.ends_at < parsed.endsAt))
        return { status: 'withheld' as const, reason: 'unassigned' as const }
      const assignments = attributionEpochSchema.shape.assignments.parse(JSON.parse(epoch.assignments))
      const assignment = assignments.find(entry => entry.recordedSide === parsed.recordedSide)
      if (!assignment) return { status: 'withheld' as const, reason: 'unassigned' as const }
      const active = this.database.prepare('SELECT id FROM household_accounts WHERE household_id = ? AND sleeper_id = ? AND state = ?').get(parsed.householdId, assignment.sleeperId, 'active')
      if (!active) return { status: 'withheld' as const, reason: 'unassigned' as const }
      // Duplicate presence windows are not counted twice even if a collector
      // retries with a new source key or another source dataset overlaps it.
      if (parsed.payload.kind === 'presence' && this.overlappingPresence(parsed, assignment.sleeperId))
        return { status: 'withheld' as const, reason: 'overlapping_presence' as const }
      const personRecordId = randomUUID()
      this.database.prepare(`INSERT INTO household_person_records
        (id, household_id, sleeper_id, epoch_id, dataset_id, source_kind, source_record_key, content_hash, recorded_side, starts_at, ends_at, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(personRecordId, parsed.householdId, assignment.sleeperId, epoch.id, parsed.datasetId, parsed.payload.kind, parsed.sourceRecordKey, contentHash, parsed.recordedSide, parsed.startsAt, parsed.endsAt, JSON.stringify(parsed.payload), this.now())
      return { status: 'admitted' as const, personRecordId }
    }).immediate()
  }

  private overlappingPresence(input: SourceObservation, sleeperId: string) {
    return this.database.prepare(`SELECT id FROM household_person_records WHERE household_id = ? AND sleeper_id = ?
      AND source_kind = 'presence' AND starts_at < ? AND ends_at > ? LIMIT 1`).get(input.householdId, sleeperId, input.endsAt, input.startsAt) !== undefined
  }

  private project(row: RecordRow) {
    return personalHistoryRecordSchema.parse({ id: row.id, sleeperId: row.sleeper_id, startsAt: row.starts_at, endsAt: row.ends_at,
      recordedSide: row.recorded_side, payload: JSON.parse(row.payload),
      attribution: { epochId: row.epoch_id, mode: row.mode, basis: row.basis, identity: 'reviewed_arrangement_not_biometric_identification' } })
  }

  /** Resolve self on every read. Household owner status never broadens history. */
  records(credential: HouseholdCredential, input: unknown) {
    const query = personalHistoryQuerySchema.parse(input)
    return this.database.transaction(() => {
      const session = this.identities.session(credential)
      const attributionRevision = this.revision(session.householdId)
      const scope = digest({ householdId: session.householdId, sleeperId: session.selfSleeperId,
        sessionRevision: session.sessionRevision, assignmentRevision: session.assignmentRevision, attributionRevision,
        startsAt: query.startsAt, endsAt: query.endsAt, kind: query.kind, limit: query.limit })
      const maximum = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS watermark FROM household_person_records WHERE household_id = ? AND sleeper_id = ?')
        .get(session.householdId, session.selfSleeperId) as { watermark: number }
      const page = this.readCursor(query, scope, maximum.watermark)
      const rows = this.database.prepare(`SELECT record.*, epoch.mode, epoch.basis FROM household_person_records record
        JOIN household_attribution_epochs epoch ON epoch.id = record.epoch_id
        WHERE record.household_id = ? AND record.sleeper_id = ? AND record.source_kind = ?
          AND record.ends_at > ? AND record.starts_at < ? AND record.invalidated_at IS NULL AND epoch.revoked_at IS NULL
          AND record.sequence <= ? AND (record.starts_at < ? OR (record.starts_at = ? AND record.sequence < ?))
          ORDER BY record.starts_at DESC, record.sequence DESC LIMIT ?`)
        .all(session.householdId, session.selfSleeperId, query.kind, query.startsAt, query.endsAt, page.watermark, page.beforeStartsAt, page.beforeStartsAt, page.beforeSequence, query.limit + 1) as RecordRow[]
      const visible = rows.slice(0, query.limit)
      const last = visible.at(-1)
      const nextCursor = rows.length > query.limit && last
        ? this.signCursor({ scope, watermark: page.watermark, beforeSequence: last.sequence, beforeStartsAt: last.starts_at })
        : null
      return { sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision, assignmentRevision: session.assignmentRevision,
        attributionRevision, records: visible.map(row => this.project(row)), nextCursor }
    })()
  }

  private readCursor(query: PersonalHistoryQuery, scope: string, maximum: number) {
    if (!query.cursor) return { watermark: maximum, beforeSequence: Number.MAX_SAFE_INTEGER, beforeStartsAt: query.endsAt }
    try {
      const [encoded, signature, extra] = query.cursor.split('.')
      const expected = createHmac('sha256', this.cursorKey).update(encoded).digest()
      const actual = Buffer.from(signature ?? '', 'base64url')
      if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new Error('Invalid cursor signature')
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
      if (cursor.scope !== scope || cursor.watermark > maximum || cursor.beforeSequence > cursor.watermark)
        throw new Error('Mismatched cursor')
      return cursor
    }
    catch {
      throw conflict('This history page expired or belongs to a different context. Refresh the history.')
    }
  }

  private signCursor(value: z.infer<typeof cursorSchema>) {
    const encoded = Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${encoded}.${createHmac('sha256', this.cursorKey).update(encoded).digest('base64url')}`
  }

  record(credential: HouseholdCredential, personRecordId: string) {
    return this.detail(credential, personRecordId).record
  }

  /** Revision and record come from one snapshot, including a missing own record. */
  detail(credential: HouseholdCredential, personRecordId: string) {
    householdIdSchema.parse(personRecordId)
    return this.database.transaction(() => {
      const session = this.identities.session(credential)
      const row = this.database.prepare(`SELECT record.*, epoch.mode, epoch.basis FROM household_person_records record
        JOIN household_attribution_epochs epoch ON epoch.id = record.epoch_id WHERE record.id = ?
        AND record.household_id = ? AND record.sleeper_id = ? AND record.invalidated_at IS NULL AND epoch.revoked_at IS NULL`)
        .get(personRecordId, session.householdId, session.selfSleeperId) as RecordRow | undefined
      return { record: row ? this.project(row) : null, attributionRevision: this.revision(session.householdId) }
    })()
  }
}

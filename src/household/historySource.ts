import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { householdIdSchema } from './contract'
import { historyTimeSchema } from './historyContract'
import { HouseholdError } from './store'

const sourceIdentitySchema = z.object({
  id: z.literal(1), datasetId: householdIdSchema, createdAt: historyTimeSchema,
}).strict()
const bindingSchema = z.object({
  householdId: householdIdSchema, datasetId: householdIdSchema,
  reviewReceiptId: householdIdSchema, reviewedBy: householdIdSchema,
  boundAt: historyTimeSchema,
}).strict()
const reviewSchema = bindingSchema.omit({ boundAt: true })
const unavailable = () => new HouseholdError('conflict', 409,
  'The recorded-history source is unavailable or changed. Review its identity before importing personal history.')

/** Metadata only: never fills a missing identity while verifying an existing binding. */
export function readBiometricHistoryIdentity(biometrics: Database.Database) {
  const rows = biometrics.prepare('SELECT id, dataset_id AS datasetId, created_at_ms AS createdAt FROM biometric_history_identity LIMIT 2').all()
  if (rows.length !== 1) throw unavailable()
  const parsed = sourceIdentitySchema.safeParse(rows[0])
  if (!parsed.success) throw unavailable()
  return parsed.data
}

/** Explicit preparation creates identity only for a genuinely uninitialized source.
 * Backup copies retain this row; changing the file path never changes the dataset. */
export function prepareBiometricHistoryIdentity(biometrics: Database.Database, now = Date.now()) {
  historyTimeSchema.parse(now)
  return biometrics.transaction(() => {
    const existing = biometrics.prepare('SELECT 1 FROM biometric_history_identity LIMIT 1').get()
    if (!existing) biometrics.prepare('INSERT INTO biometric_history_identity (id, dataset_id, created_at_ms) VALUES (1, ?, ?)').run(randomUUID(), now)
    return readBiometricHistoryIdentity(biometrics)
  }).immediate()
}

/** An internal coordinator binds an explicitly reviewed source before creating
 * attribution epochs. Signup, requests to read history and file paths do not bind it. */
export class PersonHistorySource {
  constructor(private configuration: Database.Database, private biometrics: Database.Database, private now = () => Date.now()) {}

  bindReviewedSource(input: unknown) {
    const review = reviewSchema.parse(input)
    const source = readBiometricHistoryIdentity(this.biometrics)
    if (source.datasetId !== review.datasetId || source.createdAt > this.now()) throw unavailable()
    return this.configuration.transaction(() => {
      const owner = this.configuration.prepare('SELECT id FROM household_accounts WHERE id = ? AND household_id = ? AND role = \'owner\' AND state = \'active\'')
        .get(review.reviewedBy, review.householdId)
      if (!owner) throw new HouseholdError('forbidden', 403, 'An active household owner must review the recorded-history source.')
      const existing = this.readBinding(review.householdId)
      if (existing) {
        if (existing.datasetId !== review.datasetId || existing.reviewReceiptId !== review.reviewReceiptId || existing.reviewedBy !== review.reviewedBy) throw unavailable()
        return existing
      }
      const reused = this.configuration.prepare('SELECT household_id FROM household_history_sources WHERE dataset_id = ? OR review_receipt_id = ?')
        .get(review.datasetId, review.reviewReceiptId)
      if (reused) throw unavailable()
      const binding = bindingSchema.parse({ ...review, boundAt: this.now() })
      this.configuration.prepare('INSERT INTO household_history_sources (household_id, dataset_id, review_receipt_id, reviewed_by, bound_at) VALUES (?, ?, ?, ?, ?)')
        .run(binding.householdId, binding.datasetId, binding.reviewReceiptId, binding.reviewedBy, binding.boundAt)
      return binding
    }).immediate()
  }

  private readBinding(householdId: string) {
    const row = this.configuration.prepare('SELECT household_id AS householdId, dataset_id AS datasetId, review_receipt_id AS reviewReceiptId, reviewed_by AS reviewedBy, bound_at AS boundAt FROM household_history_sources WHERE household_id = ?').get(householdId)
    if (!row) return null
    const parsed = bindingSchema.safeParse(row)
    if (!parsed.success) throw unavailable()
    return parsed.data
  }

  /** Recheck at each import boundary. A replacement/restored source cannot be
   * silently rebound, and existing private record copies are left untouched. */
  verify(householdId: string, datasetId: string) {
    householdIdSchema.parse(householdId)
    householdIdSchema.parse(datasetId)
    const binding = this.readBinding(householdId)
    const source = readBiometricHistoryIdentity(this.biometrics)
    if (!binding || binding.datasetId !== datasetId || source.datasetId !== datasetId
      || binding.boundAt > this.now() || source.createdAt > this.now()) throw unavailable()
    return binding
  }
}

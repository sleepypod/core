import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { durableTransaction } from '@/src/db/durable'
import type { Side } from '@/src/hardware/types'
import { ExperimentApplicationStore } from './applications'
import { EXECUTION_REVIEW_MS, experimentExecutionReviewSchema, experimentGrantSchema,
  type ExperimentExecutionReview, type ExperimentGrant, type ExperimentZoneProof } from './admission-contract'
import type { ExperimentAdmission } from './application-contract'
import { experimentHashSchema, experimentInstantSchema } from './contract'
import { experimentPlanHash } from './plan'
import { ComfortExperimentStore } from './store'
import type { ExperimentPrincipal } from './execution-principal'

export interface ExperimentAdmissionDeps {
  database: Database.Database
  now(): number
  /** Host rechecks authenticated assignment, current policy and actual qualification proofs. */
  validate(review: ExperimentExecutionReview, includeSource: boolean): void
  /** Host already holds every affected side lock. This persists Preview in this same transaction. */
  suspend(zone: ExperimentZoneProof): void
  revokeLease(side: Side): void
}
interface ReviewRow {
  id: string
  subject_key: string
  scope_hash: string
  plan_id: string
  created_at: number
  expires_at: number
  consumed_at: number | null
  record: string
}
interface GrantRow {
  id: string
  subject_key: string
  plan_id: string
  admitted_at: number
  ends_at: number
  revoked_at: number | null
  record: string
}

/** Trusted admission journal; HTTP callers cannot supply qualification evidence or physical zones. */
export class ExperimentAdmissions {
  private readonly database: Database.Database
  constructor(private readonly deps: ExperimentAdmissionDeps) { this.database = deps.database }
  private now() { return experimentInstantSchema.parse(this.deps.now()) }
  private plan(subjectKey: string, id: string) {
    const record = new ComfortExperimentStore(this.database, subjectKey, this.deps.now).read(id)
    if (!record || record.status !== 'planned' || record.plan.version !== 2)
      throw new Error('A current scheduled experiment is required')
    return record
  }

  private currentPlan(review: ExperimentExecutionReview, confirming: boolean) {
    const record = this.plan(review.subjectKey, review.planId), plan = record.plan
    if (plan.version !== 2 || experimentPlanHash(plan) !== review.planHash
      || (confirming && (record.revision !== review.expectedRevision || this.now() >= plan.schedule.windows[0].windowStart)))
      throw new Error('The reviewed experiment changed or its first night already started')
    return plan
  }

  private grant(id: string): ExperimentGrant {
    const row = this.database.prepare('SELECT * FROM comfort_experiment_admissions WHERE id = ?').get(id) as GrantRow | undefined
    if (!row) throw new Error('The experiment admission is unavailable')
    const value = experimentGrantSchema.parse(JSON.parse(row.record)), review = value.review
    if (row.id !== review.id || row.subject_key !== review.subjectKey || row.plan_id !== review.planId
      || row.admitted_at !== value.admittedAt || row.ends_at !== value.endsAt || row.revoked_at !== value.revokedAt
      || value.admittedAt > this.now() || (value.revokedAt !== null && value.revokedAt > this.now()))
      throw new Error('The experiment admission identity or clock is inconsistent')
    const source = this.database.prepare('SELECT consumed_at, record FROM comfort_experiment_execution_reviews WHERE id = ? AND subject_key = ?')
      .get(review.id, review.subjectKey) as { consumed_at: number | null, record: string } | undefined
    const saved = new ComfortExperimentStore(this.database, review.subjectKey, this.deps.now).read(review.planId)
    if (!source || source.consumed_at !== value.admittedAt
      || JSON.stringify(experimentExecutionReviewSchema.parse(JSON.parse(source.record))) !== JSON.stringify(review)
      || saved?.plan.version !== 2 || experimentPlanHash(saved.plan) !== review.planHash
      || value.endsAt !== saved.plan.schedule.windows[saved.plan.schedule.windows.length - 1].windowEnd
      || value.admittedAt >= saved.plan.schedule.windows[0].windowStart)
      throw new Error('The experiment admission no longer matches its consumed review and scheduled plan')
    return value
  }

  private claimed(side: Side): ExperimentGrant | null {
    z.enum(['left', 'right']).parse(side)
    const row = this.database.prepare('SELECT admission_id FROM comfort_experiment_zone_claims WHERE side = ?').get(side) as { admission_id: string } | undefined
    if (!row) return null
    const value = this.grant(row.admission_id)
    if (!value.review.zones.some(zone => zone.side === side)) throw new Error('The experiment zone claim is inconsistent')
    return value
  }

  prepare(subjectKey: string, scopeHash: string, planId: string, zones: ExperimentZoneProof[], assertCurrent: () => void,
    principal: ExperimentPrincipal): ExperimentExecutionReview {
    experimentHashSchema.parse(subjectKey)
    experimentHashSchema.parse(scopeHash)
    return durableTransaction(this.database, () => {
      assertCurrent()
      const record = this.plan(subjectKey, planId), now = this.now()
      const review = experimentExecutionReviewSchema.parse({ id: randomUUID(), subjectKey, scopeHash, planId,
        planHash: experimentPlanHash(record.plan), expectedRevision: record.revision, createdAt: now, expiresAt: now + EXECUTION_REVIEW_MS, zones, principal })
      this.currentPlan(review, true)
      this.deps.validate(review, true)
      // Consumed reviews are retained because they anchor a durable grant and lost-response reconciliation.
      this.database.prepare('DELETE FROM comfort_experiment_execution_reviews WHERE consumed_at IS NULL AND (expires_at <= ? OR created_at > ?)').run(now, now)
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_execution_reviews WHERE subject_key = ? AND consumed_at IS NULL')
        .get(subjectKey) as { count: number }
      if (count.count >= 8) throw new Error('Several activation reviews are open. Wait for them to expire')
      this.database.prepare('INSERT INTO comfort_experiment_execution_reviews (id, subject_key, scope_hash, plan_id, created_at, expires_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(review.id, subjectKey, scopeHash, planId, now, review.expiresAt, JSON.stringify(review))
      assertCurrent()
      return review
    })
  }

  /** Idempotent confirmation cannot recreate a revoked grant or bypass an unresolved hardware attempt. */
  confirm(subjectKey: string, scopeHash: string, id: string, planHash: string, assertCurrent: () => void): ExperimentGrant {
    experimentHashSchema.parse(subjectKey)
    experimentHashSchema.parse(scopeHash)
    z.string().uuid().parse(id)
    experimentHashSchema.parse(planHash)
    return durableTransaction(this.database, () => {
      assertCurrent()
      const row = this.database.prepare('SELECT * FROM comfort_experiment_execution_reviews WHERE id = ? AND subject_key = ? AND scope_hash = ?')
        .get(id, subjectKey, scopeHash) as ReviewRow | undefined
      if (!row) throw new Error('This experiment review is unavailable to the current account')
      const review = experimentExecutionReviewSchema.parse(JSON.parse(row.record)), now = this.now()
      if (review.id !== row.id || review.subjectKey !== row.subject_key || review.scopeHash !== row.scope_hash || review.planId !== row.plan_id
        || review.createdAt !== row.created_at || review.expiresAt !== row.expires_at || review.planHash !== planHash
        || review.createdAt > now) throw new Error('The experiment review identity or clock changed')
      if (row.consumed_at !== null) {
        const existing = this.grant(id)
        if (existing.admittedAt !== row.consumed_at || JSON.stringify(existing.review) !== JSON.stringify(review))
          throw new Error('The consumed experiment review does not match its grant')
        assertCurrent()
        return existing
      }
      if (now >= review.expiresAt) throw new Error('The experiment activation review expired')
      const plan = this.currentPlan(review, true)
      this.deps.validate(review, true)
      const applications = new ExperimentApplicationStore(this.database, this.deps.now)
      for (const zone of review.zones) {
        const claimed = this.claimed(zone.side), previous = applications.latest(zone.side)
        if (claimed && claimed.revokedAt === null && claimed.endsAt > now)
          throw new Error('Another experiment still owns this physical zone. Stop it before confirming')
        if (previous && ['attempting', 'unknown'].includes(previous.outcome))
          throw new Error('Resolve the uncertain experiment application before a new admission')
      }
      for (const zone of review.zones) this.deps.suspend(zone)
      const grant = experimentGrantSchema.parse({ review, admittedAt: now,
        endsAt: plan.schedule.windows[plan.schedule.windows.length - 1].windowEnd, revokedAt: null, reason: null })
      this.database.prepare('INSERT INTO comfort_experiment_admissions (id, subject_key, plan_id, admitted_at, ends_at, record) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, subjectKey, review.planId, now, grant.endsAt, JSON.stringify(grant))
      for (const zone of review.zones) this.database.prepare('INSERT INTO comfort_experiment_zone_claims (side, admission_id) VALUES (?, ?) ON CONFLICT(side) DO UPDATE SET admission_id = excluded.admission_id')
        .run(zone.side, id)
      this.database.prepare('UPDATE comfort_experiment_execution_reviews SET consumed_at = ? WHERE id = ?').run(now, id)
      this.deps.validate(review, true)
      this.currentPlan(review, true)
      assertCurrent()
      return grant
    })
  }

  /** Expired or invalid evidence withdraws execution; a retained claim still needs explicit cancellation. */
  current(side: Side): { grant: ExperimentGrant, admission: ExperimentAdmission } | null {
    try {
      const grant = this.claimed(side), now = this.now()
      if (!grant || grant.revokedAt !== null || grant.endsAt <= now) return null
      this.currentPlan(grant.review, false)
      this.deps.validate(grant.review, false)
      return { grant, admission: { revision: grant.review.id, planHash: grant.review.planHash,
        issuedAt: grant.admittedAt, expiresAt: grant.endsAt, sides: grant.review.zones.map(zone => zone.side) } }
    }
    catch { return null }
  }

  /** Trusted host inspection; never return another subject's grant through a client endpoint. */
  claim(side: Side): ExperimentGrant | null { return this.claimed(side) }

  /** Current authenticated subjects may inspect their own retained grant after assignment changes. */
  read(subjectKey: string, id: string): ExperimentGrant {
    experimentHashSchema.parse(subjectKey)
    const row = this.database.prepare('SELECT id FROM comfort_experiment_admissions WHERE id = ? AND subject_key = ?')
      .get(z.string().uuid().parse(id), subjectKey)
    if (!row) throw new Error('This experiment admission is unavailable to the current account')
    return this.grant(id)
  }

  /** Read back the latest admission after a lost reply without confirming or dispatching again. */
  forPlan(subjectKey: string, planId: string): ExperimentGrant | null {
    const row = this.database.prepare(`SELECT id FROM comfort_experiment_admissions
      WHERE subject_key = ? AND plan_id = ? ORDER BY admitted_at DESC, rowid DESC LIMIT 1`)
      .get(experimentHashSchema.parse(subjectKey), z.string().uuid().parse(planId)) as { id: string } | undefined
    return row ? this.read(subjectKey, row.id) : null
  }

  review(subjectKey: string, scopeHash: string, id: string): ExperimentExecutionReview {
    const row = this.database.prepare('SELECT * FROM comfort_experiment_execution_reviews WHERE id = ? AND subject_key = ? AND scope_hash = ?')
      .get(z.string().uuid().parse(id), experimentHashSchema.parse(subjectKey), experimentHashSchema.parse(scopeHash)) as ReviewRow | undefined
    if (!row) throw new Error('This execution review is unavailable to the current account')
    const review = experimentExecutionReviewSchema.parse(JSON.parse(row.record))
    if (review.id !== row.id || review.subjectKey !== row.subject_key || review.scopeHash !== row.scope_hash
      || review.planId !== row.plan_id || review.createdAt !== row.created_at || review.expiresAt !== row.expires_at)
      throw new Error('The saved execution review identity changed')
    return review
  }

  revoke(subjectKey: string, id: string, reason: string, assertCurrent: () => void): void {
    experimentHashSchema.parse(subjectKey)
    z.string().uuid().parse(id)
    z.string().trim().min(1).max(1000).parse(reason)
    durableTransaction(this.database, () => {
      assertCurrent()
      const previous = this.grant(id)
      if (previous.review.subjectKey !== subjectKey) throw new Error('This experiment belongs to another account')
      if (previous.revokedAt !== null) return
      for (const zone of previous.review.zones) {
        if (this.claimed(zone.side)?.review.id === id) this.deps.revokeLease(zone.side)
      }
      const value = experimentGrantSchema.parse({ ...previous, revokedAt: this.now(), reason })
      this.database.prepare('UPDATE comfort_experiment_admissions SET revoked_at = ?, record = ? WHERE id = ?')
        .run(value.revokedAt, JSON.stringify(value), id)
      this.database.prepare('DELETE FROM comfort_experiment_zone_claims WHERE admission_id = ?').run(id)
      assertCurrent()
    })
  }
}

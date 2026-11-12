import type Database from 'better-sqlite3'
import { z } from 'zod'
import { EXPERIMENT_REVIEW_MS, experimentHashSchema, experimentInstantSchema, experimentPlanSchema, type ExperimentPlan } from './contract'
import { ExperimentStoreConflict } from './store'

interface ReviewRow { scope_hash: string, created_at: number, expires_at: number, plan: string }

/** Persist only bounded review metadata; saving a review never grants a treatment lease. */
export class ComfortExperimentReviews {
  constructor(private readonly database: Database.Database, private readonly subjectKey: string, private readonly now = Date.now) {
    experimentHashSchema.parse(subjectKey)
  }

  create(input: ExperimentPlan, scopeHash: string) {
    const plan = experimentPlanSchema.parse(input), now = experimentInstantSchema.parse(this.now())
    experimentHashSchema.parse(scopeHash)
    if (plan.context.subjectKey !== this.subjectKey || plan.createdAt > now || now >= plan.createdAt + EXPERIMENT_REVIEW_MS)
      throw new ExperimentStoreConflict('The experiment preview context changed.')
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM comfort_experiment_reviews WHERE expires_at <= ? OR created_at > ?').run(now, now)
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_reviews WHERE subject_key = ?')
        .get(this.subjectKey) as { count: number }
      if (count.count >= 8) throw new ExperimentStoreConflict('Several previews are already open. Wait a few minutes before reviewing again.')
      this.database.prepare('INSERT INTO comfort_experiment_reviews (id, subject_key, scope_hash, created_at, expires_at, plan) VALUES (?, ?, ?, ?, ?, ?)')
        .run(plan.id, this.subjectKey, scopeHash, plan.createdAt, plan.createdAt + EXPERIMENT_REVIEW_MS, JSON.stringify(plan))
    }).immediate()
  }

  read(id: string, scopeHash: string): ExperimentPlan | null {
    z.string().uuid().parse(id)
    experimentHashSchema.parse(scopeHash)
    const row = this.database.prepare('SELECT scope_hash, created_at, expires_at, plan FROM comfort_experiment_reviews WHERE id = ? AND subject_key = ?')
      .get(id, this.subjectKey) as ReviewRow | undefined
    const now = experimentInstantSchema.parse(this.now())
    if (!row || row.scope_hash !== scopeHash || row.created_at > now || row.expires_at <= now) return null
    const plan = experimentPlanSchema.parse(JSON.parse(row.plan))
    if (plan.context.subjectKey !== this.subjectKey || plan.id !== id || plan.createdAt !== row.created_at
      || row.expires_at !== plan.createdAt + EXPERIMENT_REVIEW_MS)
      throw new Error('The persisted experiment review is inconsistent')
    return plan
  }

  remove(id: string) {
    this.database.prepare('DELETE FROM comfort_experiment_reviews WHERE id = ? AND subject_key = ?').run(id, this.subjectKey)
  }
}

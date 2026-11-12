import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { dateInTimeZone } from '@/src/lib/timeZoneDate'
import { EXPERIMENT_REVIEW_MS, experimentExposureSchema, experimentFeedbackSchema, experimentHashSchema, experimentInstantSchema,
  experimentPlanSchema, type ExperimentPlan, type ExperimentRecord } from './contract'
import { checkedExperimentRecord, experimentNights, experimentPlanHash } from './plan'

const identifier = z.string().uuid()
const feedbackInput = experimentFeedbackSchema.omit({ recordedAt: true })
export class ExperimentStoreConflict extends Error {}
export class ExperimentFeedbackError extends Error {}
const conflict = () => new ExperimentStoreConflict('The experiment changed. Read its current revision before saving.')
interface ExperimentRow {
  id: string
  subject_key: string
  revision: string
  status: string
  created_at: number
  updated_at: number
  record: string
}

/** Internal repository, bound to an authenticated subject by its API adapter; never a hardware owner. */
export class ComfortExperimentStore {
  private readonly subjectKey: string

  constructor(private readonly database: Database.Database, subjectKey: string,
    private readonly now = () => Date.now()) {
    this.subjectKey = experimentHashSchema.parse(subjectKey)
  }

  private clock(): number { return experimentInstantSchema.parse(this.now()) }

  private decode(row: ExperimentRow): ExperimentRecord {
    const record = checkedExperimentRecord(JSON.parse(row.record))
    if (row.subject_key !== this.subjectKey || record.plan.context.subjectKey !== this.subjectKey
      || record.plan.id !== row.id || record.revision !== row.revision || record.status !== row.status
      || record.plan.createdAt !== row.created_at || record.updatedAt !== row.updated_at || record.updatedAt > this.clock())
      throw new Error('The saved experiment identity or clock is inconsistent')
    return record
  }

  read(id: string): ExperimentRecord | null {
    identifier.parse(id)
    const row = this.database.prepare('SELECT * FROM comfort_experiments WHERE id = ? AND subject_key = ?')
      .get(id, this.subjectKey) as ExperimentRow | undefined
    return row ? this.decode(row) : null
  }

  list(): ExperimentRecord[] {
    return (this.database.prepare('SELECT * FROM comfort_experiments WHERE subject_key = ? ORDER BY created_at DESC, id LIMIT 50')
      .all(this.subjectKey) as ExperimentRow[]).map(row => this.decode(row))
  }

  open(): ExperimentRecord | null {
    const row = this.database.prepare('SELECT * FROM comfort_experiments WHERE subject_key = ? AND status = \'planned\'')
      .get(this.subjectKey) as ExperimentRow | undefined
    return row ? this.decode(row) : null
  }

  /** Stable keyset pagination is scoped before resolving the cursor, including tied creation clocks. */
  page(afterId?: string): { records: ExperimentRecord[], nextId: string | null } {
    const after = afterId === undefined ? null : this.read(identifier.parse(afterId))
    if (afterId !== undefined && !after) throw new Error('The experiment page is unavailable')
    const rows = (after
      ? this.database.prepare(`SELECT * FROM comfort_experiments WHERE subject_key = ? AND
        (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 21`)
          .all(this.subjectKey, after.plan.createdAt, after.plan.createdAt, after.plan.id)
      : this.database.prepare('SELECT * FROM comfort_experiments WHERE subject_key = ? ORDER BY created_at DESC, id DESC LIMIT 21')
          .all(this.subjectKey)) as ExperimentRow[]
    const records = rows.slice(0, 20).map(row => this.decode(row))
    return { records, nextId: rows.length > 20 ? records[records.length - 1].plan.id : null }
  }

  /** Save the exact reviewed assignment. Retrying an existing ID never creates a second plan. */
  create(input: ExperimentPlan): ExperimentRecord {
    const plan = experimentPlanSchema.parse(input)
    return this.database.transaction(() => {
      if (plan.context.subjectKey !== this.subjectKey) throw new Error('Experiment scope does not match')
      const existing = this.read(plan.id)
      if (existing) {
        if (experimentPlanHash(existing.plan) !== experimentPlanHash(plan)) throw conflict()
        return existing
      }
      const now = this.clock()
      if (plan.createdAt > now || now - plan.createdAt >= EXPERIMENT_REVIEW_MS) throw new ExperimentStoreConflict('The experiment preview expired')
      const open = this.database.prepare('SELECT id FROM comfort_experiments WHERE subject_key = ? AND status = \'planned\'').get(this.subjectKey)
      if (open) throw new ExperimentStoreConflict('Stop the existing experiment before starting another')
      const record = checkedExperimentRecord({ plan, revision: randomUUID(), updatedAt: now, status: 'planned',
        stoppedAt: null, exposures: [], feedback: [] })
      this.database.prepare('INSERT INTO comfort_experiments (id, subject_key, revision, status, created_at, updated_at, record) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(plan.id, this.subjectKey, record.revision, record.status, plan.createdAt, now, JSON.stringify(record))
      return record
    }).immediate()
  }

  private update(id: string, expectedRevision: string, change: (record: ExperimentRecord, now: number) => ExperimentRecord) {
    identifier.parse(expectedRevision)
    return this.database.transaction(() => {
      const current = this.read(id)
      if (!current || current.revision !== expectedRevision) throw conflict()
      const now = this.clock()
      const updated = checkedExperimentRecord({ ...change(current, now), revision: randomUUID(), updatedAt: now })
      if (experimentPlanHash(updated.plan) !== experimentPlanHash(current.plan)) throw new Error('An experiment plan is immutable')
      const result = this.database.prepare('UPDATE comfort_experiments SET revision = ?, status = ?, updated_at = ?, record = ? WHERE id = ? AND subject_key = ? AND revision = ?')
        .run(updated.revision, updated.status, now, JSON.stringify(updated), id, this.subjectKey, expectedRevision)
      if (result.changes !== 1) throw conflict()
      return updated
    }).immediate()
  }

  /** This durable cancellation does not restore an old target or modify an alarm. */
  stop(id: string, expectedRevision: string) {
    return this.update(id, expectedRevision, (record, now) => ({ ...record, status: 'stopped', stoppedAt: record.stoppedAt ?? now }))
  }

  saveFeedback(id: string, expectedRevision: string, input: unknown) {
    const feedback = feedbackInput.parse(input)
    return this.update(id, expectedRevision, (record, now) => {
      const scheduled = record.plan.version === 2 ? record.plan.schedule.windows.find(window => window.date === feedback.nightDate) : null
      if (scheduled
        ? (now < scheduled.windowEnd || now > scheduled.windowEnd + 14 * 86_400_000)
        : (feedback.nightDate >= dateInTimeZone(now, record.plan.context.timezone)
          || Date.parse(dateInTimeZone(now, record.plan.context.timezone)) - Date.parse(feedback.nightDate) > 15 * 86_400_000)
      )
        throw new ExperimentFeedbackError('Feedback must describe a completed night within the last fourteen mornings')
      if (!experimentNights(record.plan).some(night => night.date === feedback.nightDate))
        throw new ExperimentFeedbackError('Feedback cannot describe an unassigned experiment night')
      const saved = experimentFeedbackSchema.parse({ ...feedback, recordedAt: now })
      return { ...record, feedback: [...record.feedback.filter(value => value.nightDate !== saved.nightDate), saved]
        .sort((first, second) => first.nightDate.localeCompare(second.nightDate)) }
    })
  }

  /** Trusted collector only. Revised or withdrawn evidence replaces the old copy, never its assignment. */
  saveExposure(id: string, expectedRevision: string, input: unknown) {
    const exposure = experimentExposureSchema.parse(input)
    return this.update(id, expectedRevision, (record, now) => {
      if (exposure.recordedAt > now || exposure.windowStart < record.plan.createdAt
        || exposure.planHash !== experimentPlanHash(record.plan)
        || !experimentNights(record.plan).some(night => night.date === exposure.nightDate))
        throw new Error('Exposure does not describe a completed assigned experiment night')
      const old = record.exposures.find(value => value.nightDate === exposure.nightDate)
      if (old && exposure.recordedAt <= old.recordedAt) throw new Error('Exposure revision is not newer than the saved observation')
      return { ...record, exposures: [...record.exposures.filter(value => value.nightDate !== exposure.nightDate), exposure]
        .sort((first, second) => first.nightDate.localeCompare(second.nightDate)) }
    })
  }
}

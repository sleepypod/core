import type Database from 'better-sqlite3'
import { z } from 'zod'
import { durableTransaction } from '@/src/db/durable'
import { experimentFeedbackSchema, experimentHashSchema, experimentProposalSchema, EXPERIMENT_REVIEW_MS, type ExperimentRecord } from './contract'
import { compareExperiment } from './analysis'
import { createScheduledExperimentPlan, experimentContextMatches, experimentNights, experimentPlanHash } from './plan'
import { experimentDigest, readExperimentAvailability, type ExperimentAccess, type ExperimentAvailability } from './access'
import { ComfortExperimentStore } from './store'
import { ComfortExperimentReviews } from './reviews'
import { ExperimentScheduleError, resolveExperimentSchedule } from './schedule'
import { auditObservedExperiment } from './observation-source'

export class ExperimentError extends Error {
  constructor(readonly code: 'invalid_request' | 'conflict' | 'not_found' | 'not_ready', readonly status: number, message: string) { super(message) }
}
const identifier = z.string().uuid()
const confirmation = z.object({ reviewId: identifier, planHash: experimentHashSchema }).strict()
const expectedRevision = z.object({ expectedRevision: identifier }).strict()
const feedback = expectedRevision.extend({ feedback: experimentFeedbackSchema.omit({ recordedAt: true }) }).strict()

/** Private planning and evidence service. No method here dispatches a temperature or changes an alarm. */
export class ComfortExperimentService {
  constructor(private readonly database: Database.Database, private readonly now = Date.now,
    private readonly availability = (access: ExperimentAccess) => readExperimentAvailability(database, access)) {}

  private store(access: ExperimentAccess) { return new ComfortExperimentStore(this.database, access.subjectKey, this.now) }
  private reviews(access: ExperimentAccess) { return new ComfortExperimentReviews(this.database, access.subjectKey, this.now) }
  private currentAvailability(access: ExperimentAccess): ExperimentAvailability {
    try {
      const current = this.availability(access)
      if (current.context && current.context.subjectKey !== access.subjectKey) throw new Error('Experiment policy scope mismatch')
      return current
    }
    catch { return { context: null, reason: 'The current overnight policy could not be read. Existing records and Stop remain available.' } }
  }

  /** Authority, context and writes share the SQLite lock, including changes made by another process. */
  transaction<Result>(work: () => Result, durable = false): Result {
    return durable ? durableTransaction(this.database, work) : this.database.transaction(work).immediate()
  }

  private describe(record: ExperimentRecord, current: ExperimentAvailability) {
    const observed = auditObservedExperiment(this.database, this.now, record)
    return { record: observed, comparison: compareExperiment(observed),
      contextCurrent: current.context !== null && experimentContextMatches(record.plan, current.context),
      contextReason: current.reason, execution: 'planning_only' as const }
  }

  overview(access: ExperimentAccess, afterId?: string) {
    const current = this.currentAvailability(access)
    const page = this.store(access).page(afterId)
    return { availability: { context: current.context, reason: current.reason }, execution: 'planning_only' as const, nextId: page.nextId,
      experiments: page.records.map(record => ({ id: record.plan.id, revision: record.revision, status: record.status,
        createdAt: record.plan.createdAt, updatedAt: record.updatedAt, firstNightDate: record.plan.firstNightDate,
        baselineF: record.plan.context.baselineF, variantF: record.plan.variantF,
        contextCurrent: current.context !== null && experimentContextMatches(record.plan, current.context) })) }
  }

  detail(access: ExperimentAccess, id: string) {
    const record = this.store(access).read(identifier.parse(id))
    if (!record) throw new ExperimentError('not_found', 404, 'This experiment is not in your library.')
    return this.describe(record, this.currentAvailability(access))
  }

  prepare(access: ExperimentAccess, proposal: unknown) {
    const parsed = experimentProposalSchema.parse(proposal)
    const current = this.currentAvailability(access)
    if (!current.context) throw new ExperimentError('not_ready', 409, current.reason)
    if (!current.schedule) throw new ExperimentError('not_ready', 409, 'Your scheduled nights could not be read. Review your routine before planning a comparison.')
    if (this.store(access).open()) throw new ExperimentError('conflict', 409, 'Stop your existing experiment before reviewing another.')
    const now = this.now()
    let schedule
    try {
      schedule = resolveExperimentSchedule(current.schedule, parsed.firstNightDate, now)
    }
    catch (error) {
      if (error instanceof ExperimentScheduleError) throw new ExperimentError('not_ready', 409, error.message)
      throw error
    }
    const plan = createScheduledExperimentPlan(current.context, parsed.variantF, schedule, now)
    this.reviews(access).create(plan, experimentDigest(access.scope))
    return { reviewId: plan.id, planHash: experimentPlanHash(plan), expiresAt: now + EXPERIMENT_REVIEW_MS,
      plan, nights: experimentNights(plan), schedule, execution: 'planning_only' as const,
      notice: 'This saves a comparison plan only. Temperature adjustments require a separately qualified controller. Your wake routine is unchanged.' }
  }

  confirm(access: ExperimentAccess, input: unknown) {
    const parsed = confirmation.parse(input), store = this.store(access)
    const existing = store.read(parsed.reviewId)
    if (existing) {
      if (experimentPlanHash(existing.plan) !== parsed.planHash) throw new ExperimentError('conflict', 409, 'This review identifies a different saved plan.')
      return this.describe(existing, this.currentAvailability(access))
    }
    const plan = this.reviews(access).read(parsed.reviewId, experimentDigest(access.scope))
    if (!plan || experimentPlanHash(plan) !== parsed.planHash)
      throw new ExperimentError('conflict', 409, 'This preview expired or your account changed. Review the comparison again.')
    const current = this.currentAvailability(access)
    if (!current.context || !experimentContextMatches(plan, current.context))
      throw new ExperimentError('conflict', 409, 'Your assignment, overnight policy or wake routine changed. Review the comparison again.')
    // A five-minute review can cross the first scheduled start; never confirm a shortened or already-started treatment.
    if (plan.version !== 2 || !current.schedule || this.now() >= plan.schedule.windows[0].windowStart)
      throw new ExperimentError('conflict', 409, 'The reviewed night windows are no longer available. Review the comparison again.')
    try {
      const schedule = resolveExperimentSchedule(current.schedule, plan.schedule.requestedFirstNightDate, this.now())
      if (experimentDigest(schedule) !== experimentDigest(plan.schedule)) throw new Error('Changed night windows')
    }
    catch { throw new ExperimentError('conflict', 409, 'The scheduled or wake windows changed. Review the comparison again.') }
    if (store.open()) throw new ExperimentError('conflict', 409, 'Another experiment was saved. Open its current record before continuing.')
    const saved = store.create(plan)
    this.reviews(access).remove(plan.id)
    return this.describe(saved, current)
  }

  stop(access: ExperimentAccess, id: string, input: unknown) {
    const parsed = expectedRevision.parse(input), store = this.store(access)
    const record = this.detail(access, id).record
    if (record.status === 'stopped') return this.describe(record, this.currentAvailability(access))
    if (record.revision !== parsed.expectedRevision) throw new ExperimentError('conflict', 409, 'The experiment changed. Refresh before stopping it.')
    return this.describe(store.stop(id, parsed.expectedRevision), this.currentAvailability(access))
  }

  saveFeedback(access: ExperimentAccess, id: string, input: unknown) {
    const parsed = feedback.parse(input), store = this.store(access)
    const record = this.detail(access, id).record
    if (record.revision !== parsed.expectedRevision) throw new ExperimentError('conflict', 409, 'The experiment changed. Refresh before saving feedback.')
    return this.describe(store.saveFeedback(id, parsed.expectedRevision, parsed.feedback), this.currentAvailability(access))
  }
}

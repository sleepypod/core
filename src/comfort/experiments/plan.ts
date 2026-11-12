import { createHash, randomInt, randomUUID } from 'node:crypto'
import { experimentNights } from './nights'
export { experimentNights } from './nights'
import { dateInTimeZone } from '@/src/lib/timeZoneDate'
import { experimentContextSchema, experimentPlanSchema, experimentProposalSchema, experimentRecordSchema,
  type ExperimentContext, type ExperimentNight, type ExperimentPlan, type ExperimentSchedule } from './contract'

/** Canonical parsed objects keep the reviewed plan identity independent of input key order. */
export function experimentPlanHash(plan: ExperimentPlan): string {
  return createHash('sha256').update(JSON.stringify(experimentPlanSchema.parse(plan))).digest('hex')
}

export function createExperimentPlan(context: ExperimentContext, proposal: unknown, now: number,
  draw: (upperExclusive: number) => number = randomInt): ExperimentPlan {
  const parsed = experimentProposalSchema.parse(proposal)
  const orders: ExperimentPlan['orders'] = ['baseline_first', 'baseline_first', 'variant_first', 'variant_first']
  // Fisher-Yates gives each balanced order equal probability. Invalid random providers fail closed.
  for (let index = orders.length - 1; index > 0; index--) {
    const selected = draw(index + 1)
    if (!Number.isInteger(selected) || selected < 0 || selected > index) throw new Error('Invalid experiment random draw')
    const previous = orders[index]
    orders[index] = orders[selected]
    orders[selected] = previous
  }
  return experimentPlanSchema.parse({ version: 1, id: randomUUID(), createdAt: now,
    context: experimentContextSchema.parse(context), ...parsed, orders })
}

/** Window selection precedes randomization and cannot depend on the assigned treatment. */
export function createScheduledExperimentPlan(context: ExperimentContext, variantF: number, schedule: ExperimentSchedule, now: number): ExperimentPlan {
  const plan = createExperimentPlan(context, { firstNightDate: schedule.windows[0].date, variantF }, now)
  return experimentPlanSchema.parse({ ...plan, version: 2, schedule })
}

export function checkedExperimentRecord(input: unknown) {
  const record = experimentRecordSchema.parse(input)
  const dates = new Set(experimentNights(record.plan).map(night => night.date))
  if ([...record.exposures, ...record.feedback].some(item => !dates.has(item.nightDate)))
    throw new Error('An experiment observation belongs to an unassigned night')
  return record
}

/** Reassignment, changed limits/routines or wake edits invalidate future treatment admission. */
export function experimentContextMatches(plan: ExperimentPlan, context: ExperimentContext): boolean {
  return JSON.stringify(experimentContextSchema.parse(plan.context)) === JSON.stringify(experimentContextSchema.parse(context))
}

export function experimentNightAt(plan: ExperimentPlan, routineStart: number): ExperimentNight | null {
  if (!Number.isSafeInteger(routineStart) || routineStart < plan.createdAt) return null
  if (plan.version === 2 && !plan.schedule.windows.some(window => window.windowStart === routineStart)) return null
  return experimentNights(plan).find(night => night.date === dateInTimeZone(routineStart, plan.context.timezone)) ?? null
}

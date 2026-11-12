import { createHash, randomInt, randomUUID } from 'node:crypto'
import { dateInTimeZone } from '@/src/lib/timeZoneDate'
import { experimentContextSchema, experimentDateSchema, experimentPlanSchema, experimentProposalSchema, experimentRecordSchema,
  type ExperimentArm, type ExperimentContext, type ExperimentNight, type ExperimentPlan } from './contract'

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

/** Dates are calendar labels, not 24-hour actuator windows; DST is resolved by the routine adapter. */
export function experimentNights(plan: ExperimentPlan): ExperimentNight[] {
  const validated = experimentPlanSchema.parse(plan)
  const nights: ExperimentNight[] = []
  for (const [pair, order] of validated.orders.entries()) {
    const arms: ExperimentArm[] = order === 'baseline_first' ? ['baseline', 'variant'] : ['variant', 'baseline']
    for (const [period, arm] of arms.entries()) {
      for (const role of ['settling', 'scored'] as const) {
        const date = experimentDateSchema.parse(new Date(Date.parse(validated.firstNightDate) + nights.length * 86_400_000).toISOString().slice(0, 10))
        nights.push({ date, pair, period, role, arm,
          targetF: arm === 'baseline' ? validated.context.baselineF : validated.variantF })
      }
    }
  }
  return nights
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
  return experimentNights(plan).find(night => night.date === dateInTimeZone(routineStart, plan.context.timezone)) ?? null
}

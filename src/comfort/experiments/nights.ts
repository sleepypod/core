import { experimentPlanSchema, experimentDateSchema, type ExperimentArm, type ExperimentNight, type ExperimentPlan } from './contract'

/** Legacy calendar plans remain readable; new plans use their immutable scheduled dates. */
export function experimentNights(plan: ExperimentPlan): ExperimentNight[] {
  const validated = experimentPlanSchema.parse(plan)
  const nights: ExperimentNight[] = []
  for (const [pair, order] of validated.orders.entries()) {
    const arms: ExperimentArm[] = order === 'baseline_first' ? ['baseline', 'variant'] : ['variant', 'baseline']
    for (const [period, arm] of arms.entries()) {
      for (const role of ['settling', 'scored'] as const) {
        const date = validated.version === 2
          ? validated.schedule.windows[nights.length].date
          : experimentDateSchema.parse(new Date(Date.parse(validated.firstNightDate) + nights.length * 86_400_000).toISOString().slice(0, 10))
        nights.push({ date, pair, period, role, arm,
          targetF: arm === 'baseline' ? validated.context.baselineF : validated.variantF })
      }
    }
  }
  return nights
}


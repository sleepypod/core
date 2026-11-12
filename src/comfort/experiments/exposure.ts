import { createHash } from 'node:crypto'
import { z } from 'zod'
import { DEVICE_MAX_AGE_MS, PRESENCE_MAX_AGE_MS } from '../policy'
import { experimentExposureSchema, experimentHashSchema, experimentInstantSchema, experimentPlanSchema,
  type ExperimentExposure, type ExperimentPlan } from './contract'
import { experimentNightAt, experimentPlanHash } from './plan'
import { EXPERIMENT_POLICY } from './application-contract'

const sampleSchema = z.object({
  at: experimentInstantSchema,
  deviceAt: experimentInstantSchema.nullable(),
  presenceAt: experimentInstantSchema.nullable(),
  targetF: z.number().min(55).max(110).nullable(),
  powered: z.boolean(), occupied: z.boolean().nullable(), waterAdequate: z.boolean().nullable(),
  priming: z.boolean(), vibrating: z.boolean(), baseMoving: z.boolean().nullable(),
  bindingHash: experimentHashSchema, routineHash: experimentHashSchema, wakeHash: experimentHashSchema,
  // Selection provenance must come from the shared authority, not a matching temperature alone.
  selectedRequestId: z.string().max(200).nullable(),
  attributionAmbiguous: z.boolean(),
}).strict()
export type ExperimentSample = z.infer<typeof sampleSchema>

const eventSchema = z.object({
  id: z.string().uuid(), at: experimentInstantSchema,
  kind: z.enum(['manual_change', 'unconfirmed_command', 'safety_interruption']),
}).strict()

const windowSchema = z.object({
  start: experimentInstantSchema, end: experimentInstantSchema,
  wakeStartsAt: experimentInstantSchema.nullable(), recordedAt: experimentInstantSchema,
  execution: z.enum(['preview', 'active']),
}).strict().refine(value => value.start < value.end && value.end - value.start <= 26 * 3_600_000
  && value.recordedAt >= value.end, 'Only completed bounded windows can be summarized.')

export function experimentRequestId(plan: ExperimentPlan, date: string): string {
  return `experiment:${plan.id}:${date}`
}

/** Preserve the shared authority's producer prefix in observed execution evidence. */
export function experimentAuthorityRequestId(plan: ExperimentPlan, date: string): string {
  return `policy:${EXPERIMENT_POLICY}:${experimentRequestId(plan, date)}`
}

/** Fold nonoverlapping intervals; no repeated stale observation can fill a recording gap. */
export function collectExperimentExposure(planInput: ExperimentPlan, windowInput: z.infer<typeof windowSchema>,
  sampleInput: ExperimentSample[], eventInput: z.infer<typeof eventSchema>[]): ExperimentExposure {
  const plan = experimentPlanSchema.parse(planInput), window = windowSchema.parse(windowInput)
  const night = experimentNightAt(plan, window.start)
  if (!night) throw new Error('The routine window is not an assigned experiment night')
  if (plan.version === 2) {
    const scheduled = plan.schedule.windows.find(value => value.date === night.date)
    if (!scheduled || window.end !== scheduled.windowEnd || window.wakeStartsAt !== (scheduled.wake?.startsAt ?? null))
      throw new Error('Exposure must retain the exact reviewed night and wake boundaries')
  }
  const samples = z.array(sampleSchema).max(10_000).parse(sampleInput)
  const events = z.array(eventSchema).max(10_000).parse(eventInput)
  if (samples.some((sample, index) => sample.at < window.start - PRESENCE_MAX_AGE_MS || sample.at > window.end
    || (index > 0 && sample.at <= samples[index - 1].at)
    || (sample.deviceAt !== null && sample.deviceAt > sample.at)
    || (sample.presenceAt !== null && sample.presenceAt > sample.at)))
    throw new Error('Collector samples must have ordered, nonfuture source clocks')

  const requestId = experimentAuthorityRequestId(plan, night.date)
  let observedMs = 0, matchedTargetMs = 0, occupiedMs = 0, qualifiedMs = 0
  for (const [index, sample] of samples.entries()) {
    if (sample.deviceAt === null) continue
    const start = Math.max(window.start, sample.at)
    const end = Math.min(window.end, samples[index + 1]?.at ?? window.end, sample.deviceAt + DEVICE_MAX_AGE_MS)
    const observed = Math.max(0, end - start)
    observedMs += observed
    const matched = sample.targetF === night.targetF
    if (matched) matchedTargetMs += observed
    const occupied = sample.occupied && sample.presenceAt !== null
      ? Math.max(0, Math.min(end, sample.presenceAt + PRESENCE_MAX_AGE_MS) - start)
      : 0
    occupiedMs += occupied
    const identityCurrent = sample.bindingHash === plan.context.bindingHash && sample.routineHash === plan.context.routineHash
      && sample.wakeHash === plan.context.wakeHash && !sample.attributionAmbiguous
    if (identityCurrent && matched && sample.powered && sample.waterAdequate && !sample.priming && !sample.vibrating
      && sample.baseMoving === false && sample.selectedRequestId === requestId) qualifiedMs += occupied
  }

  const uniqueEvents = new Map<string, z.infer<typeof eventSchema>>()
  for (const event of events) {
    if (event.at > window.recordedAt) throw new Error('A collector event cannot come from the future')
    if (event.at < window.start || event.at >= window.end) continue
    const previous = uniqueEvents.get(event.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error('A collector event identity was reused')
    uniqueEvents.set(event.id, event)
  }
  const countEvents = (kind: z.infer<typeof eventSchema>['kind']) => [...uniqueEvents.values()].filter(event => event.kind === kind).length
  // An in-window context change must remain visible even if a later sample returns to the original context.
  const contextHash = (field: 'bindingHash' | 'routineHash' | 'wakeHash') => {
    const values = [...new Set([plan.context[field], ...samples.filter(sample => sample.at < window.end).map(sample => sample[field])])].sort()
    return values.length === 1 ? values[0] : createHash('sha256').update(JSON.stringify(values)).digest('hex')
  }
  const sourceHash = createHash('sha256').update(JSON.stringify({ window, samples, events: [...uniqueEvents.values()].sort((first, second) => first.id.localeCompare(second.id)) })).digest('hex')
  return experimentExposureSchema.parse({ nightDate: night.date, recordedAt: window.recordedAt,
    planHash: experimentPlanHash(plan), bindingHash: contextHash('bindingHash'), routineHash: contextHash('routineHash'),
    wakeHash: contextHash('wakeHash'), sourceHash, sourceState: 'current', execution: window.execution,
    windowStart: window.start, windowEnd: window.end, wakeStartsAt: window.wakeStartsAt, targetF: night.targetF,
    observedMs, matchedTargetMs, occupiedMs, qualifiedMs, manualChanges: countEvents('manual_change'),
    unconfirmedCommands: countEvents('unconfirmed_command'), safetyInterruptions: countEvents('safety_interruption'),
    attributionAmbiguous: samples.some(sample => sample.at < window.end && sample.attributionAmbiguous) })
}

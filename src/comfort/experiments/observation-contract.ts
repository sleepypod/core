import { z } from 'zod'
import { experimentDateSchema, experimentHashSchema, experimentInstantSchema } from './contract'
import { experimentSampleSchema } from './exposure'

export const EXPERIMENT_OBSERVATION_INTERVAL_MS = 10_000
export const MAX_EXPERIMENT_OBSERVATIONS = 10_000
const sides = z.array(z.enum(['left', 'right'])).min(1).max(2).refine(value => new Set(value).size === value.length)

export const experimentObservationBindingSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), subjectKey: experimentHashSchema,
  admissionId: z.string().uuid(), planId: z.string().uuid(), planHash: experimentHashSchema,
  nightDate: experimentDateSchema, windowStart: experimentInstantSchema, windowEnd: experimentInstantSchema,
  sides, createdAt: experimentInstantSchema,
}).strict().refine(value => value.windowStart < value.windowEnd && value.windowEnd - value.windowStart <= 26 * 3_600_000
  && value.createdAt >= value.windowStart && value.createdAt < value.windowEnd)
export type ExperimentObservationBinding = z.infer<typeof experimentObservationBindingSchema>

export const experimentObservationSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), windowId: z.string().uuid(), at: experimentInstantSchema,
  zones: z.array(z.object({ side: z.enum(['left', 'right']), sample: experimentSampleSchema }).strict()).min(1).max(2),
}).strict().refine(value => new Set(value.zones.map(zone => zone.side)).size === value.zones.length
  && value.zones.every(zone => zone.sample.at === value.at
    && (zone.sample.selectedRequestId === null || (zone.sample.selectedUntil !== null
      && zone.sample.selectedUntil !== undefined && zone.sample.selectedUntil > value.at))
    && (zone.sample.deviceAt === null || zone.sample.deviceAt <= value.at)
    && (zone.sample.presenceAt === null || zone.sample.presenceAt <= value.at)))
export type ExperimentObservation = z.infer<typeof experimentObservationSchema>

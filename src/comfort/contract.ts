import { previewEvidenceSchema } from './report-contract'
import { bedtimeSelectionSchema, bedtimeStatusSchema } from './bedtime'
import { z } from 'zod'
import { comfortApplicationSchema } from './application-contract'
import { comfortSignalsSchema } from './signals'
import { bedroomGuidanceSchema } from '@/src/bedroom/contract'
import { thermalContextSchema, thermalLearningSchema } from './thermal-learning'
import { thermalObservationSchema } from './thermal-observation'

export const COMFORT_ACTIVATION_REASON = 'Hardware qualification and reviewed Preview nights are pending.' as const

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000)
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
)

export const comfortConfigSchema = z.object({
  mode: z.enum(['off', 'preview', 'active']),
  minimumF: z.number().int().min(55).max(110),
  maximumF: z.number().int().min(55).max(110),
  sensorAware: z.boolean().optional(),
  followBedtime: z.boolean().optional(),
  roomAware: z.boolean().optional(),
}).strict().refine(config => config.minimumF <= config.maximumF, 'Minimum must not exceed maximum')

export const comfortStateSchema = z.object({
  config: comfortConfigSchema,
  offsetF: z.number().int().min(-3).max(3),
  feedbackThrough: z.union([z.literal(''), localDate]),
  learnedSession: z.string().max(500),
  pausedUntil: timestamp,
  lastAppliedAt: timestamp,
  lastTargetF: z.number().min(55).max(110).nullable(),
  lastSegment: z.string().max(1000),
  bedtime: bedtimeSelectionSchema.optional(),
  application: comfortApplicationSchema.optional(),
}).strict()

export const comfortFeedbackSchema = z.object({
  date: localDate,
  comfort: z.enum(['warm', 'cold', 'comfortable']),
}).strict()

export const comfortDecisionSchema = z.object({
  eligible: z.boolean(),
  baselineF: z.number().nullable(),
  proposedF: z.number().nullable(),
  reason: z.string(),
  retainPreviousLease: z.boolean(),
  pauseRequired: z.boolean(),
})

export const comfortEventSchema = z.object({
  at: timestamp,
  kind: z.enum(['preview', 'active', 'configuration', 'feedback', 'manual_pause']),
  session: z.string().nullable(),
  message: z.string(),
  proposedF: z.number().nullable(),
  reportedF: z.number().nullable(),
  eligible: z.boolean(),
  deviceObservedAt: timestamp.nullable(),
  presenceObservedAt: timestamp.nullable(),
  owner: z.enum(['manual', 'run-once', 'autopilot', 'schedule']).nullable(),
  signals: comfortSignalsSchema.nullable().optional(),
  bedroom: bedroomGuidanceSchema.nullable().optional(),
  timing: bedtimeStatusSchema.nullable().optional(),
  preview: previewEvidenceSchema.optional(),
  thermalContext: thermalContextSchema.nullable().optional(),
  thermalObservation: thermalObservationSchema.optional(),
})
export type ComfortEvent = z.infer<typeof comfortEventSchema>

export const comfortStatusSchema = z.object({
  apiVersion: z.literal(1),
  generatedAt: timestamp,
  side: z.enum(['left', 'right']),
  timezone: z.string().nullable(),
  deviceDate: localDate.nullable(),
  state: comfortStateSchema.nullable(),
  evaluatedAt: timestamp.nullable(),
  decision: comfortDecisionSchema.nullable(),
  fault: z.string().nullable(),
  history: z.array(comfortEventSchema),
  runtime: z.enum(['running', 'stopped']),
  activation: z.object({
    // Legacy native clients require false: direct mode/configure activation stays unavailable.
    available: z.literal(false),
    current: z.boolean().optional(),
    reason: z.string(),
  }),
  features: z.object({ roomAware: z.boolean().optional(), sensorAware: z.boolean(), followBedtime: z.boolean(), nightReports: z.boolean().optional(), modeOnly: z.boolean().optional(), ownerActivation: z.boolean().optional(), modelTraining: z.boolean().optional() }),
  signals: comfortSignalsSchema.nullable().optional(),
  bedroom: bedroomGuidanceSchema.nullable().optional(),
  timing: bedtimeStatusSchema.nullable().optional(),
  learning: thermalLearningSchema.nullable().optional(),
})
export type ComfortStatus = z.infer<typeof comfortStatusSchema>

import { z } from 'zod'
import { forecastInputSchema } from './thermal-forecast'
import { predictiveHorizonsSchema, predictiveTargetPreviewSchema } from './predictive-contract'
import { previewEvidenceSchema } from './report-contract'

export const PREDICTIVE_RECORDING_INTERVAL_MS = 300_000
export const PREDICTIVE_RECORDING_RETENTION_MS = 30 * 86_400_000
const instant = z.number().int().positive().max(8_640_000_000_000_000)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z.object({ id: digest, datasetHash: digest }).strict()
const forecast = z.object({ predictions: predictiveHorizonsSchema.or(z.array(z.never()).length(0)), reason: z.string().max(2000) }).strict()

export const predictiveWorkerRequestSchema = z.object({
  version: z.literal(1), side: z.enum(['left', 'right']), at: instant, observedAt: instant,
  configuration: digest, input: forecastInputSchema,
}).strict().refine(value => value.observedAt <= value.at && value.at - value.observedAt < 15_000,
  'Only a fresh observed input can start a prospective comparison.')
export type PredictiveWorkerRequest = z.infer<typeof predictiveWorkerRequestSchema>
export const predictiveWorkerResultSchema = z.object({
  version: z.literal(1), requestHash: digest, holdIdentity: identity.nullable(), responseIdentity: identity.nullable(),
  hold: forecast, steps: z.array(forecast.extend({ targetF: z.number().int().min(55).max(110) }).strict()).max(2),
}).strict().refine(value => (value.holdIdentity !== null || value.hold.predictions.length === 0)
  && (value.responseIdentity !== null || value.steps.every(step => step.predictions.length === 0)),
'Predictions require the exact reviewed artifact identity.')
export type PredictiveWorkerResult = z.infer<typeof predictiveWorkerResultSchema>

/** Recorded before future outcomes exist. No row can claim that a candidate was applied. */
export const predictiveRecordingSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), runId: z.string().uuid(), recordedAt: instant,
  source: previewEvidenceSchema, request: predictiveWorkerRequestSchema,
  forecasts: predictiveWorkerResultSchema, selection: predictiveTargetPreviewSchema,
  attribution: z.literal('physical_zone_only'), applied: z.literal(false),
}).strict().superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message })
  if (value.selection.side !== value.request.side || value.selection.generatedAt !== value.recordedAt
    || value.runId !== value.source.runId
    || value.recordedAt < value.request.at || value.recordedAt - value.request.observedAt >= 15_000
    || value.selection.currentTargetF !== value.request.input.targetF) invalid('Recording identity or freshness changed.')
  if (value.source.environment !== 'production' || !value.source.buildRevision || !value.source.hardwareIdentity
    || value.source.presence !== 'occupied' || !value.source.presenceSourceKey || !value.source.deviceFresh
    || !value.source.mechanicallyQuiet || value.source.manualPaused || value.request.at < value.source.start
    || value.request.at >= value.source.end) invalid('Prospective records require attributable production observations.')
  if (!value.source.bedroom?.configuration) invalid('A recorded room-source identity is required.')
})
export type PredictiveRecording = z.infer<typeof predictiveRecordingSchema>

export const predictiveRecordingStatusSchema = z.object({
  apiVersion: z.literal(1), side: z.enum(['left', 'right']), generatedAt: instant,
  mode: z.literal('research_preview'), activationAvailable: z.literal(false),
  records: z.number().int().nonnegative(), sessions: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(), holds: z.number().int().nonnegative(), withheld: z.number().int().nonnegative(),
  latestAt: instant.nullable(), outcomeNotice: z.literal('Unapplied targets have no observed outcome. These records do not establish comfort benefit.'),
  collector: z.object({ running: z.boolean(), fault: z.string().nullable() }).strict().optional(),
  reason: z.string(),
}).strict().refine(value => value.records === value.candidates + value.holds + value.withheld
  && value.sessions <= value.records && (value.records === 0) === (value.latestAt === null)
  && (value.latestAt === null || value.latestAt <= value.generatedAt), 'Recording counts or timestamps are inconsistent.')

export const predictiveStatusRequestSchema = z.object({
  version: z.literal(1), operation: z.literal('status'), side: z.enum(['left', 'right']), at: instant,
}).strict()
export const predictiveStatusResultSchema = z.object({ version: z.literal(1), requestHash: digest, data: predictiveRecordingStatusSchema }).strict()

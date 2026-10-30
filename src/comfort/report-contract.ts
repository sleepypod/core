import { z } from 'zod'
import { bedroomGuidanceSchema } from '@/src/bedroom/contract'

export const reportIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000)
const timezone = z.string().max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  }
  catch { return false }
}, 'Unknown timezone')

/** Captured by the runtime, never accepted as a client-supplied observation. */
export const previewEvidenceSchema = z.object({
  format: z.literal(1), runId: z.string().uuid(),
  environment: z.enum(['production', 'test', 'development', 'unknown']),
  buildRevision: z.string().regex(/^[a-f0-9]{7,40}$/).nullable(),
  hardwareIdentity: reportIdSchema.nullable().optional(),
  session: z.string().min(1).max(500), start: timestamp, end: timestamp, timezone,
  scheduleRevision: reportIdSchema,
  bedroom: bedroomGuidanceSchema.nullable().optional(),
  policy: z.object({ minimumF: z.number().min(55).max(110), maximumF: z.number().min(55).max(110),
    sensorAware: z.boolean(), followBedtime: z.boolean(), roomAware: z.boolean().optional(), offsetF: z.number().int().min(-3).max(3) }).strict(),
  scheduledBaselineF: z.number().min(55).max(110),
  decisionBaselineF: z.number().min(55).max(110).nullable(),
  presence: z.enum(['occupied', 'empty', 'unavailable']),
  presenceSourceKey: reportIdSchema.nullable(), mechanicallyQuiet: z.boolean(),
  deviceFresh: z.boolean(), sensorReady: z.boolean(), manualPaused: z.boolean(),
}).strict().refine(value => value.end > value.start && value.end - value.start <= 26 * 3_600_000, 'Invalid routine window')
export type PreviewEvidence = z.infer<typeof previewEvidenceSchema>

const metadataSchema = z.object({ session: previewEvidenceSchema.shape.session, start: timestamp, end: timestamp, timezone })
  .refine(value => value.end > value.start && value.end - value.start <= 26 * 3_600_000, 'Invalid routine window')
const count = z.number().int().nonnegative()
export const previewSummarySchema = z.object({
  id: reportIdSchema, digest: reportIdSchema, metadata: metadataSchema,
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  state: z.enum(['collecting', 'closed', 'source_expired']),
  firstAt: timestamp, lastAt: timestamp, observationCount: count,
  occupiedObservationMs: count, minimumOccupiedObservationMs: z.literal(14_400_000),
  occupiedCount: count, eligibleCount: count, sensorReadyCount: count, deviceFreshCount: count, manualPauseCount: count,
  proposedRangeF: z.object({ minimum: z.number(), maximum: z.number() }).nullable(),
  reportedRangeF: z.object({ minimum: z.number(), maximum: z.number() }).nullable(),
  reasons: z.array(z.object({ message: z.string(), count })),
  gaps: z.array(z.object({ from: timestamp, to: timestamp })), gapCount: count,
  configurations: count, runs: count, builds: z.array(z.string()),
  issues: z.array(z.string()), reviewable: z.boolean(),
})
export type PreviewSummary = z.infer<typeof previewSummarySchema>

export const previewReviewInputSchema = z.object({
  side: z.enum(['left', 'right']), id: reportIdSchema, digest: reportIdSchema,
  expectedReviewId: z.number().int().positive().nullable(),
  outcome: z.enum(['reviewed', 'needs_retest']), confirmedActualNight: z.boolean(),
  note: z.string().trim().max(2000),
}).strict().refine(value => value.outcome !== 'reviewed' || value.confirmedActualNight, 'Confirm this was an actual overnight Preview session')
export type PreviewReviewInput = z.infer<typeof previewReviewInputSchema>
export const previewReviewSchema = z.object({
  id: z.number().int().positive(), at: timestamp, digest: reportIdSchema,
  outcome: z.enum(['reviewed', 'needs_retest']), confirmedActualNight: z.boolean(), note: z.string(),
})
export type PreviewReview = z.infer<typeof previewReviewSchema>
export const previewReportItemSchema = z.object({
  summary: previewSummarySchema, review: previewReviewSchema.nullable(),
  reviewCurrent: z.boolean(), countsAsOwnerConfirmedNight: z.boolean(),
})
export type PreviewReportItem = z.infer<typeof previewReportItemSchema>
export const previewReportListSchema = z.object({
  apiVersion: z.literal(1), generatedAt: timestamp, side: z.enum(['left', 'right']),
  items: z.array(previewReportItemSchema), targetNights: z.literal(7), ownerConfirmedNights: count,
  activationAvailable: z.literal(false),
})
export const previewObservationSchema = z.object({
  id: z.number().int().positive(), at: timestamp, eligible: z.boolean(),
  proposedF: z.number().nullable(), reportedF: z.number().nullable(), message: z.string(),
  evidence: previewEvidenceSchema,
})
export const previewReportDetailSchema = previewReportItemSchema.extend({
  observations: z.array(previewObservationSchema), nextAfterId: z.number().int().positive().nullable(),
})

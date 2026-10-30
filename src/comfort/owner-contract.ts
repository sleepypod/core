import { z } from 'zod'
import { comfortApplicationSchema } from './application-contract'
import { previewSummarySchema, reportIdSchema } from './report-contract'

const timestamp = z.number().int().positive().max(8_640_000_000_000_000)
export const qualificationKindSchema = z.enum(['presence_empty', 'presence_occupied', 'cooling', 'warming', 'manual_stop', 'offline_routine'])
export type QualificationKind = z.infer<typeof qualificationKindSchema>
export const qualificationLabels: Record<QualificationKind, string> = {
  presence_empty: 'Empty-side presence', presence_occupied: 'Occupied-side presence',
  cooling: 'Cooling response', warming: 'Warming response', manual_stop: 'Manual stop', offline_routine: 'Offline routine and wake alarm',
}
export const qualificationInstructions: Record<QualificationKind, string> = {
  presence_empty: 'Leave this side empty. Confirm the calibrated reading agrees with what you see.',
  presence_occupied: 'Occupy this side. Confirm the calibrated reading agrees with what you see; this does not establish sleep.',
  cooling: 'Use the normal temperature controls, wait at least a minute, and confirm this side feels cooler without leaks or unusual noise. The warming test must use a target at least 2°F higher.',
  warming: 'Use the normal temperature controls, wait at least a minute, and confirm this side feels warmer without leaks or unusual noise. Use a target at least 2°F above the cooling test.',
  manual_stop: 'After testing both temperatures, switch this side off using the normal controls. Confirm heating/cooling stopped. The app also checks a fresh off report and the manual pause.',
  offline_routine: 'Attend a scheduled temperature change and wake alarm with internet, the phone and home server unavailable. Confirm the routine, alarm and cancellation worked. The journal proves acknowledgments; only your observation confirms the outage and physical behavior.',
}

export const ownerIdentitySchema = z.object({
  hardware: reportIdSchema, calibration: reportIdSchema, schedule: reportIdSchema,
  build: z.string().regex(/^[a-f0-9]{7,40}$/),
  bedroomConfiguration: reportIdSchema.nullable().optional(),
  policy: z.object({ minimumF: z.number().int(), maximumF: z.number().int(), sensorAware: z.boolean(), followBedtime: z.boolean(), roomAware: z.boolean().optional() }).strict(),
}).strict()
export type OwnerIdentity = z.infer<typeof ownerIdentitySchema>

export const qualificationEvidenceSchema = z.object({
  identity: ownerIdentitySchema, observedAt: timestamp, presenceAt: timestamp.nullable(),
  presence: z.enum(['occupied', 'empty', 'unavailable']), powered: z.boolean(), offConfirmed: z.boolean(), targetF: z.number().nullable(),
  applicationId: z.string().uuid().nullable(), applicationAt: timestamp.nullable(),
  alarmAt: timestamp.nullable(), pausedUntil: z.number().int().nonnegative(),
}).strict()
export const qualificationSchema = z.object({
  id: z.string().uuid(), kind: qualificationKindSchema, at: timestamp,
  outcome: z.enum(['confirmed', 'needs_retest']), note: z.string().max(2000), evidence: qualificationEvidenceSchema,
})
export type Qualification = z.infer<typeof qualificationSchema>
export const nightProofSchema = z.object({ summary: previewSummarySchema, reviewId: z.number().int().positive(), lastObservationId: z.number().int().positive(), eligibleMs: z.number().int().nonnegative() })
export type NightProof = z.infer<typeof nightProofSchema>

export const ownerSnapshotSchema = z.object({
  identity: ownerIdentitySchema, note: z.string().max(2000).optional(),
  qualifications: z.array(qualificationSchema), nights: z.array(nightProofSchema),
  evidence: qualificationEvidenceSchema.nullable(), application: comfortApplicationSchema.nullable(),
}).strict()
export type OwnerSnapshot = z.infer<typeof ownerSnapshotSchema>
export const ownerReviewSchema = z.object({
  id: z.string().uuid(), side: z.enum(['left', 'right']), at: timestamp, expiresAt: timestamp,
  purpose: z.enum(['qualification', 'activation', 'resolution']), kind: qualificationKindSchema.nullable(),
  snapshot: ownerSnapshotSchema,
})
export type OwnerReview = z.infer<typeof ownerReviewSchema>
export const ownerStatusSchema = z.object({
  apiVersion: z.literal(1), generatedAt: timestamp, side: z.enum(['left', 'right']),
  identity: ownerIdentitySchema.nullable(), qualifications: z.array(qualificationSchema),
  nights: z.array(nightProofSchema), reasons: z.array(z.string()),
  active: z.boolean(), canActivate: z.boolean(), application: comfortApplicationSchema.nullable(),
})
export const ownerPrepareSchema = z.object({
  side: z.enum(['left', 'right']), purpose: z.enum(['qualification', 'activation', 'resolution']),
  kind: qualificationKindSchema.nullable(),
}).strict()
export const ownerConfirmSchema = z.object({
  side: z.enum(['left', 'right']), id: z.string().uuid(), confirmed: z.literal(true), note: z.string().trim().max(2000),
}).strict()

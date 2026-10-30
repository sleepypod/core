import { z } from 'zod'
import { bedtimeDraftSchema, routineDaySchema } from '@/src/lib/bedtimeRoutines'
export const HOUSEHOLD_VERSION = 1 as const
export const householdIdSchema = z.string().uuid()
export const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const deviceSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/)
const displayName = z.string().trim().min(1).max(80)
const deviceName = z.string().trim().min(1).max(80)
export const householdSideSchema = z.enum(['left', 'right'])
export const personPreferencesSchema = z.object({
  displayUnit: z.enum(['F', 'C']),
  preferredTemperatureF: z.number().int().min(55).max(110),
  comfort: z.enum(['warm_sleeper', 'balanced', 'cold_sleeper']),
  shareWakeTime: z.boolean(),
  cloudAnalysisConsent: z.literal(false),
}).strict()
// Weekly entries are bedtime nights, matching the existing routine compiler.
export const personalWeekSchema = z.array(z.object({
  dayOfWeek: routineDaySchema,
  draft: bedtimeDraftSchema,
}).strict()).max(7).superRefine((week, context) => {
  if (new Set(week.map(entry => entry.dayOfWeek)).size !== week.length) {
    context.addIssue({ code: 'custom', message: 'Each bedtime night may appear only once.' })
  }
})
export const householdSessionSchema = z.object({
  apiVersion: z.literal(1), featureVersion: z.literal(HOUSEHOLD_VERSION),
  podId: householdIdSchema, householdId: householdIdSchema,
  accountId: householdIdSchema, selfSleeperId: householdIdSchema,
  role: z.enum(['owner', 'member']), membership: z.literal('active'),
  sessionRevision: revisionSchema, householdRevision: revisionSchema, assignmentRevision: revisionSchema,
  arrangement: z.object({ mode: z.enum(['solo-anywhere', 'assigned']), effectiveAt: z.iso.datetime() }).strict(),
  self: z.object({ displayName, zones: z.array(householdSideSchema).max(2), assignment: z.enum(['solo', 'left', 'right', 'unassigned']) }).strict(),
  capabilities: z.object({
    manageInvitations: z.boolean(), manageOwnDevices: z.literal(true),
    personalPreferences: z.literal(true), personalRoutineDrafts: z.literal(true),
    // Preparation is deliberately separate from physically activating a second sleeper.
    activateArrangement: z.boolean(), personalControls: z.boolean(),
    personalRoutinePublication: z.boolean().optional(),
    arrangementReview: z.boolean().optional(),
    personalHistory: z.boolean(), healthImport: z.boolean(), cloudAnalysis: z.literal(false),
  }).strict(),
}).strict()
export type HouseholdSession = z.infer<typeof householdSessionSchema>
export const householdContextSchema = z.object({
  requestId: householdIdSchema,
  expectedSessionRevision: revisionSchema,
  expectedAssignmentRevision: revisionSchema,
}).strict()
export const householdSetupSchema = z.object({
  requestId: householdIdSchema, displayName,
  deviceName, deviceSecret: deviceSecretSchema,
  currentMode: z.literal('solo-anywhere'), sourceSide: householdSideSchema,
  acknowledgeExistingOwner: z.literal(true),
}).strict()
export const householdInvitationSchema = householdContextSchema.extend({
  kind: z.enum(['new_person', 'own_device']),
  invitation: deviceSecretSchema,
  expiresInMinutes: z.number().int().min(5).max(1440),
}).strict()
export const householdJoinSchema = z.object({
  invitation: deviceSecretSchema, deviceName, deviceSecret: deviceSecretSchema, displayName,
}).strict()
export const invitationResponseSchema = z.object({
  id: householdIdSchema, invitation: deviceSecretSchema,
  kind: z.enum(['new_person', 'own_device']), expiresAt: z.iso.datetime(),
}).strict()
export const personalPreferencesResponseSchema = z.object({
  sleeperId: householdIdSchema, revision: revisionSchema,
  preferences: personPreferencesSchema,
}).strict()
export const personalRoutinesResponseSchema = z.object({
  sleeperId: householdIdSchema, revision: revisionSchema,
  status: z.enum(['draft_only', 'scheduled']),
  routines: personalWeekSchema,
}).strict()
export const updatePreferencesSchema = householdContextSchema.extend({
  expectedRevision: revisionSchema, preferences: personPreferencesSchema,
}).strict()
export const updateRoutinesSchema = householdContextSchema.extend({
  expectedRevision: revisionSchema, routines: personalWeekSchema,
}).strict()
export const deviceResponseSchema = z.object({
  devices: z.array(z.object({ id: householdIdSchema, name: deviceName, createdAt: z.iso.datetime(), current: z.boolean() }).strict()),
}).strict()
export const revokeDeviceSchema = householdContextSchema.extend({ deviceId: householdIdSchema }).strict()
export const revokeInvitationSchema = householdContextSchema.extend({ invitationId: householdIdSchema }).strict()
export const revokedResponseSchema = z.object({ revoked: z.literal(true) }).strict()
export const invitationsResponseSchema = z.object({
  invitations: z.array(z.object({
    id: householdIdSchema, kind: z.enum(['new_person', 'own_device']), expiresAt: z.iso.datetime(),
    status: z.enum(['pending', 'claimed', 'expired', 'revoked']),
  }).strict()),
}).strict()
export const householdErrorSchema = z.object({ error: z.object({
  code: z.enum(['authentication_required', 'setup_required', 'forbidden', 'conflict', 'invalid_request', 'invitation_unavailable', 'not_ready', 'rate_limited']),
  message: z.string(),
}).strict() }).strict()

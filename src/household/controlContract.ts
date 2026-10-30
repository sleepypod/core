import { z } from 'zod'
import { controlReceiptSchema, MAX_CONTROL_LIFETIME_MS } from '@/src/controls/contract'
import { householdIdSchema, householdSideSchema, revisionSchema } from './contract'

// Pin the person and installation, not a client-selected physical side. A side
// move or changed hardware configuration requires a fresh review before sending.
export const personalControlScopeSchema = z.object({
  podId: householdIdSchema, householdId: householdIdSchema, sleeperId: householdIdSchema,
  sessionRevision: revisionSchema, assignmentRevision: revisionSchema,
  configurationRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export const personalControlActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('temperature'), temperatureF: z.number().int().min(55).max(110), holdMinutes: z.number().int().min(1).max(1440) }).strict(),
  z.object({ kind: z.literal('power'), powered: z.boolean(), temperatureF: z.number().int().min(55).max(110).optional() }).strict(),
  z.object({ kind: z.literal('vibration.clear') }).strict(),
])
const instant = z.number().int().positive().max(8_640_000_000_000_000)
export const personalControlRequestSchema = z.object({
  version: z.literal(1), requestId: householdIdSchema,
  scope: personalControlScopeSchema, issuedAt: instant, expiresAt: instant,
  action: personalControlActionSchema,
}).strict().refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= MAX_CONTROL_LIFETIME_MS,
  'Control lifetime must be positive and no more than 60 seconds.')
export const personalControlReceiptSchema = controlReceiptSchema.omit({ action: true }).extend({
  scope: personalControlScopeSchema,
  action: personalControlActionSchema,
  // These are the historical targets of this request, not today's assignment.
  resolvedZones: z.array(householdSideSchema).min(1).max(2).refine(zones => new Set(zones).size === zones.length),
}).strict()
export type PersonalControlScope = z.infer<typeof personalControlScopeSchema>
export type PersonalControlAction = z.infer<typeof personalControlActionSchema>
export type PersonalControlRequest = z.infer<typeof personalControlRequestSchema>
export type PersonalControlReceipt = z.infer<typeof personalControlReceiptSchema>

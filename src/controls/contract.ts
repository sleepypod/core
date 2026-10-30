import { z } from 'zod'

export const MAX_CONTROL_LIFETIME_MS = 60_000
const timestamp = z.number().int().positive().max(8_640_000_000_000_000)
const side = z.enum(['left', 'right'])
const temperature = z.number().int().min(55).max(110)

export const controlActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('temperature'), side, temperature, holdMinutes: z.number().int().min(1).max(1440).optional() }).strict(),
  z.object({ kind: z.literal('power'), side, powered: z.boolean(), temperature: temperature.optional() }).strict(),
  z.object({ kind: z.literal('vibration'), side, intensity: z.number().int().min(1).max(100), pattern: z.enum(['rise', 'double']), duration: z.number().int().min(10).max(180) }).strict(),
  z.object({ kind: z.literal('vibration.clear'), side }).strict(),
  z.object({ kind: z.literal('base.position'), head: z.number().int().min(0).max(60), feet: z.number().int().min(0).max(45), feedRate: z.number().int().min(30).max(100).default(50) }).strict(),
  z.object({ kind: z.literal('base.stop') }).strict(),
])

export const controlRequestSchema = z.object({
  requestId: z.uuid(),
  issuedAt: timestamp,
  expiresAt: timestamp,
  action: controlActionSchema,
}).strict().refine(request => request.expiresAt > request.issuedAt && request.expiresAt - request.issuedAt <= MAX_CONTROL_LIFETIME_MS, {
  message: 'Control lifetime must be greater than zero and at most 60 seconds',
  path: ['expiresAt'],
})

export const controlStateSchema = z.enum(['executing', 'acknowledged', 'not_dispatched', 'rejected', 'expired', 'unknown'])
export const controlReceiptSchema = z.object({
  version: z.literal(1),
  requestId: z.uuid(),
  action: controlActionSchema,
  issuedAt: timestamp,
  expiresAt: timestamp,
  receivedAt: timestamp,
  finishedAt: timestamp.nullable(),
  lastDispatchAt: timestamp.nullable(),
  state: controlStateSchema,
  reason: z.string().nullable(),
  dispatchCount: z.number().int().nonnegative(),
  physicalVerification: z.literal('unverified'),
  replayAllowed: z.literal(false),
})

export type ControlRequest = z.infer<typeof controlRequestSchema>
export type ControlAction = z.infer<typeof controlActionSchema>
export type ControlReceipt = z.infer<typeof controlReceiptSchema>

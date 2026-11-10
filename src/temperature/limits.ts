import { z } from 'zod'
import type { TemperatureRequest } from './controller'

export const comfortLimitConfigSchema = z.object({
  enabled: z.boolean(), minF: z.number().int().min(55).max(110), maxF: z.number().int().min(55).max(110),
}).strict().refine(value => value.maxF >= value.minF && value.maxF - value.minF <= 10,
  'Choose an ordered comfort range no wider than 10°F')
export type ComfortLimitConfig = z.infer<typeof comfortLimitConfigSchema>
export const defaultComfortLimit: ComfortLimitConfig = { enabled: false, minF: 68, maxF: 72 }
export const comfortLimitVersionSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), config: comfortLimitConfigSchema,
})
export type ComfortLimitVersion = z.infer<typeof comfortLimitVersionSchema>
export const comfortLimitDecisionSchema = z.object({
  state: z.enum(['disabled', 'within_range', 'limited', 'wake', 'manual', 'unavailable']),
  requestedF: z.number(), targetF: z.number().nullable(),
  minF: z.number().nullable(), maxF: z.number().nullable(), revision: z.number().nullable(),
  wakeUntil: z.number().nullable(),
})
export type ComfortLimitDecision = z.infer<typeof comfortLimitDecisionSchema>
const side = z.enum(['left', 'right'])
export const comfortLimitPageSchema = comfortLimitVersionSchema.extend({
  apiVersion: z.literal(1), side, sourceSide: side,
  wake: z.object({ startsAt: z.number(), alarmAt: z.number(), targetF: z.number(), timeZone: z.string() }).nullable(),
  wakeAvailable: z.boolean(),
})
export const comfortLimitWriteSchema = z.object({
  side, expectedSourceSide: side, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  config: comfortLimitConfigSchema,
}).strict()

/** Manual intent is explicit; every automatic producer shares the same persisted limit. */
export function resolveComfortLimit(request: TemperatureRequest | null, requestedF: number,
  version: ComfortLimitVersion | null, trustedWake: boolean): ComfortLimitDecision {
  const base = { requestedF, targetF: requestedF, minF: version?.config.minF ?? null,
    maxF: version?.config.maxF ?? null, revision: version?.revision ?? null, wakeUntil: null }
  if (request?.source === 'manual') return { ...base, state: 'manual' }
  if (!version) return { ...base, state: 'unavailable', targetF: null }
  if (!version.config.enabled) return { ...base, state: 'disabled' }
  if (trustedWake && request?.source === 'schedule') return { ...base, state: 'wake', wakeUntil: request.expiresAt }
  const targetF = Math.min(version.config.maxF, Math.max(version.config.minF, requestedF))
  return { ...base, targetF, state: targetF === requestedF ? 'within_range' : 'limited' }
}

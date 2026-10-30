import { z } from 'zod'

export const MECHANICAL_CONTEXT_VERSION = 'mechanical-context-v1' as const
export const MECHANICAL_FRESH_MS = 10_000
export const MECHANICAL_SETTLE_MS = 10_000
export const MECHANICAL_RETENTION_MS = 35 * 86400000
export const MECHANICAL_MAX_SPANS = 20_000
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const mechanicalKindSchema = z.enum(['priming', 'vibration', 'base'])
export type MechanicalKind = z.infer<typeof mechanicalKindSchema>
export const mechanicalReasonSchema = z.enum(['priming', 'vibration_command', 'base_motion', 'device_unavailable', 'base_unavailable', 'alarm_state_unavailable', 'settling', 'controller_restart', 'controller_stopped', 'clock_regression', 'observation_gap'])
export type MechanicalReason = z.infer<typeof mechanicalReasonSchema>
export const mechanicalStateSchema = z.object({
  version: z.literal(MECHANICAL_CONTEXT_VERSION), epoch: z.string().uuid(),
  publishedAtMs: timestamp, confirmedThroughMs: timestamp.nullable(), validUntilMs: timestamp,
  blockedUntilMs: timestamp, cleanSinceMs: timestamp.nullable(), spanId: z.string().uuid().nullable(),
  reasons: z.array(mechanicalReasonSchema).min(0).max(12),
  commandAtMs: timestamp.nullable(), commandUntilMs: timestamp,
}).strict().refine(state => (state.cleanSinceMs === null) === (state.spanId === null), 'Quiet-span identity mismatch')
  .refine(state => state.confirmedThroughMs === null || state.confirmedThroughMs <= state.publishedAtMs, 'Future mechanical observation')
  .refine(state => state.cleanSinceMs === null
    ? state.reasons.length > 0
    : state.reasons.length === 0 && state.confirmedThroughMs !== null
      && state.blockedUntilMs <= state.cleanSinceMs && state.cleanSinceMs <= state.confirmedThroughMs
      && state.validUntilMs === state.confirmedThroughMs + MECHANICAL_FRESH_MS, 'Invalid quiet evidence')
export type MechanicalState = z.infer<typeof mechanicalStateSchema>

export interface MechanicalObservation {
  now: number
  deviceAt: number | null
  baseAt: number | null
  priming: boolean | null
  vibrationCommandActive: boolean | null
  baseMoving: boolean | null
}

/** Only actual source timestamps extend evidence; polling a cached value does not. */
export function mechanicalObservation(input: MechanicalObservation) {
  const now = timestamp.parse(input.now)
  const fresh = (at: number | null) => at !== null && Number.isSafeInteger(at) && at > 0 && at <= now && now - at < MECHANICAL_FRESH_MS
  const reasons: MechanicalReason[] = []
  if (!fresh(input.deviceAt) || typeof input.priming !== 'boolean') reasons.push('device_unavailable')
  else if (input.priming) reasons.push('priming')
  if (typeof input.vibrationCommandActive !== 'boolean') reasons.push('alarm_state_unavailable')
  else if (input.vibrationCommandActive) reasons.push('vibration_command')
  if (!fresh(input.baseAt) || typeof input.baseMoving !== 'boolean') reasons.push('base_unavailable')
  else if (input.baseMoving) reasons.push('base_motion')
  const observedAt = reasons.length || input.deviceAt === null || input.baseAt === null ? null : Math.min(input.deviceAt, input.baseAt)
  return { now, reasons, observedAt }
}

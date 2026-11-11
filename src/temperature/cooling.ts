import { z } from 'zod'
import type { Side } from '@/src/hardware/types'

export const COOLING_DURATION_MS = 20 * 60_000
export const COOLING_RETURN_WINDOW_MS = 5 * 60_000
export const COOLING_SOURCE_MAX_AGE_MS = 30_000
const instant = z.number().int().nonnegative().max(8_640_000_000_000_000)
const temperature = z.number().int().min(55).max(110)

export const coolingLeaseSchema = z.object({
  version: z.literal(1), id: z.uuid(), side: z.enum(['left', 'right']), scope: z.string().min(1).max(128),
  fromTargetF: temperature, targetF: temperature,
  startedAt: instant, expiresAt: instant, sessionEndsAt: instant,
  phase: z.enum(['prepared', 'active', 'returning', 'unknown']),
}).strict().refine(value => value.targetF < value.fromTargetF && value.fromTargetF - value.targetF <= 2
  && value.expiresAt > value.startedAt && value.expiresAt - value.startedAt <= COOLING_DURATION_MS
  && value.sessionEndsAt >= value.expiresAt, 'Invalid temporary cooling boundaries')
export type CoolingLease = z.infer<typeof coolingLeaseSchema>

export interface CoolingContext {
  /** Changes with the household/physical-side arrangement, never a display name. */
  scope: string
  observedAt: number | null
  available: boolean
  readyToStart: boolean
  reason: string
  sessionEndsAt: number | null
  /** Includes an active warm-up/hold; null means there is no upcoming wake span. */
  wakeStartsAt: number | null
}

export interface CoolingPersistence {
  read: (side: Side) => CoolingLease | null
  write: (side: Side, lease: CoolingLease | null) => void
  /** Atomically records the explicit warm feedback and initial, unacknowledged intent. */
  begin: (lease: CoolingLease) => void
  context: (side: Side, now: number) => CoolingContext
}

export const coolingPageSchema = z.object({
  apiVersion: z.literal(1), side: z.enum(['left', 'right']), generatedAt: instant,
  state: z.enum(['ready', 'cooling', 'waiting', 'unknown', 'unavailable']), reason: z.string(),
  observedAt: instant.nullable(),
  proposal: z.object({ scope: z.string(), fromTargetF: temperature, targetF: temperature, expiresAt: instant }).nullable(),
  lease: coolingLeaseSchema.nullable(),
  physicalVerification: z.literal('unverified'),
})
export type CoolingPage = z.infer<typeof coolingPageSchema>

export function freshCoolingContext(context: CoolingContext, now: number): boolean {
  return context.available && context.observedAt !== null && Number.isSafeInteger(context.observedAt)
    && context.observedAt <= now && now - context.observedAt < COOLING_SOURCE_MAX_AGE_MS
    && context.sessionEndsAt !== null && context.sessionEndsAt > now
}

/** Fixed, modest changes end before the wake span and cannot extend a live session. */
export function coolingProposal(context: CoolingContext, targetF: number | null, now: number) {
  if (!context.readyToStart || !freshCoolingContext(context, now) || context.sessionEndsAt === null || targetF === null || !Number.isInteger(targetF) || targetF <= 55 || targetF > 110) return null
  const expiresAt = Math.min(now + COOLING_DURATION_MS, context.sessionEndsAt, context.wakeStartsAt ?? Infinity)
  if (expiresAt - now < 60_000) return null
  return { scope: context.scope, fromTargetF: targetF, targetF: Math.max(55, targetF - 2), expiresAt }
}

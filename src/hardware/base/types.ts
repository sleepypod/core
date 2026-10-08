import { z } from 'zod'

export const BASE_LIMITS = { head: 60, feet: 45, minSpeed: 30 } as const
/**
 * Per-side (one-sided) movement stays locked until a TriMix firmware dump confirms the
 * per-side motor selectors. While false, every status source (hardware, the hosted demo
 * and ?debug=1) reports whole-bed control, so the per-side layouts stay hidden and
 * one-sided moves and schedules are rejected.
 */
export const INDEPENDENT_CONTROL_UNLOCKED = false
export const BASE_SIDES = ['left', 'right'] as const
export type BaseSide = typeof BASE_SIDES[number]
export const baseScopeSchema = z.enum(['both', 'left', 'right'])
export type BaseScope = z.infer<typeof baseScopeSchema>
export const scopeSides = (scope: BaseScope): BaseSide[] => scope === 'both' ? [...BASE_SIDES] : [scope]
export const BASE_DAYS = ['daily', 'weekdays', 'weekends', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
export const baseDaysSchema = z.enum(BASE_DAYS)
export const baseDayNumbers = (days: typeof BASE_DAYS[number]): number[] => days === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : days === 'weekdays' ? [1, 2, 3, 4, 5] : days === 'weekends' ? [0, 6] : [BASE_DAYS.indexOf(days) - 3]

export const basePositionSchema = z.object({
  head: z.number().int().min(0).max(BASE_LIMITS.head),
  feet: z.number().int().min(0).max(BASE_LIMITS.feet),
  feedRate: z.number().int().min(BASE_LIMITS.minSpeed).max(100).default(50),
})
export const baseMoveSchema = basePositionSchema.extend({
  sides: z.array(z.enum(BASE_SIDES)).min(1).max(2).refine(sides => new Set(sides).size === sides.length, 'Duplicate sides').default(['left', 'right']),
})
export type BaseMove = z.input<typeof baseMoveSchema>
export type BasePosition = z.infer<typeof basePositionSchema>
export const basePresetSchema = z.enum(['flat', 'sleep', 'relax', 'read'])
export const BASE_PRESETS: Record<z.infer<typeof basePresetSchema>, BasePosition> = {
  flat: { head: 0, feet: 0, feedRate: 50 },
  sleep: { head: 1, feet: 5, feedRate: 50 },
  relax: { head: 30, feet: 15, feedRate: 50 },
  read: { head: 40, feet: 0, feedRate: 50 },
}
export const baseConfigurationSchema = z.object({
  Address: z.string().regex(/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/).transform(s => s.toUpperCase()),
  SplitBase: z.boolean(),
})
export type BaseConfiguration = z.infer<typeof baseConfigurationSchema>
export const baseStatusSchema = z.object({
  state: z.enum(['unconfigured', 'connecting', 'connected', 'disconnected', 'error']),
  independentControl: z.boolean(),
  movingBySide: z.object({ left: z.boolean().nullable(), right: z.boolean().nullable() }),
  splitBase: z.boolean().nullable(),
  position: z.object({
    left: z.object({ head: z.number(), feet: z.number() }),
    right: z.object({ head: z.number(), feet: z.number() }),
  }).nullable(),
  lastUpdate: z.number().nullable(),
  stale: z.boolean(),
  moving: z.boolean().nullable(),
  busy: z.boolean(),
  error: z.string().nullable(),
})
export type BaseStatus = z.infer<typeof baseStatusSchema>
export class BaseError extends Error {
  constructor(public readonly code: 'unavailable' | 'busy' | 'cancelled', message: string) {
    super(message)
    this.name = 'BaseError'
  }
}
export interface BaseTransport {
  connect(config: BaseConfiguration, onData: (bytes: Uint8Array) => void, onDisconnect: (error: Error) => void): Promise<void>
  write(packet: Uint8Array): Promise<void>
  close(): void
}

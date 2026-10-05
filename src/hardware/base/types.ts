import { z } from 'zod'

export const basePositionSchema = z.object({
  head: z.number().int().min(0).max(60),
  feet: z.number().int().min(0).max(45),
  feedRate: z.number().int().min(30).max(100).default(50),
})
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

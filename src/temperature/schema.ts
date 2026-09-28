import { z } from 'zod'

export const temperatureControlStatusSchema = z.object({
  source: z.enum(['manual', 'run-once', 'autopilot', 'schedule']).nullable(),
  requestId: z.string().nullable(),
  targetTemperature: z.number().nullable(),
  holdUntil: z.number().nullable(),
  blocked: z.enum(['safety', 'off']).nullable(),
})

/** Separate from hardware duration: this controls temperature ownership only. */
export const holdMinutesSchema = z.number().int().min(1).max(1440)

import { z } from 'zod'

export const recordingCheckSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(['ok', 'attention', 'unknown']),
  detail: z.string(),
  nextStep: z.string().nullable(),
  observedAt: z.number().int().nonnegative().nullable(),
})

export const recordingHealthSchema = z.object({
  apiVersion: z.literal(1),
  generatedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  state: z.enum(['ready', 'attention', 'unknown']),
  summary: z.string(),
  checks: z.array(recordingCheckSchema),
  historicalWindowHours: z.literal(24),
})

export type RecordingCheck = z.infer<typeof recordingCheckSchema>
export type RecordingHealth = z.infer<typeof recordingHealthSchema>

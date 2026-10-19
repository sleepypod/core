import { z } from 'zod'

export const recordingPolicySchema = z.object({
  loggingMode: z.enum(['quiet', 'off']).default('quiet'),
  debugUntil: z.number().int().nonnegative().nullable().default(null),
  healthHistory: z.boolean().default(true),
  rawArchive: z.boolean().default(true),
})
export type RecordingPolicy = z.infer<typeof recordingPolicySchema>
export const DEFAULT_RECORDING_POLICY: RecordingPolicy = recordingPolicySchema.parse({})
export const recordingChangeSchema = z.object({
  loggingMode: z.enum(['quiet', 'off']).optional(),
  debug: z.boolean().optional(),
  healthHistory: z.boolean().optional(),
  rawArchive: z.boolean().optional(),
}).strict()
export type RecordingChange = z.infer<typeof recordingChangeSchema>

export function effectiveLoggingMode(policy: RecordingPolicy, now = Date.now()): 'quiet' | 'off' | 'debug' {
  return policy.debugUntil != null && policy.debugUntil > now ? 'debug' : policy.loggingMode
}

export function changeRecordingPolicy(policy: RecordingPolicy, change: RecordingChange, now = Date.now()): RecordingPolicy {
  return {
    loggingMode: change.loggingMode ?? policy.loggingMode,
    debugUntil: change.debug === true
      ? now + 15 * 60_000
      : change.debug === false || change.loggingMode != null ? null : policy.debugUntil,
    healthHistory: change.healthHistory ?? policy.healthHistory,
    rawArchive: change.rawArchive ?? policy.rawArchive,
  }
}

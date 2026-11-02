import { z } from 'zod'
import type { ComfortContext, ComfortState } from './policy'
import type { PreviewEvidence } from './report-contract'
import { currentBedroomGuidance } from '@/src/bedroom/fusion'
import { thermalContextSchema } from './thermal-learning'

export const thermalObservationSchema = z.object({
  version: z.literal(1), purpose: z.literal('comfort_research'),
  bedroomConfiguration: z.string().regex(/^[a-f0-9]{64}$/),
  sleepWindowEnd: z.number().int().positive().optional(),
}).strict()

/** Record observed thermal conditions independently of HR readiness, never control eligibility. */
export function thermalObservation(state: ComfortState, context: ComfortContext, preview: PreviewEvidence | undefined) {
  const { now, window, device } = context
  if (state.config.mode !== 'preview' || !state.config.roomAware || !preview
    || preview.environment !== 'production' || !preview.buildRevision || !preview.hardwareIdentity
    || !preview.deviceFresh || !preview.mechanicallyQuiet || preview.manualPaused
    || preview.presence !== 'occupied' || !preview.presenceSourceKey
    || !window || now < window.start || now >= window.end
    || (window.alarmAt !== null && (!Number.isFinite(window.alarmAt) || now >= window.alarmAt - 30 * 60_000))
    || context.eitherAway !== false || context.routinesPaused !== false || context.alarmOverride !== false
    || context.targetKnown !== true || device.powered !== true || device.waterAdequate !== true
    || !currentBedroomGuidance(context.bedroom, now)) return null
  const thermal = thermalContextSchema.safeParse(context.thermalContext)
  if (!thermal.success || thermal.data.targetF !== device.targetF
    || thermal.data.targetF < state.config.minimumF || thermal.data.targetF > state.config.maximumF) return null
  const receipt = thermalObservationSchema.safeParse({ version: 1, purpose: 'comfort_research',
    bedroomConfiguration: context.bedroom?.configuration,
    sleepWindowEnd: Math.min(window.end, window.alarmAt === null ? window.end : window.alarmAt - 30 * 60_000) })
  return receipt.success ? receipt.data : null
}

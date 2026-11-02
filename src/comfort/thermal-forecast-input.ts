import { comfortEventSchema } from './contract'
import { thermalConfiguration } from './thermal-dataset'
import { forecastInputSchema } from './thermal-forecast'
import type { ThermalContext } from './thermal-learning'
import { currentBedroomGuidance } from '@/src/bedroom/fusion'

/** Read a preceding observed delta from the same quiet session; no interpolation across missing data. */
export function previousForecastInput(previous: unknown, current: { at: number, session: string, configuration: string, context: ThermalContext }, recordedAt: number | null) {
  const parsed = comfortEventSchema.safeParse(previous)
  if (!parsed.success) return null
  const event = parsed.data, evidence = event.preview, thermal = event.thermalContext
  if (!Number.isSafeInteger(current.at) || event.at !== recordedAt || !evidence || !thermal || event.kind !== 'preview' || event.session !== current.session
    || evidence.session !== current.session || evidence.environment !== 'production'
    || event.at < evidence.start || event.at >= evidence.end || current.at >= evidence.end
    || evidence.presence !== 'occupied' || !evidence.deviceFresh || !evidence.mechanicallyQuiet || evidence.manualPaused
    || (!event.eligible && !event.thermalObservation) || thermal.targetF !== current.context.targetF
    || Math.abs(current.at - event.at - 300_000) > 30_000
    || thermalConfiguration(evidence, event.thermalObservation?.bedroomConfiguration ?? evidence.bedroom?.configuration ?? null) !== current.configuration) return null
  if (event.thermalObservation && (!currentBedroomGuidance(evidence.bedroom, event.at)
    || evidence.bedroom?.configuration !== event.thermalObservation.bedroomConfiguration
    || current.at >= (event.thermalObservation.sleepWindowEnd ?? evidence.end))) return null
  const input = forecastInputSchema.safeParse({ ...current.context,
    change5mF: (current.context.waterF - thermal.waterF) * 300_000 / (current.at - event.at) })
  return input.success ? input.data : null
}

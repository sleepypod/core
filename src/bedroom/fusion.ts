import { BEDROOM_METRICS, type BedroomAggregate, type BedroomMetric, type BedroomObservation, type BedroomComfortGuidance } from './contract'

const roomMetrics: BedroomMetric[] = ['temperature', 'humidity', 'pm25', 'co2', 'airQuality']

/** Recheck the room lease at the decision point, including while a previous target is in cooldown. */
export function currentBedroomGuidance(input: BedroomComfortGuidance | null | undefined, now: number): boolean {
  return input?.state === 'ready' && input.configuration !== null && /^[a-f0-9]{64}$/.test(input.configuration)
    && Number.isInteger(input.offsetF) && Math.abs(input.offsetF) <= 1 && input.sourceIds.length > 0
    && input.expiresAt !== null && Number.isSafeInteger(input.expiresAt) && now < input.expiresAt
    && input.expiresAt - now <= 900_000
}

/** Independent physical devices vote once. Conflicting climate readings never become a control signal. */
export function combineBedroomSensors(observations: BedroomObservation[], now: number): BedroomAggregate[] {
  return roomMetrics.map((metric) => {
    const definition = BEDROOM_METRICS[metric]
    const independent = new Map<string, { sourceId: string, value: number, expiresAt: number }>()
    for (const observation of observations) {
      if (observation.source.metric !== metric || observation.status !== 'fresh' || !observation.controlEligible
        || !observation.source.enabled || !observation.source.useForControl
        || observation.value === null || !Number.isFinite(observation.value) || observation.expiresAt === null
        || observation.expiresAt <= now || observation.observedAt === null || observation.observedAt > now) continue
      if (!independent.has(observation.source.deviceId)) independent.set(observation.source.deviceId, {
        sourceId: observation.source.id, value: observation.value, expiresAt: observation.expiresAt,
      })
    }
    const contributors = [...independent.values()]
    const values = contributors.map(item => item.value).sort((first, second) => first - second)
    const maximum = values.at(-1) ?? null
    const spread = maximum === null ? null : maximum - values[0]
    const disagreement = spread !== null && definition.disagreement !== null && spread > definition.disagreement
    const middle = Math.floor(values.length / 2)
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
    // Air-quality metrics keep the worst qualified reading; categorical AQ is not a particulate concentration.
    const value = metric === 'temperature' || metric === 'humidity' ? median : maximum
    return {
      metric, unit: definition.unit, value: values.length && !disagreement ? value : null,
      status: !values.length ? 'unavailable' : disagreement ? 'disagreement' : 'ready',
      sourceIds: contributors.map(item => item.sourceId), spread,
      expiresAt: contributors.length ? Math.min(...contributors.map(item => item.expiresAt)) : null,
    }
  })
}

/** A bounded room contribution to the existing comfort controller, never a hardware command. */
export function bedroomComfortGuidance(aggregates: BedroomAggregate[], now: number, configuration: string | null = null): BedroomComfortGuidance {
  const temperature = aggregates.find(item => item.metric === 'temperature')
  const humidity = aggregates.find(item => item.metric === 'humidity')
  const inputs = [temperature, humidity]
  const sourceIds = inputs.flatMap(item => item?.sourceIds ?? [])
  if (inputs.some(item => item?.status === 'disagreement')) return {
    state: 'disagreement', offsetF: 0, reason: 'Bedroom sensors disagree. Room-based adjustments are withheld.', sourceIds, expiresAt: null, configuration,
  }
  if (!temperature || !humidity || temperature.status !== 'ready' || humidity.status !== 'ready'
    || temperature.value === null || humidity.value === null || temperature.expiresAt === null || humidity.expiresAt === null
    || now >= temperature.expiresAt || now >= humidity.expiresAt) return {
    state: 'unavailable', offsetF: 0, reason: 'Waiting for qualified bedroom temperature and humidity.', sourceIds, expiresAt: null, configuration,
  }
  const temperatureF = temperature.value
  const humidityPercent = humidity.value
  const offsetF = temperatureF > 75 || (temperatureF >= 72 && humidityPercent > 65) ? -1 : temperatureF < 64 ? 1 : 0
  return {
    state: 'ready', offsetF, sourceIds, expiresAt: Math.min(temperature.expiresAt, humidity.expiresAt), configuration,
    reason: offsetF === -1
      ? 'Warm bedroom conditions suggest a one-degree cooler comfort target.'
      : offsetF === 1
        ? 'Cool bedroom conditions suggest a one-degree warmer comfort target.'
        : 'Bedroom conditions do not add a temperature adjustment.',
  }
}

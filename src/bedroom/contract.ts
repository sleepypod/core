import { z } from 'zod'

export const BEDROOM_METRICS = {
  temperature: { label: 'Temperature', unit: '°F', units: ['°C', '°F'], minimum: -40, maximum: 140, disagreement: 4 },
  humidity: { label: 'Humidity', unit: '%', units: ['%'], minimum: 0, maximum: 100, disagreement: 15 },
  pm25: { label: 'Fine particles', unit: 'µg/m³', units: ['µg/m³', 'μg/m³'], minimum: 0, maximum: 2000, disagreement: null },
  co2: { label: 'Carbon dioxide', unit: 'ppm', units: ['ppm'], minimum: 0, maximum: 10000, disagreement: null },
  airQuality: { label: 'Air quality', unit: 'category', units: ['category'], minimum: 1, maximum: 5, disagreement: null },
  power: { label: 'Power', unit: 'on/off', units: ['on/off'], minimum: 0, maximum: 1, disagreement: null },
  fanSpeed: { label: 'Fan speed', unit: '%', units: ['%'], minimum: 0, maximum: 100, disagreement: null },
  filterLife: { label: 'Filter remaining', unit: '%', units: ['%'], minimum: 0, maximum: 100, disagreement: null },
} as const

export const bedroomMetricSchema = z.enum(['temperature', 'humidity', 'pm25', 'co2', 'airQuality', 'power', 'fanSpeed', 'filterLife'])
export type BedroomMetric = z.infer<typeof bedroomMetricSchema>
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/)
const timestamp = z.number().int().positive().max(8_000_000_000_000)
export const bedroomSourceSchema = z.object({
  id: identifier,
  deviceId: identifier,
  deviceName: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  provider: z.enum(['home_assistant', 'homebridge', 'apple_home']),
  externalId: z.string().trim().min(1).max(180),
  model: z.string().trim().max(80).default(''),
  location: z.enum(['left', 'right', 'room']).default('room'),
  metric: bedroomMetricSchema,
  unit: z.enum(['°C', '°F', '%', 'µg/m³', 'μg/m³', 'ppm', 'category', 'on/off']),
  maxAgeSeconds: z.number().int().min(30).max(900),
  enabled: z.boolean(),
  useForControl: z.boolean().default(false),
}).strict().superRefine((source, context) => {
  if (!(BEDROOM_METRICS[source.metric].units as readonly string[]).includes(source.unit)) {
    context.addIssue({ code: 'custom', path: ['unit'], message: 'Unit does not match the sensor measurement.' })
  }
})
export type BedroomSource = z.infer<typeof bedroomSourceSchema>

export const bedroomConfigSchema = z.object({
  enabled: z.boolean(),
  roomName: z.string().trim().min(1).max(60),
  sources: z.array(bedroomSourceSchema).max(40),
}).strict().superRefine((config, context) => {
  const identities = config.sources.map(source => source.id)
  const physicalMetrics = config.sources.map(source => `${source.deviceId}/${source.metric}`)
  const externalIds = config.sources.map(source => `${source.provider}/${source.externalId}`)
  if ([identities, physicalMetrics, externalIds].some(values => new Set(values).size !== values.length)) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'Each sensor and each physical-device measurement must be mapped once.' })
  }
})
export type BedroomConfig = z.infer<typeof bedroomConfigSchema>
export const defaultBedroomConfig: BedroomConfig = { enabled: false, roomName: 'Bedroom', sources: [] }

/** A successful query is not a new measurement. Publishers must identify the clock they actually have. */
export const bedroomReportSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive(), sourceId: identifier,
  available: z.boolean(), value: z.number().finite().nullable(),
  observedAt: timestamp, measuredAt: timestamp.nullable(),
  timeBasis: z.enum(['measurement', 'device_read', 'integration_report', 'cached']),
}).strict().superRefine((report, context) => {
  if (report.available !== (report.value !== null)
    || (report.measuredAt !== null && report.measuredAt > report.observedAt)
    || (report.available && report.timeBasis === 'measurement' && report.measuredAt === null)
    || (!report.available && report.measuredAt !== null)) {
    context.addIssue({ code: 'custom', message: 'Availability, value and measurement timestamps disagree.' })
  }
})
export type BedroomReport = z.infer<typeof bedroomReportSchema>

export const bedroomObservationSchema = z.object({
  source: bedroomSourceSchema,
  status: z.enum(['disabled', 'waiting', 'unavailable', 'stale', 'cached', 'fresh']),
  value: z.number().nullable(), lastValue: z.number().nullable(), unit: z.string(),
  observedAt: timestamp.nullable(), measuredAt: timestamp.nullable(), receivedAt: timestamp.nullable(), expiresAt: timestamp.nullable(),
  timeBasis: bedroomReportSchema.shape.timeBasis.nullable(),
  controlEligible: z.boolean(),
})
export type BedroomObservation = z.infer<typeof bedroomObservationSchema>
export const bedroomAggregateSchema = z.object({
  metric: bedroomMetricSchema, unit: z.string(), value: z.number().nullable(),
  status: z.enum(['ready', 'disagreement', 'unavailable']),
  sourceIds: z.array(identifier), spread: z.number().nullable(), expiresAt: timestamp.nullable(),
})
export type BedroomAggregate = z.infer<typeof bedroomAggregateSchema>
export const bedroomGuidanceSchema = z.object({
  state: z.enum(['ready', 'unavailable', 'disagreement']),
  offsetF: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  reason: z.string(), sourceIds: z.array(identifier), expiresAt: timestamp.nullable(),
  configuration: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
})
export type BedroomComfortGuidance = z.infer<typeof bedroomGuidanceSchema>
export const bedroomStatusSchema = z.object({
  apiVersion: z.literal(1), generatedAt: timestamp, revision: z.number().int().nonnegative(),
  config: bedroomConfigSchema, observations: z.array(bedroomObservationSchema), aggregates: z.array(bedroomAggregateSchema),
  guidance: bedroomGuidanceSchema,
  mqtt: z.object({ connected: z.boolean(), topic: z.string().nullable() }).optional(),
})

import { z } from 'zod'

export const ROOM_METRICS = {
  temperature: { label: 'Room temperature', unit: '°F', units: ['°C', '°F'], min: -40, max: 140 },
  humidity: { label: 'Room humidity', unit: '%', units: ['%'], min: 0, max: 100 },
  co2: { label: 'Carbon dioxide', unit: 'ppm', units: ['ppm'], min: 0, max: 10000 },
  pm25: { label: 'Fine particles', unit: 'µg/m³', units: ['µg/m³', 'μg/m³'], min: 0, max: 2000 },
  light: { label: 'Room light', unit: 'lx', units: ['lx', 'lux'], min: 0, max: 200000 },
} as const
export const metricSchema = z.enum(['temperature', 'humidity', 'co2', 'pm25', 'light'])
export type RoomMetric = z.infer<typeof metricSchema>
const timestamp = z.number().int().positive().max(8_000_000_000_000)
export const mappingSchema = z.object({
  metric: metricSchema,
  entityId: z.string().regex(/^sensor\.[a-z0-9_]{1,100}$/),
  unit: z.enum(['°C', '°F', '%', 'ppm', 'µg/m³', 'μg/m³', 'lx', 'lux']),
  timestampAttribute: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
  timestampFormat: z.enum(['iso8601', 'unix_seconds', 'unix_milliseconds']),
  maxAgeSeconds: z.number().int().min(30).max(900),
}).strict().refine(mapping => (ROOM_METRICS[mapping.metric].units as readonly string[]).includes(mapping.unit), 'Unit does not match the measurement')
export const roomConfigSchema = z.object({
  enabled: z.boolean(),
  roomName: z.string().trim().min(1).max(60),
  mappings: z.array(mappingSchema).max(5),
}).strict().superRefine((config, context) => {
  if (config.enabled && !config.mappings.length) context.addIssue({ code: 'custom', message: 'Select a sensor before enabling room input', path: ['mappings'] })
  for (const key of ['metric', 'entityId'] as const) {
    if (new Set(config.mappings.map(mapping => mapping[key])).size !== config.mappings.length) {
      context.addIssue({ code: 'custom', message: `Each ${key} must be unique`, path: ['mappings'] })
    }
  }
})
export type RoomConfig = z.infer<typeof roomConfigSchema>
export const defaultRoomConfig: RoomConfig = { enabled: false, roomName: 'Bedroom', mappings: [] }
export const configVersionSchema = z.object({ revision: z.number().int().nonnegative(), config: roomConfigSchema })
export const roomReportSchema = z.object({
  schemaVersion: z.literal(1), source: z.literal('home_assistant'),
  revision: z.number().int().positive(), metric: metricSchema,
  entityId: mappingSchema.shape.entityId, unit: mappingSchema.shape.unit,
  reportedAt: timestamp, measuredAt: timestamp.nullable(),
  available: z.boolean(), value: z.number().finite().nullable(),
}).strict().refine(report => report.available
  ? report.value !== null && report.measuredAt !== null && report.measuredAt <= report.reportedAt
  : report.value === null && report.measuredAt === null, 'Measurement and availability disagree')

export const roomObservationSchema = z.object({
  metric: metricSchema, entityId: z.string(), unit: z.string(),
  value: z.number().nullable(), lastValue: z.number().nullable(),
  measuredAt: timestamp.nullable(), reportedAt: timestamp.nullable(), receivedAt: timestamp.nullable(), expiresAt: timestamp.nullable(),
  status: z.enum(['fresh', 'disabled', 'disconnected', 'waiting', 'unavailable', 'stale', 'clock_invalid']),
})
export const roomStatusSchema = z.object({
  apiVersion: z.literal(1), generatedAt: timestamp, revision: z.number().int().nonnegative(), config: roomConfigSchema,
  connected: z.boolean(), topic: z.string().nullable(), observations: z.array(roomObservationSchema),
})
export const historyItemSchema = roomObservationSchema.pick({ metric: true, entityId: true, unit: true, measuredAt: true, reportedAt: true, receivedAt: true })
  .extend({ id: z.number().int().positive(), revision: z.number().int().positive(), value: z.number().nullable(), available: z.boolean(), reportedAt: timestamp, receivedAt: timestamp })
export const ROOM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const ROOM_HISTORY_LIMIT = 25000

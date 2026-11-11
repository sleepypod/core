import { z } from 'zod'

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000)
const identifier = z.string().min(1).max(200)
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)
export const nightQuerySchema = z.object({ side: z.enum(['left', 'right']), wakeDate: localDate.optional() }).strict()
export const nightSourceKeySchema = z.enum(['applications', 'decisions', 'rules', 'thermal', 'room'])
export type NightSourceKey = z.infer<typeof nightSourceKeySchema>
export const nightSourceSchema = z.object({
  key: nightSourceKeySchema, status: z.enum(['read', 'empty', 'partial', 'unavailable']),
  rowsRead: z.number().int().nonnegative(), discarded: z.number().int().nonnegative(), truncated: z.boolean(),
  note: z.string().max(1000),
})
export const nightEventSchema = z.object({
  id: identifier, source: nightSourceKeySchema, at: timestamp, through: timestamp, count: z.number().int().positive(),
  scope: z.enum(['left', 'right', 'unassigned']),
  kind: z.enum(['acknowledged', 'unconfirmed', 'preview', 'withheld', 'feedback', 'configuration', 'rule_output']),
  title: z.string().min(1).max(160), detail: z.string().max(2400),
  targetF: z.number().min(55).max(110).nullable(), reportedF: z.number().min(32).max(130).nullable(),
  owner: z.enum(['manual', 'run-once', 'autopilot', 'schedule']).nullable(),
  evidence: z.enum(['controller_receipt', 'policy_evaluation', 'rule_evaluation']),
}).refine(value => value.through >= value.at)
export type NightEvent = z.infer<typeof nightEventSchema>
export const nightThermalSchema = z.object({
  id: z.number().int().positive(), at: timestamp, powered: z.boolean(),
  targetF: z.number().min(55).max(110).nullable(), reportedF: z.number().min(32).max(130).nullable(),
})
export const nightRoomSchema = z.object({
  id: z.number().int().positive(), sourceId: identifier, revision: z.number().int().positive(),
  label: z.string().max(180), metric: z.enum(['temperature', 'humidity', 'pm25', 'co2', 'airQuality']),
  value: z.number().finite().nullable(), unit: z.string().max(20),
  receivedAt: timestamp, observedAt: timestamp, measuredAt: timestamp.nullable(),
  timeBasis: z.enum(['measurement', 'device_read', 'integration_report', 'cached']),
})
export const nightExplanationSchema = z.object({
  apiVersion: z.literal(1), generatedAt: timestamp, side: z.enum(['left', 'right']), wakeDate: localDate,
  timeZone: z.string().min(1).max(100).refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value })
      return true
    }
    catch { return false }
  }), start: timestamp, end: timestamp, observedThrough: timestamp,
  attribution: z.literal('physical_zone_only'),
  events: z.array(nightEventSchema).max(600), eventsTruncated: z.boolean(),
  thermal: z.array(nightThermalSchema).max(3000), room: z.array(nightRoomSchema).max(2000),
  roomSampleIntervalMs: z.literal(300_000), roomTruncated: z.boolean(),
  sources: z.array(nightSourceSchema).length(5),
}).superRefine((value, context) => {
  if (value.end <= value.start || value.end - value.start > 26 * 3600_000
    || value.observedThrough < value.start || value.observedThrough > value.generatedAt || value.observedThrough > value.end
    || new Set(value.sources.map(source => source.key)).size !== 5
    || value.events.some(event => event.at < value.start || event.through > value.observedThrough || (event.scope !== value.side && event.scope !== 'unassigned'))
    || value.thermal.some(sample => sample.at < value.start || sample.at > value.observedThrough)
    || value.room.some(sample => sample.receivedAt < value.start || sample.receivedAt > value.observedThrough
      || sample.observedAt > sample.receivedAt || (sample.measuredAt !== null && sample.measuredAt > sample.observedAt))) {
    context.addIssue({ code: 'custom', message: 'Night evidence has inconsistent bounds or source identity' })
  }
})
export type NightExplanation = z.infer<typeof nightExplanationSchema>

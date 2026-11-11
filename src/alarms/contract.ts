import { z } from 'zod'

const side = z.enum(['left', 'right'])
const instant = z.iso.datetime({ offset: true })
const revision = z.string().regex(/^[a-f0-9]{64}$/)
export const nextAlarmReadSchema = z.object({ side }).strict()
// One object keeps the REST/OpenAPI input portable. The service enforces which
// fields each action may contain, as well as the occurrence/revision checks.
export const nextAlarmWriteSchema = z.object({
  side, action: z.enum(['skip', 'time', 'restore']), expectedRevision: revision,
  expectedAt: instant.optional(), expectedExpiresAt: instant.optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
}).strict()
export type NextAlarmWrite = z.infer<typeof nextAlarmWriteSchema>

export const occurrenceSchema = z.object({
  scheduleIds: z.array(z.number().int().positive()).min(1), at: instant, originalAt: instant,
  time: z.string(), source: z.enum(['routine', 'override']),
  duration: z.number(), wakeWindow: z.number(), alarmTemperatureF: z.number(),
})
export const nextAlarmSchema = z.object({
  apiVersion: z.literal(1), side, timeZone: z.string(), revision,
  state: z.enum(['scheduled', 'skipped', 'none', 'away']),
  alarm: occurrenceSchema.nullable(), followingAt: instant.nullable(),
  canChange: z.boolean(), reason: z.string(),
  execution: z.enum(['attempting', 'acknowledged', 'unknown']).nullable(),
  warming: z.object({ startsAt: instant, endsAt: instant, earliestVibrationAt: instant, targetF: z.number().min(55).max(110) }).nullable().optional(),
  acknowledgment: z.literal('accepted_not_physically_verified'),
  change: z.object({
    revision: z.uuid(), status: z.enum(['active', 'expired', 'invalidated']),
    originalAt: instant, at: instant.nullable(), expiresAt: instant,
  }).nullable(),
})
export type NextAlarm = z.infer<typeof nextAlarmSchema>
export const laterAlarmPreviewInputSchema = z.object({
  side, expectedRevision: revision, expectedAt: instant,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
}).strict()
export type LaterAlarmPreviewInput = z.infer<typeof laterAlarmPreviewInputSchema>
export const laterAlarmPreviewSchema = z.object({
  apiVersion: z.literal(1), effect: z.literal('preview_only'), generatedAt: instant, expiresAt: instant,
  before: nextAlarmSchema,
  proposed: z.object({
    at: instant, time: z.string(), duration: z.number(), wakeWindow: z.number(), targetF: z.number(),
    warmingStartsAt: instant, earliestVibrationAt: instant, warmingEndsAt: instant, changeExpiresAt: instant,
  }),
  request: nextAlarmWriteSchema,
  weeklyScheduleChanged: z.literal(false), externalDevices: z.literal('not_included'),
})
export type LaterAlarmPreview = z.infer<typeof laterAlarmPreviewSchema>
export const laterAlarmApplySchema = z.object({ preview: laterAlarmPreviewSchema }).strict()
export class NextAlarmError extends Error {
  constructor(message: string, readonly code: 'BAD_REQUEST' | 'CONFLICT' | 'PRECONDITION_FAILED') { super(message) }
}

import { z } from 'zod'
import { temperatureApplicationSchema } from '@/src/temperature/applications'
import { thermalContextSchema } from './thermal-learning'
import type { ThermalRecording } from './thermal-dataset'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value, 'Invalid calendar date')
const instant = z.number().int().positive().max(8_640_000_000_000_000)
export const responseSampleSchema = z.object({
  at: instant, powered: z.boolean(), targetF: z.number().finite().min(55).max(110).nullable(),
  waterF: z.number().finite().min(40).max(120).nullable(),
}).strict()
export type ResponseSample = z.infer<typeof responseSampleSchema>
export type ResponseApplication = z.infer<typeof temperatureApplicationSchema>
export const RESPONSE_BEFORE_MS = 10 * 60_000
export const RESPONSE_AFTER_MS = 30 * 60_000

export const responseWindowSchema = z.object({
  date, attemptId: z.string().uuid(), at: instant,
  acknowledgedAt: instant, confirmationAt: instant, beforeAt: instant,
  previousTargetF: thermalContextSchema.shape.targetF, requestedTargetF: thermalContextSchema.shape.targetF, waterBeforeF: thermalContextSchema.shape.waterF,
  waterChange5mF: z.number().finite(), roomF: thermalContextSchema.shape.roomF, humidity: thermalContextSchema.shape.humidity, contextAt: instant,
  outcomes: z.array(z.object({ minutes: z.union([z.literal(15), z.literal(30)]),
    at: instant, waterF: thermalContextSchema.shape.waterF, changeF: z.number().finite() }).strict()).length(2),
}).strict()
export type ResponseWindow = z.infer<typeof responseWindowSchema>
export type ResponseResult = { window: ResponseWindow, reason: null } | { window: null, reason: string }

/** Audit observed small target steps. Inputs precede dispatch; later readings are labels, never features. */
export function assessResponseWindow(recording: ThermalRecording, application: ResponseApplication,
  applications: ResponseApplication[], samples: ResponseSample[], now: number): ResponseResult {
  const reject = (reason: string): ResponseResult => ({ window: null, reason })
  const parsed = temperatureApplicationSchema.safeParse(application)
  if (!Number.isSafeInteger(now) || now <= 0 || now > 8_640_000_000_000_000 || !parsed.success) return reject('The command receipt or evaluation clock is invalid.')
  const command = parsed.data, start = command.attemptedAt - RESPONSE_BEFORE_MS, end = command.attemptedAt + RESPONSE_AFTER_MS
  if (command.outcome !== 'acknowledged' || command.finishedAt === null || command.finishedAt > command.attemptedAt + 30_000
    || end >= now || command.acknowledgment !== 'accepted_not_physically_verified') return reject('The acknowledged command and complete 30-minute outcome must be in the past.')
  if (command.reason !== 'reconcile' || !['schedule', 'autopilot'].includes(command.source ?? '')
    || command.comfortLimit?.state === 'wake') return reject('Only ordinary scheduled or automatic changes are studied; manual, power-on and wake requests are excluded.')
  if (recording.samples.length < 72 || recording.samples.length > 300 || !date.safeParse(recording.date).success
    || recording.samples.some((sample, index) => !instant.safeParse(sample.at).success || !thermalContextSchema.safeParse(sample.context).success
      || (index > 0 && sample.at <= recording.samples[index - 1].at))) return reject('The reviewed night has invalid thermal observations.')
  const contexts = recording.samples.filter(sample => sample.at >= start - 330_000 && sample.at <= end + 330_000)
  const context = contexts.filter(sample => sample.at < command.attemptedAt).at(-1)
  if (!context || command.attemptedAt - context.at > 330_000 || contexts[0]?.at > start
    || (contexts.at(-1)?.at ?? 0) < end || contexts.some((sample, index) => index > 0 && sample.at - contexts[index - 1].at > 330_000)) {
    return reject('The complete response window needs quiet occupied room observations without a five-minute gap.')
  }
  if (contexts.some(sample => Math.abs(sample.context.roomF - context.context.roomF) > 2
    || Math.abs(sample.context.humidity - context.context.humidity) > 10)) return reject('Room conditions changed too much during this response window.')
  if (samples.length > 300 || samples.some((sample, index) => !responseSampleSchema.safeParse(sample).success
    || sample.at < start - 90_000 || sample.at > end + 90_000 || sample.at > now
    || (index > 0 && (sample.at <= samples[index - 1].at || sample.at - samples[index - 1].at > 90_000)))) {
    return reject('Water readings have invalid clocks, duplicate times or a gap over 90 seconds.')
  }
  const before = samples.filter(sample => sample.at < command.attemptedAt).at(-1)
  const preceding = before && samples.filter(sample => sample.at <= before.at - 300_000).at(-1)
  const confirmed = samples.find(sample => sample.at >= (command.finishedAt ?? Infinity) && sample.targetF === command.targetF)
  if (!before || !preceding || !confirmed || samples[0]?.at > start || (samples.at(-1)?.at ?? 0) < end
    || command.attemptedAt - before.at > 90_000 || before.at - preceding.at > 390_000
    || confirmed.at - command.finishedAt > 90_000 || before.waterF === null || preceding.waterF === null || before.targetF === null) {
    return reject('Actual preceding water readings and timely firmware confirmation are missing.')
  }
  const step = command.targetF - before.targetF
  if (Math.abs(step) !== 1 || context.context.targetF !== before.targetF) return reject('The recorded target must change by exactly 1°F from the preceding known target.')
  if (samples.some(sample => !sample.powered || sample.waterF === null || sample.targetF === null
    || (sample.at < command.attemptedAt && sample.targetF !== before.targetF)
    || (sample.at >= confirmed.at && sample.targetF !== command.targetF)
    || (sample.at >= command.attemptedAt && sample.at < confirmed.at && sample.targetF !== before.targetF && sample.targetF !== command.targetF))) {
    return reject('Power, target or water readings do not describe one uninterrupted target step.')
  }
  if (applications.filter(other => other.attemptId === command.attemptId).length !== 1) return reject('The source command must have one unique receipt.')
  for (const other of applications) {
    const receipt = temperatureApplicationSchema.safeParse(other)
    if (!receipt.success || other.side !== command.side) return reject('A neighboring command receipt is invalid.')
    if (other.attemptId === command.attemptId) {
      if (JSON.stringify(receipt.data) !== JSON.stringify(command)) return reject('The source command receipt is inconsistent.')
      continue
    }
    if (other.attemptedAt < start || other.attemptedAt > end) continue
    const expected = other.attemptedAt < command.attemptedAt ? before.targetF : command.targetF
    if (other.outcome !== 'acknowledged' || other.reason !== 'keepalive' || other.targetF !== expected
      || other.finishedAt === null || other.finishedAt > other.attemptedAt + 30_000 || other.finishedAt > now) {
      return reject('Another change or unresolved command overlaps this response window.')
    }
  }
  const outcomes: ResponseWindow['outcomes'] = []
  for (const minutes of [15, 30] as const) {
    const intendedAt = command.attemptedAt + minutes * 60_000
    const outcome = [...samples].sort((first, second) => Math.abs(first.at - intendedAt) - Math.abs(second.at - intendedAt))[0]
    if (!outcome || Math.abs(outcome.at - intendedAt) > 45_000 || outcome.waterF === null) return reject('An actual 15- or 30-minute outcome is missing.')
    outcomes.push({ minutes, at: outcome.at, waterF: outcome.waterF, changeF: outcome.waterF - before.waterF })
  }
  return { reason: null, window: responseWindowSchema.parse({ date: recording.date, attemptId: command.attemptId,
    at: command.attemptedAt, acknowledgedAt: command.finishedAt, confirmationAt: confirmed.at, beforeAt: before.at,
    previousTargetF: before.targetF, requestedTargetF: command.targetF, waterBeforeF: before.waterF,
    waterChange5mF: (before.waterF - preceding.waterF) * 300_000 / (before.at - preceding.at),
    roomF: context.context.roomF, humidity: context.context.humidity, contextAt: context.at, outcomes }) }
}

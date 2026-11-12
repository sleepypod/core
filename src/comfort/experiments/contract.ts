import { z } from 'zod'
import { dateInTimeZone, isValidTimeZone } from '@/src/lib/timeZoneDate'

export const experimentHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const experimentInstantSchema = z.number().int().nonnegative().max(8_640_000_000_000_000)
export const experimentDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
)
const temperature = z.number().int().min(55).max(110)
const count = z.number().int().nonnegative().max(100_000)
const duration = z.number().int().nonnegative().max(26 * 3_600_000)

// These are versioned product choices, not validated clinical thresholds.
export const EXPERIMENT_PAIRS = 4
export const EXPERIMENT_NIGHTS = EXPERIMENT_PAIRS * 4
export const EXPERIMENT_MINIMUM_PAIRS = 3
export const EXPERIMENT_MINIMUM_EXPOSURE_MS = 4 * 3_600_000
export const EXPERIMENT_MINIMUM_TARGET_FRACTION = 0.9
export const EXPERIMENT_MEANINGFUL_COMFORT_DIFFERENCE = 1
export const EXPERIMENT_REVIEW_MS = 5 * 60_000
export const EXPERIMENT_SCHEDULE_DAYS = 63

/** Captured by the server from the current person's assignment and approved policy. */
export const experimentContextSchema = z.object({
  subjectKey: experimentHashSchema,
  bindingHash: experimentHashSchema,
  routineHash: experimentHashSchema,
  wakeHash: experimentHashSchema,
  timezone: z.string().max(100).refine(isValidTimeZone),
  baselineF: temperature,
  minimumF: temperature,
  maximumF: temperature,
}).strict().refine(value => value.minimumF <= value.baselineF && value.baselineF <= value.maximumF,
  'The baseline must be inside the current overnight range.')
export type ExperimentContext = z.infer<typeof experimentContextSchema>

export const experimentProposalSchema = z.object({
  firstNightDate: experimentDateSchema,
  variantF: temperature,
}).strict()

export const experimentWindowSchema = z.object({
  date: experimentDateSchema,
  powerScheduleId: z.number().int().positive(),
  windowStart: experimentInstantSchema,
  windowEnd: experimentInstantSchema,
  routineEnd: experimentInstantSchema,
  endAction: z.enum(['turn_off', 'maintain']),
  wake: z.object({
    at: experimentInstantSchema,
    startsAt: experimentInstantSchema,
    temperatureF: z.number().min(55).max(110),
    vibrationSeconds: z.number().int().min(0).max(180),
    source: z.enum(['routine', 'override']),
  }).strict().nullable(),
}).strict().refine(value => value.windowEnd - value.windowStart >= EXPERIMENT_MINIMUM_EXPOSURE_MS
  && value.routineEnd >= value.windowEnd && value.routineEnd - value.windowStart <= 26 * 3_600_000
  && (value.wake === null || (value.wake.startsAt === value.windowEnd && value.wake.at >= value.wake.startsAt)),
'An experiment window must be bounded by its routine and end before wake warming.')
export type ExperimentWindow = z.infer<typeof experimentWindowSchema>

export const experimentScheduleSchema = z.object({
  requestedFirstNightDate: experimentDateSchema,
  windows: z.array(experimentWindowSchema).length(EXPERIMENT_NIGHTS),
  skipped: z.array(z.object({
    date: experimentDateSchema,
    reason: z.enum(['not_scheduled', 'already_started', 'unbounded_routine', 'overlapping_routines',
      'wake_overlap', 'conflicting_alarms', 'too_short', 'needs_following_night']),
  }).strict()).max(EXPERIMENT_SCHEDULE_DAYS),
}).strict()
export type ExperimentSchedule = z.infer<typeof experimentScheduleSchema>

const planFields = {
  id: z.string().uuid(),
  createdAt: experimentInstantSchema,
  context: experimentContextSchema,
  firstNightDate: experimentDateSchema,
  variantF: temperature,
  orders: z.array(z.enum(['baseline_first', 'variant_first'])).length(EXPERIMENT_PAIRS),
}

/** Version 1 remains readable; all new API reviews bind exact scheduled windows in version 2. */
export const experimentPlanSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...planFields }).strict(),
  z.object({ version: z.literal(2), ...planFields, schedule: experimentScheduleSchema }).strict(),
]).superRefine((value, issue) => {
  const difference = Math.abs(value.variantF - value.context.baselineF)
  if (difference < 1 || difference > 2 || value.variantF < value.context.minimumF || value.variantF > value.context.maximumF)
    issue.addIssue({ code: 'custom', message: 'Compare a setting 1–2°F away within the current overnight range.' })
  if (value.orders.filter(order => order === 'baseline_first').length !== EXPERIMENT_PAIRS / 2)
    issue.addIssue({ code: 'custom', message: 'The saved plan must balance both period orders.' })
  const earliest = dateInTimeZone(value.createdAt, value.context.timezone)
  if (value.firstNightDate < earliest || Date.parse(value.firstNightDate) - Date.parse(earliest) > 30 * 86_400_000)
    issue.addIssue({ code: 'custom', message: 'Start within the next thirty local dates.' })
  if (value.version !== 2) return
  const { windows, skipped, requestedFirstNightDate } = value.schedule
  if (windows.length !== EXPERIMENT_NIGHTS) return
  const lastDate = windows[windows.length - 1].date
  const dates = [...windows.map(window => window.date), ...skipped.map(day => day.date)].sort()
  if (requestedFirstNightDate < earliest || requestedFirstNightDate > value.firstNightDate
    || windows[0].date !== value.firstNightDate
    || Date.parse(lastDate) - Date.parse(requestedFirstNightDate) >= EXPERIMENT_SCHEDULE_DAYS * 86_400_000
    || dates[0] !== requestedFirstNightDate || dates[dates.length - 1] !== lastDate
    || dates.some((date, index) => index > 0 && Date.parse(date) - Date.parse(dates[index - 1]) !== 86_400_000))
    issue.addIssue({ code: 'custom', message: 'Every calendar date must be scheduled once or explicitly skipped.' })
  for (const [index, window] of windows.entries()) {
    const previous = windows[index - 1]
    if (window.windowStart < value.createdAt || dateInTimeZone(window.windowStart, value.context.timezone) !== window.date
      || (previous && (window.date <= previous.date || window.windowStart < previous.routineEnd))
      || (index % 2 === 1 && Date.parse(window.date) - Date.parse(previous.date) !== 86_400_000))
      issue.addIssue({ code: 'custom', message: 'Settling and scored nights need consecutive, nonoverlapping scheduled windows.' })
  }
})
export type ExperimentPlan = z.infer<typeof experimentPlanSchema>
export type ExperimentArm = 'baseline' | 'variant'
export interface ExperimentNight {
  date: string
  pair: number
  period: number
  role: 'settling' | 'scored'
  arm: ExperimentArm
  targetF: number
}

/** Collector-only evidence. Browser feedback must never supply these measurements. */
export const experimentExposureSchema = z.object({
  nightDate: experimentDateSchema,
  recordedAt: experimentInstantSchema,
  planHash: experimentHashSchema,
  bindingHash: experimentHashSchema,
  routineHash: experimentHashSchema,
  wakeHash: experimentHashSchema,
  sourceHash: experimentHashSchema,
  sourceState: z.enum(['current', 'withdrawn']),
  execution: z.enum(['preview', 'active']),
  windowStart: experimentInstantSchema,
  windowEnd: experimentInstantSchema,
  // The experiment's window ends before wake warming; the alarm owns its own window.
  wakeStartsAt: experimentInstantSchema.nullable(),
  targetF: temperature,
  observedMs: duration,
  matchedTargetMs: duration,
  occupiedMs: duration,
  // Intersection of fresh, occupied and assigned-target intervals, not the sum of separate totals.
  qualifiedMs: duration,
  manualChanges: count,
  unconfirmedCommands: count,
  safetyInterruptions: count,
  attributionAmbiguous: z.boolean(),
}).strict().superRefine((value, issue) => {
  const windowMs = value.windowEnd - value.windowStart
  if (windowMs <= 0 || windowMs > 26 * 3_600_000 || value.recordedAt < value.windowEnd
    || value.observedMs > windowMs || value.matchedTargetMs > value.observedMs || value.occupiedMs > value.observedMs
    || value.qualifiedMs > Math.min(value.matchedTargetMs, value.occupiedMs))
    issue.addIssue({ code: 'custom', message: 'Exposure clocks and nonoverlapping duration totals must be consistent.' })
})
export type ExperimentExposure = z.infer<typeof experimentExposureSchema>

export const experimentFeedbackSchema = z.object({
  nightDate: experimentDateSchema,
  recordedAt: experimentInstantSchema,
  confirmedFullNight: z.boolean(),
  comfort: z.number().int().min(0).max(10),
  unwantedAdjustments: count,
  // A report of a problem is an outcome, never grounds for silently excluding a bad night.
  problem: z.boolean(),
}).strict()
export type ExperimentFeedback = z.infer<typeof experimentFeedbackSchema>

export const experimentRecordSchema = z.object({
  plan: experimentPlanSchema,
  revision: z.string().uuid(),
  updatedAt: experimentInstantSchema,
  status: z.enum(['planned', 'stopped']),
  stoppedAt: experimentInstantSchema.nullable(),
  exposures: z.array(experimentExposureSchema).max(EXPERIMENT_NIGHTS),
  feedback: z.array(experimentFeedbackSchema).max(EXPERIMENT_NIGHTS),
}).strict().superRefine((value, issue) => {
  if (value.updatedAt < value.plan.createdAt || (value.status === 'stopped') !== (value.stoppedAt !== null)
    || (value.stoppedAt !== null && (value.stoppedAt < value.plan.createdAt || value.stoppedAt > value.updatedAt)))
    issue.addIssue({ code: 'custom', message: 'Experiment lifecycle clocks are inconsistent.' })
  for (const items of [value.exposures, value.feedback]) {
    if (new Set(items.map(item => item.nightDate)).size !== items.length || items.some(item => item.recordedAt > value.updatedAt))
      issue.addIssue({ code: 'custom', message: 'Night records must be unique and cannot come from the future.' })
  }
})
export type ExperimentRecord = z.infer<typeof experimentRecordSchema>

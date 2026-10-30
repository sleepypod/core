import type { BedEntrySample, BedtimeSelection, BedtimeStatus } from './bedtime'
import type { ComfortSignals } from './signals'
import type { ComfortApplication } from './application-contract'
import type { BedroomComfortGuidance } from '@/src/bedroom/contract'
import { currentBedroomGuidance } from '@/src/bedroom/fusion'
import type { ThermalContext } from './thermal-learning'

/** Personal comfort policy ported from the owner's Free Sleep thermal/policy.ts.
 * Pure decisions only: persistence and hardware belong to the shared controller.
 */
export const MANUAL_PAUSE_MS = 6 * 60 * 60_000
export const ADJUSTMENT_INTERVAL_MS = 30 * 60_000
export const DEVICE_MAX_AGE_MS = 15_000
export const PRESENCE_MAX_AGE_MS = 90_000
export const VITAL_MAX_AGE_MS = 360_000

export interface ComfortConfig {
  mode: 'off' | 'preview' | 'active'
  minimumF: number
  maximumF: number
  sensorAware?: boolean
  followBedtime?: boolean
  roomAware?: boolean
}

/** Field names preserve the Free Sleep learner's migration cursors. Times are epoch milliseconds. */
export interface ComfortState {
  config: ComfortConfig
  offsetF: number
  feedbackThrough: string
  learnedSession: string
  pausedUntil: number
  lastAppliedAt: number
  lastTargetF: number | null
  lastSegment: string
  bedtime?: BedtimeSelection
  application?: ComfortApplication
}

/** The schedule adapter must resolve one unambiguous, timezone-aware power window. */
export interface RoutineWindow {
  session: string
  segment: string
  start: number
  end: number
  baselineF: number
  alarmAt: number | null
  scheduledBaselineF?: number
  phases?: { revision: string, startF: number, changes: { id: string, at: number, temperatureF: number }[] }
}

export interface ComfortFeedback {
  date: string
  comfort: 'warm' | 'cold' | 'comfortable'
}

export interface ComfortContext {
  now: number
  window: RoutineWindow | null
  device: {
    observedAt: number | null
    powered: boolean
    offConfirmed?: boolean
    waterAdequate: boolean | null
    priming: boolean
    vibrating: boolean
    baseMoving: boolean | null
    targetF: number | null
  }
  presence: { observedAt: number | null, available: boolean, occupied: boolean, entry?: BedEntrySample }
  eitherAway: boolean
  routinesPaused: boolean
  alarmOverride: boolean
  owner: 'manual' | 'run-once' | 'autopilot' | 'schedule' | null
  /** True only after comparing reported target with the routine or our own recorded acknowledgment. */
  targetKnown: boolean
  signals?: ComfortSignals
  bedroom?: BedroomComfortGuidance
  timing?: BedtimeStatus
  thermalContext?: ThermalContext | null
}

export interface ComfortDecision {
  eligible: boolean
  baselineF: number | null
  proposedF: number | null
  reason: string
  /** Only cooldown may retain the last guarded target; missing input must revoke it. */
  retainPreviousLease: boolean
  /** The runtime must persist the six-hour pause before publishing another proposal. */
  pauseRequired: boolean
}

export function defaultComfortState(): ComfortState {
  return {
    config: { mode: 'off', minimumF: 70, maximumF: 95 },
    offsetF: 0, feedbackThrough: '', learnedSession: '', pausedUntil: 0,
    lastAppliedAt: 0, lastTargetF: null, lastSegment: '',
  }
}

function fresh(observedAt: number | null, now: number, maximumAge: number): boolean {
  return observedAt !== null && Number.isFinite(observedAt)
    && now >= observedAt && now - observedAt <= maximumAge
}

function validState(state: ComfortState): boolean {
  const { config } = state
  return ['off', 'preview', 'active'].includes(config.mode)
    && (config.sensorAware === undefined || typeof config.sensorAware === 'boolean')
    && (config.followBedtime === undefined || typeof config.followBedtime === 'boolean')
    && (config.roomAware === undefined || typeof config.roomAware === 'boolean')
    && Number.isInteger(config.minimumF) && Number.isInteger(config.maximumF)
    && config.minimumF >= 55 && config.maximumF <= 110 && config.minimumF <= config.maximumF
    && Number.isInteger(state.offsetF) && Math.abs(state.offsetF) <= 3
    && Number.isFinite(state.pausedUntil) && state.pausedUntil >= 0
    && Number.isFinite(state.lastAppliedAt) && state.lastAppliedAt >= 0
}

/** All inputs are observations, never instructions from an LLM or a room sensor. */
export function decideComfort(state: ComfortState, context: ComfortContext): ComfortDecision {
  const { now, window, device, presence } = context
  const baselineF = window && Number.isFinite(window.baselineF) ? window.baselineF : null
  const stop = (reason: string, pauseRequired = false): ComfortDecision => ({
    eligible: false, baselineF, proposedF: null, reason, retainPreviousLease: false, pauseRequired,
  })
  if (!Number.isFinite(now) || !validState(state)) return stop('Comfort settings or clock are invalid.')
  if (state.config.mode === 'off') return stop('Adaptive comfort is off.')
  if (state.config.mode === 'active' && state.application && state.application.outcome !== 'acknowledged') {
    return stop('A previous comfort command is unconfirmed. Review its application evidence before enabling further adjustments.')
  }
  if (state.pausedUntil > now) return stop('Paused for six hours after a manual control. Your routine continues.')
  if (context.owner === 'manual' || context.owner === 'run-once') return stop('Your manual control or run-once routine has priority.')
  if (context.eitherAway !== false) return stop('Paused while either side is in away mode.')
  if (!window || !Number.isFinite(window.start) || !Number.isFinite(window.end)
    || window.start > now || window.end <= now || baselineF === null) {
    return stop('Waiting for one enabled routine with a clear start and end.')
  }
  if (baselineF < state.config.minimumF || baselineF > state.config.maximumF) return stop('Routine target is outside your comfort limits.')
  if (context.routinesPaused !== false) return stop('Temperature routines are paused.')
  if (context.alarmOverride !== false) return stop('An alarm override is active.')
  if (window.alarmAt !== null && (!Number.isFinite(window.alarmAt) || now >= window.alarmAt - 30 * 60_000)) {
    return stop('Leaving the alarm window to your routine.')
  }
  if (!fresh(device.observedAt, now, DEVICE_MAX_AGE_MS)) return stop('Waiting for fresh Pod status.')
  if (device.baseMoving === null) return stop('Waiting for confirmed idle base telemetry. Unconfigured does not mean absent.')
  if (device.priming !== false || device.vibrating !== false || device.baseMoving !== false) {
    return stop('Paused during priming, vibration or base movement.')
  }
  if (device.waterAdequate !== true) return stop('Waiting for a confirmed adequate water level.')
  if (device.powered !== true) return stop('Your side is off. Adaptive comfort never turns it on.')
  if (presence.available !== true || !fresh(presence.observedAt, now, PRESENCE_MAX_AGE_MS)) return stop('Waiting for fresh calibrated presence readings.')
  if (presence.occupied !== true) return stop('Waiting until your side is occupied.')
  if (device.targetF === null || !Number.isFinite(device.targetF) || device.targetF < 55 || device.targetF > 110) return stop('Waiting for a reported temperature target.')
  if (context.targetKnown !== true) return stop('An unexpected target change requires a six-hour adaptive pause.', true)
  if (state.config.sensorAware) {
    const signals = context.signals
    if (!signals || signals.state !== 'ready' || !fresh(signals.sampleAt, now, VITAL_MAX_AGE_MS) || signals.expiresAt === null || !Number.isSafeInteger(signals.expiresAt) || now >= signals.expiresAt) {
      return stop(signals?.state === 'ready'
        ? 'Pod vital estimates expired before this check.'
        : signals?.reason ?? 'Waiting for Pod vital estimates and a personal baseline.')
    }
  }
  if (state.config.followBedtime && (!state.config.sensorAware || context.timing?.state !== 'ready')) {
    return stop(context.timing?.reason ?? 'Waiting for qualified bed-entry timing.')
  }
  if (state.config.roomAware && !currentBedroomGuidance(context.bedroom, now)) {
    return stop(context.bedroom?.state === 'ready'
      ? 'Bedroom readings expired before this check.'
      : context.bedroom?.reason ?? 'Waiting for qualified bedroom temperature and humidity.')
  }
  const scheduledBaselineF = window.scheduledBaselineF ?? baselineF
  if (!Number.isFinite(scheduledBaselineF) || scheduledBaselineF < state.config.minimumF || scheduledBaselineF > state.config.maximumF) return stop('Original routine target is outside your comfort limits.')
  // Room context shares the learner's total three-degree budget and existing command authority.
  const offsetF = Math.max(-3, Math.min(3, state.offsetF + (state.config.roomAware ? context.bedroom?.offsetF ?? 0 : 0)))
  const desiredF = Math.max(state.config.minimumF, Math.min(state.config.maximumF, baselineF + offsetF))
  const proposedF = Math.max(device.targetF - 1, Math.min(device.targetF + 1, desiredF))
  if (proposedF < state.config.minimumF || proposedF > state.config.maximumF || Math.abs(proposedF - scheduledBaselineF) > 3) {
    return stop('Waiting for the routine target to enter your Autopilot limits.')
  }
  if (state.lastAppliedAt && (state.lastAppliedAt > now || now - state.lastAppliedAt < ADJUSTMENT_INTERVAL_MS)) {
    return {
      ...stop('Waiting between adjustments (30 minutes).'), proposedF,
      retainPreviousLease: state.config.mode === 'active' && state.lastAppliedAt <= now
        && state.lastSegment === window.segment && state.lastTargetF === device.targetF,
    }
  }
  return {
    eligible: true, baselineF, proposedF, retainPreviousLease: false, pauseRequired: false,
    reason: state.config.mode === 'preview'
      ? 'Preview only. Personal comfort will not change temperatures.'
      : state.config.roomAware
        ? `Following your routine and learned comfort. ${context.bedroom?.reason ?? ''}`
        : 'Following your routine with the learned comfort adjustment.',
  }
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}

export function comfortLocalDate(now: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

/** Consume each local-date check-in once, with at most one degree of learning per routine. */
export function learnComfort(state: ComfortState, feedback: ComfortFeedback[], session: string, timezone: string, now: number) {
  if (!validState(state) || !Number.isFinite(now) || !session || state.config.mode === 'off'
    || state.learnedSession === session || (state.feedbackThrough !== '' && !validDate(state.feedbackThrough))) {
    return { state, message: null }
  }
  let today: string
  try {
    today = comfortLocalDate(now, timezone)
  }
  catch { return { state, message: null } }
  const since = new Date(Date.parse(today) - 14 * 86_400_000).toISOString().slice(0, 10)
  const reports = [...new Map(feedback.filter(report => validDate(report.date)
    && report.date > state.feedbackThrough && report.date >= since && report.date <= today
    && ['warm', 'cold', 'comfortable'].includes(report.comfort)).map(report => [report.date, report])).values()]
    .sort((first, second) => first.date.localeCompare(second.date))
  const next = { ...state, learnedSession: session }
  const latestReport = reports.at(-1)
  if (reports.length < 3 || !latestReport) return { state: next, message: null }
  const threshold = Math.ceil(reports.length * 2 / 3)
  const warm = reports.filter(report => report.comfort === 'warm').length
  const cold = reports.filter(report => report.comfort === 'cold').length
  const change = warm >= threshold ? -1 : cold >= threshold ? 1 : 0
  next.offsetF = Math.max(-3, Math.min(3, state.offsetF + change))
  next.feedbackThrough = latestReport.date
  return { state: next, message: `Reviewed ${reports.length} new check-ins: ${warm} warm, ${cold} cold. Learned adjustment ${next.offsetF > 0 ? '+' : ''}${next.offsetF}°F.` }
}

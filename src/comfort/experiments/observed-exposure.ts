import { DEVICE_MAX_AGE_MS, PRESENCE_MAX_AGE_MS } from '../policy'
import { experimentDigest } from './access'
import { experimentExposureSchema, experimentPlanSchema, type ExperimentExposure, type ExperimentPlan } from './contract'
import { experimentAuthorityRequestId } from './exposure'
import { EXPERIMENT_OBSERVATION_INTERVAL_MS } from './observation-contract'
import type { RetainedExperimentWindow } from './observations'
import { experimentNightAt, experimentPlanHash } from './plan'

export interface ExperimentInterruptionSource {
  manualChanges: number
  unconfirmedCommands: number
  admissionInterrupted: boolean
  interruptedAt: number | null
  digest: string
}

/** Union physical-zone intervals, requiring every occupied zone to match; never sum both halves of one night. */
export function exposureFromObservations(input: ExperimentPlan, retained: RetainedExperimentWindow,
  interruptions: ExperimentInterruptionSource, recordedAt: number): ExperimentExposure {
  const plan = experimentPlanSchema.parse(input), { binding, observations } = retained
  const window = plan.version === 2 ? plan.schedule.windows.find(item => item.date === binding.nightDate) : null
  const night = window && experimentNightAt(plan, window.windowStart)
  if (!window || !night || retained.finalizedAt === null || recordedAt < retained.finalizedAt
    || binding.subjectKey !== plan.context.subjectKey || binding.planHash !== experimentPlanHash(plan)
    || binding.planId !== plan.id || binding.windowStart !== window.windowStart || binding.windowEnd !== window.windowEnd)
    throw new Error('Exposure needs a verified complete original observation window')
  const requestId = experimentAuthorityRequestId(plan, night.date)
  let observedMs = 0, matchedTargetMs = 0, occupiedMs = 0, qualifiedMs = 0, safetyInterruptions = 0
  let previousUnsafe = false
  for (const [index, packet] of observations.entries()) {
    const samples = packet.zones.map(zone => zone.sample)
    const start = Math.max(window.windowStart, packet.at)
    // A missing collector tick stays missing even if the preceding firmware sample has a longer TTL.
    const end = Math.min(window.windowEnd, interruptions.interruptedAt ?? window.windowEnd, packet.at + EXPERIMENT_OBSERVATION_INTERVAL_MS,
      observations[index + 1]?.at ?? window.windowEnd)
    if (end <= start) continue
    const boundaries = [...new Set([start, end, ...samples.flatMap(sample => [
      sample.deviceAt === null ? start : sample.deviceAt + DEVICE_MAX_AGE_MS,
      sample.presenceAt === null ? start : sample.presenceAt + PRESENCE_MAX_AGE_MS,
      sample.selectedUntil ?? start,
    ]).filter(at => at > start && at < end)])].sort((first, second) => first - second)
    const unsafe = samples.some(sample => sample.waterAdequate === false || sample.priming || sample.vibrating || sample.baseMoving === true)
    if (unsafe && !previousUnsafe) safetyInterruptions++
    previousUnsafe = unsafe
    for (let boundary = 0; boundary < boundaries.length - 1; boundary++) {
      const at = boundaries[boundary], duration = boundaries[boundary + 1] - at
      if (duration <= 0 || !samples.every(sample => sample.deviceAt !== null && at < sample.deviceAt + DEVICE_MAX_AGE_MS)) continue
      observedMs += duration
      const presenceKnown = samples.every(sample => sample.occupied !== null && sample.presenceAt !== null && at < sample.presenceAt + PRESENCE_MAX_AGE_MS)
      const occupied = presenceKnown ? samples.filter(sample => sample.occupied) : []
      // Empty intervals still establish target delivery, but cannot count as occupied treatment.
      const relevant = occupied.length ? occupied : samples
      const matched = presenceKnown && relevant.every(sample => sample.targetF === night.targetF)
      if (matched) matchedTargetMs += duration
      if (!occupied.length) continue
      occupiedMs += duration
      const qualified = matched && occupied.every(sample => sample.powered && sample.waterAdequate === true && !sample.priming
        && !sample.vibrating && sample.baseMoving === false && sample.selectedRequestId === requestId
        && sample.selectedUntil !== null && sample.selectedUntil !== undefined && at < sample.selectedUntil
        && sample.bindingHash === plan.context.bindingHash && sample.routineHash === plan.context.routineHash
        && sample.wakeHash === plan.context.wakeHash && !sample.attributionAmbiguous)
      if (qualified) qualifiedMs += duration
    }
  }
  const contextHash = (field: 'bindingHash' | 'routineHash' | 'wakeHash') => {
    const values = [...new Set([plan.context[field], ...observations.flatMap(packet => packet.zones.map(zone => zone.sample[field]))])].sort()
    return values.length === 1 ? values[0] : experimentDigest(values)
  }
  return experimentExposureSchema.parse({ nightDate: night.date, recordedAt, planHash: binding.planHash,
    bindingHash: contextHash('bindingHash'), routineHash: contextHash('routineHash'), wakeHash: contextHash('wakeHash'),
    sourceHash: experimentDigest({ observations: retained.sourceDigest, interruptions }), observationWindowId: binding.id,
    sourceState: 'current', execution: 'active', windowStart: window.windowStart, windowEnd: window.windowEnd,
    wakeStartsAt: window.wake?.startsAt ?? null, targetF: night.targetF, observedMs, matchedTargetMs, occupiedMs, qualifiedMs,
    manualChanges: interruptions.manualChanges, unconfirmedCommands: interruptions.unconfirmedCommands,
    safetyInterruptions: safetyInterruptions + Number(interruptions.admissionInterrupted),
    attributionAmbiguous: observations.some(packet => packet.zones.some(zone => zone.sample.attributionAmbiguous)) })
}

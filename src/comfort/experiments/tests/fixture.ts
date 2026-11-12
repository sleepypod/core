import { randomUUID } from 'node:crypto'
import type { ExperimentContext, ExperimentExposure, ExperimentPlan, ExperimentRecord } from '../contract'
import { createExperimentPlan, experimentNights, experimentPlanHash } from '../plan'
import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import { alarmRowSchema } from '@/src/alarms/model'
import type { ExperimentScheduleSource } from '../schedule'

export const createdAt = Date.parse('2026-11-12T12:00:00Z')
export const context: ExperimentContext = { subjectKey: 'a'.repeat(64), bindingHash: 'b'.repeat(64),
  routineHash: 'c'.repeat(64), wakeHash: 'd'.repeat(64), timezone: 'UTC', baselineF: 70, minimumF: 68, maximumF: 72 }

export function fixtureSchedule(days: DayOfWeek[] = [...DAYS_OF_WEEK], timezone = 'UTC'): ExperimentScheduleSource {
  return { powers: days.map((dayOfWeek, index) => ({ id: index + 1, dayOfWeek, onTime: '22:00', offTime: '07:15',
    offDayOffset: 1, onTemperature: 70, endAction: 'turn_off' as const })),
  alarm: { side: 'left', timeZone: timezone, available: true, configured: true, revision: null, override: null,
    rows: days.map((day, index) => alarmRowSchema.parse({ id: index + 1, side: 'left',
      dayOfWeek: DAYS_OF_WEEK[(DAYS_OF_WEEK.indexOf(day) + 1) % 7], time: '07:00', vibrationIntensity: 50,
      vibrationPattern: 'rise', duration: 20, alarmTemperature: 105, wakeWindow: 0, snoozeDuration: 300, snoozeTaper: 0 })) } }
}

export function fixturePlan(): ExperimentPlan {
  return createExperimentPlan(context, { firstNightDate: '2026-11-13', variantF: 69 }, createdAt, upper => upper - 1)
}

/** Synthetic exposure and subjective ratings exercise the protocol; they are not real Pod results. */
export function completeExperiment(): ExperimentRecord {
  const plan = fixturePlan()
  const exposures: ExperimentExposure[] = experimentNights(plan).map((night) => {
    const start = Date.parse(`${night.date}T22:00:00Z`), end = start + 8 * 3_600_000
    return { nightDate: night.date, recordedAt: end + 1000, planHash: experimentPlanHash(plan),
      bindingHash: context.bindingHash, routineHash: context.routineHash, wakeHash: context.wakeHash,
      sourceHash: 'e'.repeat(64), sourceState: 'current', execution: 'active', windowStart: start, windowEnd: end,
      wakeStartsAt: end + 30 * 60_000, targetF: night.targetF, observedMs: 8 * 3_600_000,
      matchedTargetMs: 8 * 3_600_000, occupiedMs: 8 * 3_600_000, qualifiedMs: 8 * 3_600_000, manualChanges: 0,
      unconfirmedCommands: 0, safetyInterruptions: 0, attributionAmbiguous: false }
  })
  const feedback = experimentNights(plan).map((night, index) => ({ nightDate: night.date,
    recordedAt: exposures[index].windowEnd + 2 * 3_600_000, confirmedFullNight: true,
    comfort: night.arm === 'baseline' ? 6 : 8, unwantedAdjustments: 0, problem: false }))
  return { plan, revision: randomUUID(), updatedAt: feedback[feedback.length - 1].recordedAt,
    status: 'planned', stoppedAt: null, exposures, feedback }
}

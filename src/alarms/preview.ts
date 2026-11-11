import { alarmWarmupMinutes } from '@/src/temperature/baseline'
import { laterAlarmPreviewInputSchema, laterAlarmPreviewSchema, NextAlarmError,
  type LaterAlarmPreviewInput, type LaterAlarmPreview, type NextAlarm } from './contract'
import { alarmHoldEnd, nextRoutineAlarm, resolveAlarmClock, selectedAlarm, type AlarmContext } from './model'

/** A read-only review of a later wake on the same date. Never starts timers or changes a routine. */
export function previewLaterAlarm(context: AlarmContext, before: NextAlarm, request: LaterAlarmPreviewInput, now: number): LaterAlarmPreview {
  const input = laterAlarmPreviewInputSchema.parse(request)
  if (!Number.isSafeInteger(now) || now <= 0) throw new NextAlarmError('The controller clock is unavailable.', 'PRECONDITION_FAILED')
  if (context.side !== input.side || before.side !== input.side || before.revision !== input.expectedRevision
    || before.alarm?.at !== input.expectedAt || !before.canChange || before.state !== 'scheduled') {
    throw new NextAlarmError('The next alarm changed. Refresh it before reviewing a later wake time.', 'CONFLICT')
  }
  const selected = selectedAlarm(context, now)
  if (!selected || !before.warming) throw new NextAlarmError('The saved wake plan is unavailable.', 'CONFLICT')
  const warmingStart = Date.parse(before.warming.startsAt)
  if (!Number.isFinite(warmingStart) || warmingStart <= now) {
    throw new NextAlarmError('Wake warming has already begun. Review the current alarm controls instead of postponing this plan.', 'CONFLICT')
  }
  const at = resolveAlarmClock(selected.at, input.time, context.timeZone)
  if (at <= selected.at) throw new NextAlarmError('Choose a later time on this alarm’s wake date.', 'BAD_REQUEST')
  const following = nextRoutineAlarm(context, selected.originalAt)
  if (following && at >= following.at) throw new NextAlarmError('This change would cross another scheduled alarm. Choose an earlier time or edit the weekly schedule.', 'BAD_REQUEST')
  const row = selected.rows[0]
  return laterAlarmPreviewSchema.parse({
    apiVersion: 1, effect: 'preview_only', generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(now + 90_000, warmingStart)).toISOString(), before,
    proposed: {
      at: new Date(at).toISOString(), time: input.time, duration: row.duration, wakeWindow: row.wakeWindow, targetF: row.alarmTemperature,
      warmingStartsAt: new Date(at - alarmWarmupMinutes(row.wakeWindow) * 60_000).toISOString(),
      earliestVibrationAt: new Date(at - row.wakeWindow * 60_000).toISOString(),
      warmingEndsAt: new Date(alarmHoldEnd(at, selected.rows)).toISOString(),
      changeExpiresAt: new Date(Math.max(alarmHoldEnd(selected.originalAt, selected.rows), alarmHoldEnd(at, selected.rows))).toISOString(),
    },
    request: { ...input, action: 'time' }, weeklyScheduleChanged: false, externalDevices: 'not_included',
  })
}

import { expect, it } from 'vitest'
import { alarmPlan } from '@/src/alarms/model'
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'
import { experimentPlanSchema } from '../contract'
import { resolveExperimentSchedule } from '../schedule'
import { createScheduledExperimentPlan, experimentNights, experimentNightAt, experimentPlanHash } from '../plan'
import { collectExperimentExposure } from '../exposure'
import { experimentExposureIssues } from '../analysis'
import { completeExperiment, context, createdAt, fixtureSchedule } from './fixture'

function required<Value>(value: Value | undefined | null): Value {
  if (value === undefined || value === null) throw new Error('Expected fixture value')
  return value
}

it('uses only Sunday–Thursday nights for Monday–Friday wakes, keeps 105°F/20 seconds and explains the skipped dates', () => {
  const source = fixtureSchedule(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday'], 'America/Los_Angeles')
  const before = JSON.stringify(source)
  const schedule = resolveExperimentSchedule(source, '2026-11-13', createdAt)
  const plan = createScheduledExperimentPlan({ ...context, timezone: source.alarm.timeZone }, 69, schedule, createdAt)
  expect(plan.version).toBe(2)
  expect(plan.firstNightDate).toBe('2026-11-15')
  expect(schedule.windows[15].date).toBe('2026-12-09')
  expect(schedule.windows).toHaveLength(16)
  expect(schedule.windows.every(window => !['friday', 'saturday'].includes(DAYS_OF_WEEK[new Date(window.date).getUTCDay()]))).toBe(true)
  expect(schedule.windows[0]).toMatchObject({ windowStart: Date.parse('2026-11-16T06:00:00Z'),
    windowEnd: Date.parse('2026-11-16T14:30:00Z'), routineEnd: Date.parse('2026-11-16T15:15:00Z'),
    wake: { at: Date.parse('2026-11-16T15:00:00Z'), temperatureF: 105, vibrationSeconds: 20 } })
  expect(schedule.skipped).toContainEqual({ date: '2026-11-13', reason: 'not_scheduled' })
  expect(schedule.skipped).toContainEqual({ date: '2026-11-19', reason: 'needs_following_night' })
  expect(experimentNights(plan).map(night => night.date)).toEqual(schedule.windows.map(window => window.date))
  expect(JSON.stringify(source)).toBe(before)
})

it('supports a weekend-only schedule with each settling/scored period kept together across week gaps', () => {
  const schedule = resolveExperimentSchedule(fixtureSchedule(['friday', 'saturday']), '2026-11-14', createdAt)
  expect(schedule.windows[0].date).toBe('2026-11-20')
  expect(schedule.windows[15].date).toBe('2027-01-09')
  expect(schedule.skipped[0]).toEqual({ date: '2026-11-14', reason: 'needs_following_night' })
  for (let index = 0; index < 16; index += 2)
    expect(Date.parse(schedule.windows[index + 1].date) - Date.parse(schedule.windows[index].date)).toBe(86_400_000)
})

it('does not infer overnight shutdown when the persisted weekday offset is zero', () => {
  const source = fixtureSchedule(['monday', 'tuesday'])
  for (const row of source.powers) row.offDayOffset = 0
  expect(() => resolveExperimentSchedule(source, '2026-11-13', createdAt)).toThrow('consecutive scheduled nights')
})

it('does not fill isolated nights, disabled schedules or missing power windows', () => {
  expect(() => resolveExperimentSchedule(fixtureSchedule(['monday', 'wednesday', 'friday']), '2026-11-13', createdAt)).toThrow('no new nights')
  const source = fixtureSchedule()
  source.powers = []
  expect(() => resolveExperimentSchedule(source, '2026-11-13', createdAt)).toThrow()
  source.powers = fixtureSchedule().powers
  source.alarm.available = false
  expect(() => resolveExperimentSchedule(source, '2026-11-13', createdAt)).toThrow('unavailable')
})

it.each([
  ['2026-10-30', '2026-10-29T12:00:00Z', '2026-10-31', 9.5],
  ['2026-03-06', '2026-03-05T12:00:00Z', '2026-03-07', 7.5],
])('uses elapsed DST time for %s instead of assuming a 24-hour date', (first, now, transition, hours) => {
  const schedule = resolveExperimentSchedule(fixtureSchedule([...DAYS_OF_WEEK], 'America/Los_Angeles'), first as string, Date.parse(now as string))
  const window = required(schedule.windows.find(value => value.date === transition))
  expect((window.windowEnd - window.windowStart) / 3_600_000).toBe(hours)
  expect(required(window.wake).at - window.windowEnd).toBe(30 * 60_000)
  expect(new Set(schedule.windows.map(value => value.date)).size).toBe(16)
})

it('fires an ambiguous autumn start once, and shifts a spring-gap start consistently with the scheduler', () => {
  for (const [date, expected] of [['2026-11-01', '2026-11-01T08:30:00Z'], ['2026-03-08', '2026-03-08T10:30:00Z']]) {
    const source = fixtureSchedule([...DAYS_OF_WEEK], 'America/Los_Angeles')
    for (const row of source.powers) {
      row.onTime = date.includes('11-') ? '01:30' : '02:30'
      row.offTime = '09:00'
      row.offDayOffset = 0
    }
    for (const row of source.alarm.rows) row.time = '09:00'
    const schedule = resolveExperimentSchedule(source, date, Date.parse(`${date}T00:00:00Z`))
    expect(schedule.windows[0].windowStart).toBe(Date.parse(expected))
    expect(schedule.windows[0].date).toBe(date)
  }
})

it('keeps the local bedtime date when UTC is already the next day or still the previous day', () => {
  for (const timezone of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
    const schedule = resolveExperimentSchedule(fixtureSchedule([...DAYS_OF_WEEK], timezone), '2026-11-13', createdAt)
    const plan = createScheduledExperimentPlan({ ...context, timezone }, 69, schedule, createdAt)
    expect(experimentNightAt(plan, schedule.windows[0].windowStart)?.date).toBe('2026-11-13')
    expect(experimentNightAt(plan, schedule.windows[0].windowStart + 60_000)).toBeNull()
  }
})

it('respects one-occurrence later/skip overrides and ignores invalidated or expired ones', () => {
  const source = fixtureSchedule()
  const at = Date.parse('2026-11-14T07:00:00Z')
  const ids = source.alarm.rows.filter(row => row.dayOfWeek === 'saturday').map(row => row.id)
  source.alarm.override = { plan: alarmPlan(source.alarm), ids, originalAt: at,
    at: at + 3_600_000, expiresAt: at + 2 * 3_600_000 }
  const later = resolveExperimentSchedule(source, '2026-11-13', createdAt).windows[0]
  // Warming is now outside the saved 07:15 routine. The comparison must not extend that routine.
  expect(later.windowEnd).toBe(Date.parse('2026-11-14T07:15:00Z'))
  expect(later.wake).toBeNull()
  source.alarm.override.at = null
  const skipped = resolveExperimentSchedule(source, '2026-11-13', createdAt).windows[0]
  expect(skipped.windowEnd).toBe(skipped.routineEnd)
  expect(skipped.wake).toBeNull()
  source.alarm.override.plan = 'a'.repeat(64)
  expect(resolveExperimentSchedule(source, '2026-11-13', createdAt).windows[0].wake?.source).toBe('routine')
  source.alarm.override.plan = alarmPlan(source.alarm)
  source.alarm.override.expiresAt = createdAt
  expect(resolveExperimentSchedule(source, '2026-11-13', createdAt).windows[0].wake?.source).toBe('routine')
})

it('keeps a shifted alarm inside the routine explicit and stops before a longer smart-wake window', () => {
  const source = fixtureSchedule()
  const at = Date.parse('2026-11-14T07:00:00Z')
  const rows = source.alarm.rows.filter(row => row.dayOfWeek === 'saturday')
  rows[0].wakeWindow = 90
  source.alarm.override = { plan: alarmPlan(source.alarm), ids: rows.map(row => row.id), originalAt: at,
    at: at - 30 * 60_000, expiresAt: at + 3_600_000 }
  const window = resolveExperimentSchedule(source, '2026-11-13', createdAt).windows[0]
  expect(window.wake).toMatchObject({ at: at - 30 * 60_000, source: 'override' })
  expect(window.windowEnd).toBe(at - 120 * 60_000)
})

it('skips overlapping starts, multiple sessions and stray end commands without silently choosing a winner', () => {
  for (const extra of [
    { dayOfWeek: 'friday' as const, onTime: '23:00', offTime: '07:15', offDayOffset: 1 },
    { dayOfWeek: 'friday' as const, onTime: '09:00', offTime: '12:00', offDayOffset: 0 },
  ]) {
    const source = fixtureSchedule()
    source.powers.push({ ...source.powers[0], id: 90, ...extra })
    const schedule = resolveExperimentSchedule(source, '2026-11-13', createdAt)
    expect(schedule.skipped).toContainEqual({ date: '2026-11-13', reason: 'overlapping_routines' })
    expect(schedule.windows.some(window => window.date === '2026-11-13')).toBe(false)
  }
  const unbounded = fixtureSchedule()
  unbounded.powers.push({ ...unbounded.powers[0], id: 90, dayOfWeek: 'saturday', onTime: '12:00', offTime: '01:00', offDayOffset: 0 })
  expect(() => resolveExperimentSchedule(unbounded, '2026-11-13', createdAt)).toThrow('consecutive scheduled nights')
})

it('preserves maintain end actions and excludes short nights or an alarm already warming at bedtime', () => {
  const source = fixtureSchedule()
  source.powers.forEach(row => row.endAction = 'maintain')
  expect(resolveExperimentSchedule(source, '2026-11-13', createdAt).windows.every(window => window.endAction === 'maintain')).toBe(true)
  const saturday = required(source.alarm.rows.find(row => row.dayOfWeek === 'saturday'))
  saturday.time = '01:30'
  expect(resolveExperimentSchedule(source, '2026-11-13', createdAt).skipped).toContainEqual({ date: '2026-11-13', reason: 'too_short' })
  const friday = required(source.alarm.rows.find(row => row.dayOfWeek === 'friday'))
  friday.time = '22:10'
  expect(resolveExperimentSchedule(source, '2026-11-13', createdAt).skipped).toContainEqual({ date: '2026-11-13', reason: 'wake_overlap' })
})

it('skips conflicting same-time wake profiles and excludes a routine that has already begun', () => {
  const source = fixtureSchedule()
  source.alarm.rows.push({ ...required(source.alarm.rows.find(row => row.dayOfWeek === 'saturday')), id: 99, duration: 60 })
  expect(resolveExperimentSchedule(source, '2026-11-13', createdAt).skipped).toContainEqual({ date: '2026-11-13', reason: 'conflicting_alarms' })
  source.alarm.rows.pop()
  expect(resolveExperimentSchedule(source, '2026-11-13', Date.parse('2026-11-13T22:00:00Z')).skipped[0])
    .toEqual({ date: '2026-11-13', reason: 'already_started' })
})

it('rejects corrupt clocks, duplicate identities, unsupported end modes and altered reviewed windows', () => {
  const source = fixtureSchedule(), schedule = resolveExperimentSchedule(source, '2026-11-13', createdAt)
  const plan = createScheduledExperimentPlan(context, 69, schedule, createdAt)
  const altered = structuredClone(plan)
  if (altered.version !== 2) throw new Error('Expected scheduled plan')
  altered.schedule.windows[0].windowEnd += 60_000
  expect(experimentPlanSchema.safeParse(altered).success).toBe(false)
  const missing = structuredClone(plan)
  if (missing.version !== 2) throw new Error('Expected scheduled plan')
  missing.schedule.windows = []
  expect(experimentPlanSchema.safeParse(missing).success).toBe(false)
  for (const patch of [{ onTime: '25:00' }, { offDayOffset: 2 }, { endAction: 'unknown' }]) {
    const invalid = structuredClone(source)
    Object.assign(invalid.powers[0], patch)
    expect(() => resolveExperimentSchedule(invalid, '2026-11-13', createdAt)).toThrow()
  }
  source.powers.push({ ...source.powers[0] })
  expect(() => resolveExperimentSchedule(source, '2026-11-13', createdAt)).toThrow('unavailable')
})

it('rejects a plan with missing skipped dates, repeated dates or a gap inside a treatment period', () => {
  const schedule = resolveExperimentSchedule(fixtureSchedule(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday']), '2026-11-13', createdAt)
  const plan = createScheduledExperimentPlan(context, 69, schedule, createdAt)
  if (plan.version !== 2) throw new Error('Expected scheduled plan')
  const missingDate = structuredClone(plan)
  missingDate.schedule.skipped.shift()
  expect(experimentPlanSchema.safeParse(missingDate).success).toBe(false)
  const repeated = structuredClone(plan)
  repeated.schedule.windows[1] = repeated.schedule.windows[0]
  expect(experimentPlanSchema.safeParse(repeated).success).toBe(false)
  const gap = structuredClone(plan)
  gap.schedule.windows.splice(1, 1)
  expect(experimentPlanSchema.safeParse(gap).success).toBe(false)
  for (const invalidClock of [NaN, -1, Infinity])
    expect(() => resolveExperimentSchedule(fixtureSchedule(), '2026-11-13', invalidClock)).toThrow()
})

it('binds exact window limits into the plan hash and rejects selectively shortened exposure', () => {
  const schedule = resolveExperimentSchedule(fixtureSchedule(), '2026-11-13', createdAt)
  const plan = createScheduledExperimentPlan(context, 69, schedule, createdAt)
  const changed = structuredClone(plan)
  if (changed.version !== 2) throw new Error('Expected scheduled plan')
  changed.schedule.windows[0].endAction = 'maintain'
  expect(experimentPlanHash(changed)).not.toBe(experimentPlanHash(plan))
  const window = schedule.windows[0]
  const input = { start: window.windowStart, end: window.windowEnd, wakeStartsAt: window.wake?.startsAt ?? null,
    recordedAt: window.windowEnd + 1000, execution: 'preview' as const }
  expect(collectExperimentExposure(plan, input, [], []).nightDate).toBe(window.date)
  expect(() => collectExperimentExposure(plan, { ...input, end: input.end - 60_000 }, [], [])).toThrow('exact reviewed')
  const exposure = completeExperiment().exposures[0]
  exposure.planHash = experimentPlanHash(plan)
  expect(experimentExposureIssues(plan, experimentNights(plan)[0], exposure)).toContain('wrong_window')
})

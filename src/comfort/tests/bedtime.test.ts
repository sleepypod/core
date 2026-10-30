import { describe, expect, it } from 'vitest'
import { BedEntryTracker, bedtimePreview, type BedEntrySample } from '../bedtime'
import { comfortRoutineAt, type ComfortSchedules } from '../routines'
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'
import { defaultComfortState, decideComfort, type ComfortContext, type ComfortState } from '../policy'
import { missingComfortSignals } from '../signals'

const MINUTE = 60_000
const start = Date.parse('2026-10-25T05:00:00Z')
const sourceKey = 'a'.repeat(64)
function sample(measuredAt: number, state: BedEntrySample['state'] = 'present'): BedEntrySample {
  return { measuredAt, sourceKey, state }
}
function schedules(): ComfortSchedules {
  return { timezone: 'America/Los_Angeles',
    powers: DAYS_OF_WEEK.map((dayOfWeek, index) => ({ id: index, dayOfWeek, onTime: '22:00', offTime: '07:00', onTemperature: 75 })),
    targets: [{ id: 9, dayOfWeek: 'saturday', time: '23:00', temperature: 70 }],
    alarms: [{ id: 10, dayOfWeek: 'sunday', time: '06:30' }],
  }
}
function state(): ComfortState {
  return { ...defaultComfortState(), config: { mode: 'preview', minimumF: 70, maximumF: 95, sensorAware: true, followBedtime: true } }
}
function context(now: number, schedule = schedules()): ComfortContext {
  return { now, window: comfortRoutineAt(schedule, now),
    device: { observedAt: now, powered: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false, targetF: 75 },
    presence: { observedAt: now, available: true, occupied: true, entry: sample(now) },
    signals: { ...missingComfortSignals(), state: 'ready', sampleAt: now, expiresAt: now + MINUTE },
    eitherAway: false, routinesPaused: false, alarmOverride: false, owner: 'schedule', targetKnown: true }
}
function observedEntry(entryAt: number) {
  const tracker = new BedEntryTracker()
  tracker.observe(sample(entryAt - MINUTE, 'absent'), entryAt - MINUTE)
  for (let minute = 0; minute <= 10; minute++) tracker.observe(sample(entryAt + minute * MINUTE), entryAt + minute * MINUTE)
  return tracker
}

describe('observed bed entry', () => {
  it('requires an empty-to-person transition and ten minutes of advancing samples', () => {
    const tracker = new BedEntryTracker()
    for (let minute = 0; minute <= 20; minute++) expect(tracker.observe(sample(start + minute * MINUTE), start + minute * MINUTE)).toBeNull()
    tracker.observe(sample(start + 21 * MINUTE, 'absent'), start + 21 * MINUTE)
    for (let minute = 22; minute < 32; minute++) expect(tracker.observe(sample(start + minute * MINUTE), start + minute * MINUTE)).toBeNull()
    expect(tracker.observe(sample(start + 32 * MINUTE), start + 32 * MINUTE)).toEqual({ entryAt: start + 22 * MINUTE, confirmedAt: start + 32 * MINUTE, sourceKey })
  })

  it('never turns repeated frames into elapsed presence', () => {
    const tracker = new BedEntryTracker()
    tracker.observe(sample(start - MINUTE, 'absent'), start - MINUTE)
    for (let second = 0; second <= 600; second += 5) expect(tracker.observe(sample(start), start + second * 1000)).toBeNull()
    expect(tracker.observe(sample(start + 601000), start + 601000)).toBeNull()
  })

  it.each(['gap', 'source', 'backward', 'future', 'unknown', 'missing', 'clock'] as const)('discards unfinished evidence after %s', (change) => {
    const tracker = observedEntry(start)
    const checkedAt = start + 11 * MINUTE
    const changed = sample(checkedAt)
    if (change === 'source') changed.sourceKey = 'b'.repeat(64)
    if (change === 'backward') changed.measuredAt = start + 9 * MINUTE
    if (change === 'future') changed.measuredAt = checkedAt + 1
    if (change === 'unknown') changed.state = 'unknown'
    expect(tracker.observe(change === 'missing' ? undefined : changed, change === 'gap' ? checkedAt + 90001 : change === 'clock' ? start : checkedAt)).toBeNull()
    for (let minute = 12; minute <= 24; minute++) expect(tracker.observe(sample(start + minute * MINUTE), start + minute * MINUTE)).toBeNull()
  })
})

describe('bounded temperature-phase Preview', () => {
  it.each([-90, -60, -20, 0, 20, 60, 90])('selects once for entry %i minutes from start and preserves power/alarm boundaries', (offset) => {
    const entryAt = start + offset * MINUTE
    const tracker = observedEntry(entryAt)
    let result = bedtimePreview(state(), context(Math.max(start, entryAt + 10 * MINUTE)), tracker, true)
    // Keep early-entry observations continuous until the actual power window starts.
    if (offset < -10) {
      const continuous = observedEntry(entryAt)
      for (let current = entryAt + 11 * MINUTE; current <= start; current += MINUTE) continuous.observe(sample(current), current)
      result = bedtimePreview(state(), context(start), continuous, true)
    }
    expect(result.status.state).toBe('ready')
    expect(result.selection?.shiftMinutes).toBe(Math.max(-30, Math.min(30, offset)))
    expect(result.window).toMatchObject({ start, end: start + 9 * 60 * MINUTE, alarmAt: start + 8.5 * 60 * MINUTE })
    const saved = { ...state(), bedtime: result.selection }
    const later = context(start + 120 * MINUTE)
    expect(bedtimePreview(saved, later, new BedEntryTracker(), true).selection).toEqual(result.selection)
  })

  it('shifts only intermediate phases, bounds against the original baseline, and never crosses the end', () => {
    const tracker = observedEntry(start - 20 * MINUTE)
    for (let minute = -9; minute <= 0; minute++) tracker.observe(sample(start + minute * MINUTE), start + minute * MINUTE)
    const selected = bedtimePreview(state(), context(start), tracker, true).selection
    const saved = { ...state(), bedtime: selected }
    const current = context(start + 45 * MINUTE)
    const preview = bedtimePreview(saved, current, new BedEntryTracker(), true)
    expect(preview.status).toMatchObject({ state: 'ready', scheduledBaselineF: 75, phaseBaselineF: 70 })
    expect(decideComfort(saved, { ...current, window: preview.window, timing: preview.status })).toMatchObject({ eligible: true, proposedF: 74 })
    current.device.targetF = 72
    expect(decideComfort(saved, { ...current, window: preview.window, timing: preview.status })).toMatchObject({ eligible: false, proposedF: null })
    expect(bedtimePreview(saved, context(start + 9 * 60 * MINUTE), tracker, true).window).toBeNull()
  })

  it('requires guards before selecting and discards entry evidence during mechanical interference', () => {
    const tracker = observedEntry(start)
    const input = context(start + 10 * MINUTE)
    expect(bedtimePreview(state(), input, tracker, false)).toMatchObject({ selection: undefined, status: { state: 'waiting' } })
    input.device.vibrating = true
    expect(bedtimePreview(state(), input, tracker, true).selection).toBeUndefined()
    input.device.vibrating = false
    for (let minute = 11; minute <= 22; minute++) {
      expect(bedtimePreview(state(), context(start + minute * MINUTE), tracker, true).selection).toBeUndefined()
    }
  })

  it('delays a late phase without advancing the initial power event', () => {
    const tracker = observedEntry(start + 20 * MINUTE)
    const selected = bedtimePreview(state(), context(start + 30 * MINUTE), tracker, true).selection
    const preview = bedtimePreview({ ...state(), bedtime: selected }, context(start + 75 * MINUTE), new BedEntryTracker(), true)
    expect(preview.status).toMatchObject({ state: 'ready', scheduledBaselineF: 70, phaseBaselineF: 75 })
    expect(preview.window?.start).toBe(start)
  })

  it('clips shifts for a phase close to the power boundary instead of dropping it', () => {
    const schedule = schedules()
    schedule.targets[0].time = '22:10'
    const tracker = observedEntry(start - 20 * MINUTE)
    for (let minute = -9; minute <= 0; minute++) tracker.observe(sample(start + minute * MINUTE), start + minute * MINUTE)
    const result = bedtimePreview(state(), context(start, schedule), tracker, true)
    expect(result.selection?.shiftMinutes).toBe(-9)
    expect(result.status.phaseBaselineF).toBe(75)
  })

  it('withholds changed routines or sensor identity, and out-of-window entry', () => {
    const tracker = observedEntry(start)
    const selected = bedtimePreview(state(), context(start + 10 * MINUTE), tracker, true).selection
    const changed = schedules()
    changed.targets[0].temperature = 71
    expect(bedtimePreview({ ...state(), bedtime: selected }, context(start + 11 * MINUTE, changed), tracker, true).status.state).toBe('withheld')
    const input = context(start + 11 * MINUTE)
    input.presence.entry = { ...sample(input.now), sourceKey: 'b'.repeat(64) }
    expect(bedtimePreview({ ...state(), bedtime: selected }, input, tracker, true).status.state).toBe('withheld')
    expect(bedtimePreview(state(), context(start + 101 * MINUTE), observedEntry(start + 91 * MINUTE), true).status.state).toBe('withheld')
  })

  it.each(['2026-03-08T06:00:00Z', '2026-11-01T05:00:00Z'])('uses actual elapsed scheduler events across DST at %s', (startTime) => {
    const actualStart = Date.parse(startTime)
    const schedule = schedules()
    schedule.targets = [{ id: 20, dayOfWeek: 'sunday', time: '01:00', temperature: 70 }]
    const tracker = observedEntry(actualStart + 20 * MINUTE)
    const input = context(actualStart + 30 * MINUTE, schedule)
    const preview = bedtimePreview(state(), input, tracker, true)
    expect(preview.selection?.shiftMinutes).toBe(20)
    expect(preview.window).toMatchObject({ start: input.window?.start, end: input.window?.end, alarmAt: input.window?.alarmAt })
    const phaseAt = input.window?.phases?.changes[0].at
    if (phaseAt === undefined) throw new Error('Fixture requires a phase')
    const later = context(phaseAt + 19 * MINUTE, schedule)
    expect(bedtimePreview({ ...state(), bedtime: preview.selection }, later, tracker, true).status.phaseBaselineF).toBe(75)
    later.now += MINUTE
    later.presence.entry = sample(later.now)
    expect(bedtimePreview({ ...state(), bedtime: preview.selection }, later, tracker, true).status.phaseBaselineF).toBe(70)
  })
})

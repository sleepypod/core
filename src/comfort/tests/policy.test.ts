import { missingComfortSignals } from '../signals'
import { describe, expect, it } from 'vitest'
import { ADJUSTMENT_INTERVAL_MS, decideComfort, defaultComfortState, learnComfort, MANUAL_PAUSE_MS } from '../policy'
import type { ComfortContext, ComfortFeedback, ComfortState, RoutineWindow } from '../policy'

const now = Date.parse('2026-10-25T05:00:00Z')
function activeState(): ComfortState {
  return { ...defaultComfortState(), config: { mode: 'active', minimumF: 70, maximumF: 95 }, offsetF: -2 }
}
function context(): ComfortContext {
  return {
    now, window: { session: 'night-1', segment: 'night-1:bedtime', start: now - 60_000, end: now + 8 * 3_600_000, baselineF: 75, alarmAt: null },
    device: { observedAt: now, powered: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false, targetF: 75 },
    presence: { observedAt: now, available: true, occupied: true },
    eitherAway: false, routinesPaused: false, alarmOverride: false, owner: 'schedule', targetKnown: true,
  }
}

function routineWindow(input: ComfortContext): RoutineWindow {
  if (!input.window) throw new Error('This fixture requires a routine window')
  return input.window
}

describe('personal comfort decisions', () => {
  it('defaults off and moves at most one degree toward the bounded learned target', () => {
    expect(decideComfort(defaultComfortState(), context())).toMatchObject({ eligible: false, proposedF: null })
    expect(decideComfort(activeState(), context())).toMatchObject({ eligible: true, baselineF: 75, proposedF: 74, pauseRequired: false })
    expect(decideComfort({ ...activeState(), offsetF: 3 }, context()).proposedF).toBe(76)
  })

  it('labels preview proposals without changing learner state', () => {
    const state = activeState()
    state.config.mode = 'preview'
    const before = structuredClone(state)
    expect(decideComfort(state, context())).toMatchObject({ eligible: true, proposedF: 74, reason: expect.stringContaining('Preview only') })
    expect(state).toEqual(before)
  })

  it.each([
    ['unknown water', (input: ComfortContext) => { input.device.waterAdequate = null }],
    ['low water', (input: ComfortContext) => { input.device.waterAdequate = false }],
    ['priming', (input: ComfortContext) => { input.device.priming = true }],
    ['vibration', (input: ComfortContext) => { input.device.vibrating = true }],
    ['base movement', (input: ComfortContext) => { input.device.baseMoving = true }],
    ['power off', (input: ComfortContext) => { input.device.powered = false }],
    ['missing presence calibration', (input: ComfortContext) => { input.presence.available = false }],
    ['empty side', (input: ComfortContext) => { input.presence.occupied = false }],
    ['away mode', (input: ComfortContext) => { input.eitherAway = true }],
    ['paused routines', (input: ComfortContext) => { input.routinesPaused = true }],
    ['alarm override', (input: ComfortContext) => { input.alarmOverride = true }],
    ['manual owner', (input: ComfortContext) => { input.owner = 'manual' }],
    ['run-once owner', (input: ComfortContext) => { input.owner = 'run-once' }],
    ['no routine', (input: ComfortContext) => { input.window = null }],
    ['future routine', (input: ComfortContext) => { routineWindow(input).start = now + 1 }],
    ['ended routine', (input: ComfortContext) => { routineWindow(input).end = now }],
    ['alarm half-hour', (input: ComfortContext) => { routineWindow(input).alarmAt = now + 30 * 60_000 }],
    ['unknown target', (input: ComfortContext) => { input.device.targetF = null }],
    ['invalid target', (input: ComfortContext) => { input.device.targetF = NaN }],
    ['invalid clock', (input: ComfortContext) => { input.now = NaN }],
    ['routine outside limits', (input: ComfortContext) => { routineWindow(input).baselineF = 65 }],
  ])('withholds and revokes an old target on %s', (_label, change) => {
    const input = context()
    change(input)
    expect(decideComfort(activeState(), input)).toMatchObject({ eligible: false, retainPreviousLease: false })
  })

  it.each([null, NaN, Infinity, now + 1, now - 15_001])('rejects device timestamp %s', (observedAt) => {
    const input = context()
    input.device.observedAt = observedAt
    expect(decideComfort(activeState(), input).eligible).toBe(false)
  })

  it.each([null, NaN, Infinity, now + 1, now - 90_001])('rejects presence timestamp %s', (observedAt) => {
    const input = context()
    input.presence.observedAt = observedAt
    expect(decideComfort(activeState(), input).eligible).toBe(false)
  })

  it('requires a persisted six-hour pause for an unexplained target change', () => {
    const input = { ...context(), targetKnown: false }
    expect(decideComfort(activeState(), input)).toMatchObject({ eligible: false, pauseRequired: true })
    const state = { ...activeState(), pausedUntil: now + MANUAL_PAUSE_MS }
    expect(decideComfort(state, context()).reason).toContain('six hours')
  })

  it('holds an acknowledged same-phase target during cooldown, but never after a guard failure', () => {
    const input = context()
    input.device.targetF = 74
    const state = { ...activeState(), lastAppliedAt: now - 60_000, lastTargetF: 74, lastSegment: routineWindow(input).segment }
    expect(decideComfort(state, input)).toMatchObject({ eligible: false, proposedF: 73, retainPreviousLease: true })
    input.device.waterAdequate = false
    expect(decideComfort(state, input).retainPreviousLease).toBe(false)
    input.device.waterAdequate = true
    state.lastSegment = 'a-different-phase'
    expect(decideComfort(state, input).retainPreviousLease).toBe(false)
    state.lastAppliedAt = now - ADJUSTMENT_INTERVAL_MS
    expect(decideComfort(state, input).eligible).toBe(true)
    state.lastAppliedAt = now + 1
    expect(decideComfort(state, input).retainPreviousLease).toBe(false)
  })

  it('cannot step toward a learned target through an out-of-band value', () => {
    const input = context()
    input.device.targetF = 68
    expect(decideComfort(activeState(), input).eligible).toBe(false)
    input.device.targetF = 70
    routineWindow(input).baselineF = 70
    expect(decideComfort(activeState(), input).proposedF).toBe(70)
  })

  it.each(['learning', 'stale', 'review'] as const)('withholds sensor-aware correction for %s estimates', (state) => {
    const input = context()
    input.signals = { ...missingComfortSignals(), expiresAt: now + 10000, state, sampleAt: now, reason: 'Reviewing a Pod baseline.' }
    const policy = activeState()
    policy.config.sensorAware = true
    expect(decideComfort(policy, input)).toMatchObject({ eligible: false, reason: input.signals.reason })
  })

  it.each([null, NaN, Infinity, now + 1, now - 360_001])('withholds nominally ready but invalid vital time %s', (sampleAt) => {
    const input = context()
    input.signals = { ...missingComfortSignals(), expiresAt: now + 10000, state: 'ready', sampleAt, reason: 'Ready' }
    const policy = activeState()
    policy.config.sensorAware = true
    expect(decideComfort(policy, input).eligible).toBe(false)
  })

  it.each([null, NaN, Infinity, now])('withholds expired or invalid proof deadline %s', (expiresAt) => {
    const input = context(), policy = activeState()
    policy.config.sensorAware = true
    input.signals = { ...missingComfortSignals(), state: 'ready', sampleAt: now, expiresAt, reason: 'Ready' }
    expect(decideComfort(policy, input).eligible).toBe(false)
  })

  it('admits fresh sensor-aware evidence only inside all other guards', () => {
    const input = context()
    input.signals = { ...missingComfortSignals(), expiresAt: now + 10000, state: 'ready', sampleAt: now, reason: 'Ready' }
    const policy = activeState()
    policy.config.sensorAware = true
    expect(decideComfort(policy, input)).toMatchObject({ eligible: true, proposedF: 74 })
    input.presence.available = false
    expect(decideComfort(policy, input).eligible).toBe(false)
  })

  it.each([
    { offsetF: 4 }, { offsetF: NaN }, { lastAppliedAt: NaN }, { pausedUntil: Infinity },
    { config: { mode: 'active' as const, minimumF: 96, maximumF: 70 } },
  ])('fails closed on invalid saved state %j', (change) => {
    expect(decideComfort({ ...activeState(), ...change }, context()).eligible).toBe(false)
  })
})

function reports(comfort: ComfortFeedback['comfort']): ComfortFeedback[] {
  return ['2026-10-21', '2026-10-22', '2026-10-23'].map(date => ({ date, comfort }))
}

describe('personal comfort learning', () => {
  it('learns one degree from three new dates and consumes them exactly once', () => {
    const original = { ...activeState(), offsetF: 0 }
    const learned = learnComfort(original, reports('warm'), 'night-1', 'America/Los_Angeles', now)
    expect(learned.state).toMatchObject({ offsetF: -1, feedbackThrough: '2026-10-23', learnedSession: 'night-1' })
    expect(original.offsetF).toBe(0)
    expect(learnComfort(learned.state, reports('warm'), 'night-1', 'America/Los_Angeles', now).message).toBeNull()
    expect(learnComfort(learned.state, reports('warm'), 'night-2', 'America/Los_Angeles', now).state.offsetF).toBe(-1)
  })

  it('deduplicates dates and requires at least three, with a two-thirds majority', () => {
    const original = { ...activeState(), offsetF: 0 }
    const repeated = Array.from({ length: 9 }, () => reports('warm')[0])
    expect(learnComfort(original, repeated, 'night', 'UTC', now).message).toBeNull()
    const mixed = reports('warm')
    mixed[2].comfort = 'cold'
    expect(learnComfort(original, mixed, 'night', 'UTC', now).state.offsetF).toBe(-1)
    mixed[1].comfort = 'comfortable'
    expect(learnComfort(original, mixed, 'night', 'UTC', now).state.offsetF).toBe(0)
  })

  it('bounds learned offsets and preserves the consumption cursor after reset', () => {
    expect(learnComfort({ ...activeState(), offsetF: 3 }, reports('cold'), 'night', 'UTC', now).state.offsetF).toBe(3)
    expect(learnComfort({ ...activeState(), offsetF: -3 }, reports('warm'), 'night', 'UTC', now).state.offsetF).toBe(-3)
    const reset = { ...activeState(), offsetF: 0, feedbackThrough: '2026-10-23' }
    expect(learnComfort(reset, reports('warm'), 'night', 'UTC', now).state.offsetF).toBe(0)
  })

  it('excludes malformed, old and future local dates', () => {
    const feedback: ComfortFeedback[] = ['2026-02-30', '2026-10-01', '2026-10-26'].map(date => ({ date, comfort: 'cold' }))
    const state = learnComfort(activeState(), feedback, 'night', 'UTC', now)
    expect(state.message).toBeNull()
    const midnight = Date.parse('2026-10-25T01:00:00Z') // still October 24 in Los Angeles
    feedback.splice(0, 3, { date: '2026-10-23', comfort: 'warm' }, { date: '2026-10-24', comfort: 'warm' }, { date: '2026-10-25', comfort: 'warm' })
    expect(learnComfort(activeState(), feedback, 'night', 'America/Los_Angeles', midnight).message).toBeNull()
    expect(learnComfort(activeState(), feedback, 'night', 'UTC', midnight).message).not.toBeNull()
  })

  it('does not learn while off, from an invalid cursor, or in an unknown timezone', () => {
    expect(learnComfort(defaultComfortState(), reports('warm'), 'night', 'UTC', now).message).toBeNull()
    expect(learnComfort({ ...activeState(), feedbackThrough: 'bad' }, reports('warm'), 'night', 'UTC', now).message).toBeNull()
    expect(learnComfort(activeState(), reports('warm'), 'night', 'Unknown/Zone', now).message).toBeNull()
  })
})

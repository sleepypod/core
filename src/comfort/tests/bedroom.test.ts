import { describe, expect, it } from 'vitest'
import type { BedroomComfortGuidance } from '@/src/bedroom/contract'
import { decideComfort, defaultComfortState, type ComfortContext } from '../policy'

const now = Date.parse('2026-10-27T04:00:00Z')
const guidance: BedroomComfortGuidance = { state: 'ready', offsetF: -1, reason: 'Warm room.', sourceIds: ['temperature', 'humidity'],
  expiresAt: now + 120000, configuration: 'f'.repeat(64) }
function context(): ComfortContext {
  return {
    now, window: { session: 'night', segment: 'night:first', start: now - 60000, end: now + 3600000, baselineF: 75, alarmAt: null },
    device: { observedAt: now, powered: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false, targetF: 75 },
    presence: { observedAt: now, available: true, occupied: true },
    eitherAway: false, routinesPaused: false, alarmOverride: false, owner: 'schedule', targetKnown: true, bedroom: { ...guidance },
  }
}
function state() {
  return { ...defaultComfortState(), config: { mode: 'active' as const, minimumF: 70, maximumF: 95, roomAware: true } }
}

describe('bedroom-aware personal comfort', () => {
  it('adds a room contribution only when selected and never mutates the saved curve', () => {
    const input = context()
    const before = structuredClone(input.window)
    expect(decideComfort(state(), input)).toMatchObject({ eligible: true, baselineF: 75, proposedF: 74 })
    expect(decideComfort({ ...state(), config: { ...state().config, roomAware: false } }, input).proposedF).toBe(75)
    expect(input.window).toEqual(before)
  })
  it('shares the learner offset budget while retaining one-degree steps', () => {
    const input = context()
    input.device.targetF = 72
    expect(decideComfort({ ...state(), offsetF: -3 }, input)).toMatchObject({ eligible: true, proposedF: 72 })
    input.device.targetF = 75
    expect(decideComfort({ ...state(), offsetF: -3 }, input).proposedF).toBe(74)
  })
  it.each([
    undefined,
    { ...guidance, state: 'unavailable' as const },
    { ...guidance, state: 'disagreement' as const },
    { ...guidance, expiresAt: now },
    { ...guidance, expiresAt: now + 900001 },
    { ...guidance, configuration: null },
    { ...guidance, sourceIds: [] },
  ])('withdraws the previous room target when its inputs are unusable: %j', (bedroom) => {
    const input = { ...context(), bedroom }
    input.device.targetF = 74
    const previous = { ...state(), lastAppliedAt: now - 60000, lastTargetF: 74, lastSegment: 'night:first' }
    expect(decideComfort(previous, input)).toMatchObject({ eligible: false, retainPreviousLease: false, proposedF: null })
  })
  it('keeps manual pauses, empty bed and the wake-warming window ahead of room context', () => {
    expect(decideComfort({ ...state(), pausedUntil: now + 3600000 }, context()).reason).toContain('six hours')
    const input = context()
    input.presence.occupied = false
    expect(decideComfort(state(), input).eligible).toBe(false)
    input.presence.occupied = true
    if (!input.window) throw new Error('Routine fixture missing')
    input.window.alarmAt = now + 30 * 60000
    expect(decideComfort(state(), input)).toMatchObject({ eligible: false, reason: 'Leaving the alarm window to your routine.' })
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import {
  OVERLAY_HOLD_MS,
  _resetMutationOverlays,
  applyMutationOverlay,
  recordMutationOverlay,
} from '../mutationOverlay'

const T0 = 1_000_000
const polled = (targetTemperature: number | null, targetLevel: number) => ({
  currentTemperature: 80, targetTemperature, currentLevel: 0, targetLevel, heatingDuration: 3600,
})

beforeEach(() => _resetMutationOverlays())

describe('mutation overlay on polled deviceStatus', () => {
  it('holds the new target over a stale poll (no new → old → new flicker)', () => {
    recordMutationOverlay('left', { targetTemperature: 78, targetLevel: -16 }, T0)
    const out = applyMutationOverlay('left', polled(82, 0), T0 + 1500)
    expect(out.targetTemperature).toBe(78)
    expect(out.targetLevel).toBe(-16)
    expect(out.currentTemperature).toBe(80) // untouched fields pass through
  })

  it('drops the overlay once the firmware reports the new target', () => {
    recordMutationOverlay('left', { targetTemperature: 78, targetLevel: -16 }, T0)
    expect(applyMutationOverlay('left', polled(78, -16), T0 + 2000).targetTemperature).toBe(78)
    // A later external change (e.g. schedule) must show through.
    expect(applyMutationOverlay('left', polled(85, 9), T0 + 4000).targetTemperature).toBe(85)
  })

  it('gives up after the hold window so a lost write cannot pin the target', () => {
    recordMutationOverlay('left', { targetTemperature: 78, targetLevel: -16 }, T0)
    expect(applyMutationOverlay('left', polled(82, 0), T0 + OVERLAY_HOLD_MS - 1).targetTemperature).toBe(78)
    expect(applyMutationOverlay('left', polled(82, 0), T0 + OVERLAY_HOLD_MS).targetTemperature).toBe(82)
    expect(applyMutationOverlay('left', polled(82, 0), T0 + 1).targetTemperature).toBe(82)
  })

  it('ignores overlays without target fields (alarm state stays DB-backed)', () => {
    recordMutationOverlay('left', { targetTemperature: 78, targetLevel: -16 }, T0)
    recordMutationOverlay('left', { isAlarmVibrating: true }, T0 + 100)
    const out = applyMutationOverlay('left', polled(82, 0), T0 + 200)
    expect(out.targetTemperature).toBe(78)
    expect(out).not.toHaveProperty('isAlarmVibrating')
    recordMutationOverlay('left', undefined, T0 + 300)
    expect(applyMutationOverlay('left', polled(82, 0), T0 + 400).targetTemperature).toBe(78)
  })

  it('a newer overlay replaces the held one; power-off holds only the level', () => {
    recordMutationOverlay('left', { targetTemperature: 78, targetLevel: -16 }, T0)
    recordMutationOverlay('left', { targetLevel: 0 }, T0 + 500)
    const out = applyMutationOverlay('left', polled(78, -16), T0 + 1000)
    expect(out.targetLevel).toBe(0)
    expect(out.targetTemperature).toBe(78)
  })

  it('keeps sides independent', () => {
    recordMutationOverlay('right', { targetTemperature: 70, targetLevel: -45 }, T0)
    expect(applyMutationOverlay('left', polled(82, 0), T0 + 100).targetTemperature).toBe(82)
    expect(applyMutationOverlay('right', polled(82, 0), T0 + 100).targetTemperature).toBe(70)
  })
})

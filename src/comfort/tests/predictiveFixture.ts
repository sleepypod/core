import { defaultComfortState, type ComfortContext } from '../policy'

/** Synthetic water trajectories for policy tests and illustrative browser previews only. */
export function predictiveFixture(now = 1_800_000_000_000) {
  const state = defaultComfortState()
  state.config = { mode: 'preview', minimumF: 69, maximumF: 72 }
  const context: ComfortContext = {
    now, window: { session: 'example', segment: 'example:night', start: now - 3_600_000, end: now + 8 * 3_600_000, baselineF: 70, alarmAt: null },
    device: { observedAt: now, powered: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false, targetF: 70 },
    presence: { observedAt: now, available: true, occupied: true }, eitherAway: false,
    routinesPaused: false, alarmOverride: false, owner: 'schedule', targetKnown: true,
  }
  return { side: 'left' as const, state, context, hold: predictiveHorizons(73),
    steps: [{ targetF: 69, ...predictiveHorizons(70.5) }, { targetF: 71, ...predictiveHorizons(74) }] }
}
export function predictiveHorizons(waterF: number, error = 0.25) {
  return { predictions: ([15, 30] as const).map(minutes => ({ minutes, waterF, lowerF: waterF - error, upperF: waterF + error })),
    reason: 'Artificial conditional water estimates, not personal observations.' }
}

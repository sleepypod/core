import { describe, expect, it } from 'vitest'
import { remainingPumpStallRestore } from '../pumpStallRestore'

describe('remainingPumpStallRestore', () => {
  it('does not extend a restore when the trip timestamp is in the future', () => {
    const restore = { targetTemperature: 74, durationSeconds: 7200 }

    expect(remainingPumpStallRestore(restore, 20_000, 10_000)).toEqual(restore)
  })

  it.each([0, -1])('returns null when durationSeconds is %s', (durationSeconds) => {
    expect(remainingPumpStallRestore(
      { targetTemperature: 74, durationSeconds },
      10_000,
      10_000,
    )).toBeNull()
  })
})

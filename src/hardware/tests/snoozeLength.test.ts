import { describe, expect, it } from 'vitest'
import { MIN_SNOOZE_SECONDS, nextSnoozeSeconds } from '../snoozeLength'

const alarm = { vibrationIntensity: 50, vibrationPattern: 'rise' as const, duration: 60 }

describe('nextSnoozeSeconds', () => {
  it('uses the alarm snooze length, or the caller fallback without one', () => {
    expect(nextSnoozeSeconds({ ...alarm, snoozeDuration: 540 })).toBe(540)
    expect(nextSnoozeSeconds(alarm)).toBe(300)
    expect(nextSnoozeSeconds(alarm, 540)).toBe(540)
  })

  it('every snooze is the same length without a taper', () => {
    expect(nextSnoozeSeconds({ ...alarm, snoozeDuration: 540, snoozeTaper: 0, snoozeCount: 4 })).toBe(540)
  })

  it('shortens each later snooze by the taper percent', () => {
    const lengths = [0, 1, 2, 3].map(snoozeCount =>
      nextSnoozeSeconds({ ...alarm, snoozeDuration: 540, snoozeTaper: 20, snoozeCount }))
    expect(lengths).toEqual([540, 432, 346, 276])
  })

  it('tapers below a minute but never under 5 seconds, or the set length if that is shorter', () => {
    expect(MIN_SNOOZE_SECONDS).toBe(5)
    expect(nextSnoozeSeconds({ ...alarm, snoozeDuration: 60, snoozeTaper: 60, snoozeCount: 2 })).toBe(10)
    expect(nextSnoozeSeconds({ ...alarm, snoozeDuration: 300, snoozeTaper: 60, snoozeCount: 5 })).toBe(5)
    expect(nextSnoozeSeconds({ ...alarm, snoozeDuration: 3, snoozeTaper: 60, snoozeCount: 5 })).toBe(3)
  })

  it('ignores out-of-range taper and counts', () => {
    expect(nextSnoozeSeconds({ ...alarm, snoozeDuration: 600, snoozeTaper: -20, snoozeCount: 2 })).toBe(600)
    expect(nextSnoozeSeconds({ ...alarm, snoozeDuration: 600, snoozeTaper: 20, snoozeCount: -1 })).toBe(600)
  })
})

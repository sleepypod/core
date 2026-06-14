import { describe, expect, it } from 'vitest'
import { reduceCap } from '../signals.biometrics'

describe('reduceCap', () => {
  it('returns null for an empty array', () => {
    expect(reduceCap([])).toBeNull()
  })

  it('reduces a scalar (Pod 3) channel to degenerate stats', () => {
    expect(reduceCap([42])).toEqual({ max: 42, mean: 42, spread: 0, peakZone: null })
  })

  it('drops the two reference channels from a full capSense2 frame', () => {
    // [A1,A2,B1,B2,C1,C2,ref1,ref2] — refs (999) must not affect the stats.
    expect(reduceCap([10, 20, 30, 40, 50, 60, 999, 999])).toMatchObject({ max: 60, spread: 50, mean: 35 })
  })

  it('picks the paired zone (A/B/C) with the highest mean as peakZone', () => {
    // zone A mean=15, B mean=85, C mean=35 → B is index 1.
    expect(reduceCap([10, 20, 80, 90, 30, 40, 0, 0])).toMatchObject({ peakZone: 1 })
    // zone C dominant → index 2.
    expect(reduceCap([10, 10, 20, 20, 95, 95, 0, 0])).toMatchObject({ peakZone: 2 })
  })

  it('leaves peakZone null when the frame is not the 6-channel shape', () => {
    expect(reduceCap([10, 20, 30])).toMatchObject({ peakZone: null })
  })
})

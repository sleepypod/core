import { describe, expect, it } from 'vitest'
import { evaluateCapacitance, parseCapacitanceCalibration } from '../capacitanceLevel'

const channels = { out: { mean: 1000, std: 5 }, cen: { mean: 1000, std: 5 }, in: { mean: 1000, std: 5 } }

describe('legacy capacitance calibration parity with Python', () => {
  it('does not reinterpret an old z-score threshold as raw units', () => {
    const calibration = parseCapacitanceCalibration({ channels, threshold: 6 }, 'capSense')
    if (!calibration) throw new Error('Expected valid calibration')
    expect(calibration.threshold).toBe(300)
    expect(evaluateCapacitance([1010, 1010, 1010, 1010, 1010, 1010], calibration).active).toBe(false)
  })

  it('honors a tagged raw-unit threshold and its strict boundary', () => {
    const calibration = parseCapacitanceCalibration({ format: 'capSense', channels, threshold: 600 }, 'capSense')
    if (!calibration) throw new Error('Expected valid calibration')
    expect(evaluateCapacitance([1200, 1200, 1200, 1200, 1200, 1200], calibration).active).toBe(false)
    expect(evaluateCapacitance([1201, 1201, 1200, 1200, 1200, 1200], calibration).active).toBe(true)
  })

  it.each([NaN, Infinity, -1, 0, '300'])('rejects invalid threshold %s', (threshold) => {
    expect(parseCapacitanceCalibration({ format: 'capSense', channels, threshold }, 'capSense')).toBeNull()
  })

  it('rejects a mismatched calibration or an incomplete baseline', () => {
    expect(parseCapacitanceCalibration({ format: 'capSense', channels }, 'capSense2')).toBeNull()
    expect(parseCapacitanceCalibration({ channels: { out: { mean: 1 } } }, 'capSense')).toBeNull()
  })
})

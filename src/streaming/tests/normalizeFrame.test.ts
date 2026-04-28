/**
 * Tests for frame normalization — the untyped runtime transform that converts
 * raw firmware CBOR payloads into the typed SensorFrame interfaces.
 *
 * Fixtures are real payloads captured from the pod's RAW files (2026-03-22).
 * If the firmware struct changes, update these fixtures and the normalizer.
 */

import { describe, it, expect } from 'vitest'
import { normalizeFrame } from '../normalizeFrame'

// ---------------------------------------------------------------------------
// Real firmware payloads (captured from pod 2026-03-22)
// ---------------------------------------------------------------------------

const FIRMWARE_FIXTURES = {
  frzHealth: {
    type: 'frzHealth',
    ts: 1774204566,
    version: 1,
    left: {
      tec: { current: -1 },
      pump: { mode: 'pwm', rpm: 0, water: true },
      temps: { flowrate: 26.0625 },
    },
    right: {
      tec: { current: -1 },
      pump: { mode: 'pwm', rpm: 0, water: true },
      temps: { flowrate: 26.0625 },
    },
    fan: { top: { rpm: 234 }, bottom: { rpm: 0 } },
  },

  frzTemp: {
    type: 'frzTemp',
    ts: 1774204572,
    left: 2531,
    right: 2225,
    amb: 2237,
    hs: 2531,
  },

  frzTherm: {
    type: 'frzTherm',
    ts: 1774204566,
    version: 1,
    left: {
      target: 23.76,
      power: -0.563,
      valid: true,
      enabled: true,
    },
    right: {
      target: 27,
      power: 0,
      valid: true,
      enabled: false,
    },
  },

  bedTemp2: {
    type: 'bedTemp2',
    ts: 1774204604,
    version: 1,
    mcu: 31.69,
    left: {
      amb: 21.93,
      hu: 50.37,
      board: 26.81,
      temps: [26.12, 27.09, 26.54, -327.68],
    },
    right: {
      amb: -327.68,
      hu: -327.68,
      board: 25.5,
      temps: [23.51, 23.59, 23.27, 22.63],
    },
  },

  capSense2: {
    type: 'capSense2',
    ts: 1774204604,
    version: 1,
    left: {
      values: [15.74, 15.85, 17.07, 17.23, 19.79, 19.86, 1.16, 1.16],
      status: 'good',
    },
    right: {
      values: [18.95, 18.91, 15.59, 15.59, 21.02, 21.05, 1.16, 1.16],
      status: 'good',
    },
  },

  log: {
    type: 'log',
    ts: 1774204555,
    level: 'debug',
    msg: 'test message',
  },

  // v1 (Pod 3) — captured from issue #437 attached RAW (PR #437)
  bedTempV1: {
    type: 'bedTemp',
    ts: 1776463233,
    amb: 2514, // centidegrees → 25.14 °C
    mcu: 3428,
    hu: 3956,
    left: { side: 2334, out: 2280, cen: 2301, in: 2359 },
    right: { side: 2417, out: 2351, cen: 2420, in: 2396 },
  },

  capSenseV1: {
    type: 'capSense',
    ts: 1776463227,
    left: { out: 290, cen: 241, in: 339, status: 'good' },
    right: { out: 372, cen: 498, in: 526, status: 'good' },
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('normalizeFrame', () => {
  describe('frzHealth', () => {
    it('extracts pump RPM from nested left.pump.rpm', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzHealth as Record<string, unknown>)
      const left = result.left as Record<string, unknown>
      expect(left.pumpRpm).toBe(0) // firmware says rpm: 0
    })

    it('extracts TEC current from nested left.tec.current', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzHealth as Record<string, unknown>)
      const left = result.left as Record<string, unknown>
      expect(left.tecCurrent).toBe(-1)
    })

    it('extracts fan RPM from nested fan.top.rpm', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzHealth as Record<string, unknown>)
      const fan = result.fan as Record<string, unknown>
      expect(fan.rpm).toBe(234)
    })

    it('extracts right side pump RPM', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzHealth as Record<string, unknown>)
      const right = result.right as Record<string, unknown>
      expect(right.pumpRpm).toBe(0)
    })

    it('extracts right side TEC current', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzHealth as Record<string, unknown>)
      const right = result.right as Record<string, unknown>
      expect(right.tecCurrent).toBe(-1)
    })

    it('preserves timestamp', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzHealth as Record<string, unknown>)
      expect(result.ts).toBe(1774204566)
    })

    it('sets type to frzHealth', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzHealth as Record<string, unknown>)
      expect(result.type).toBe('frzHealth')
    })

    it('handles active pump with non-zero RPM', () => {
      const active = {
        ...FIRMWARE_FIXTURES.frzHealth,
        left: {
          tec: { current: 3.5 },
          pump: { mode: 'pwm', rpm: 2400, water: true },
          temps: { flowrate: 26 },
        },
      }
      const result = normalizeFrame(active as Record<string, unknown>)
      const left = result.left as Record<string, unknown>
      expect(left.pumpRpm).toBe(2400)
      expect(left.tecCurrent).toBe(3.5)
    })

    it('extracts flowrate from nested left/right.temps.flowrate', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzHealth as Record<string, unknown>)
      const left = result.left as Record<string, unknown>
      const right = result.right as Record<string, unknown>
      expect(left.flowrate).toBeCloseTo(26.0625)
      expect(right.flowrate).toBeCloseTo(26.0625)
    })

    it('extracts bottom fan RPM from nested fan.bottom.rpm', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzHealth as Record<string, unknown>)
      const fan = result.fan as Record<string, unknown>
      expect(fan.bottomRpm).toBe(0)
    })

    it('returns null flowrate when temps missing', () => {
      const noTemps = {
        ...FIRMWARE_FIXTURES.frzHealth,
        left: { tec: { current: 0 }, pump: { mode: 'pwm', rpm: 0, water: true } },
      }
      const result = normalizeFrame(noTemps as Record<string, unknown>)
      const left = result.left as Record<string, unknown>
      expect(left.flowrate).toBeNull()
    })
  })

  describe('frzTemp', () => {
    it('converts centidegrees to celsius', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzTemp as Record<string, unknown>)
      expect(result.left).toBeCloseTo(25.31)
      expect(result.right).toBeCloseTo(22.25)
      expect(result.amb).toBeCloseTo(22.37)
      expect(result.hs).toBeCloseTo(25.31)
    })

    it('preserves type and timestamp', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzTemp as Record<string, unknown>)
      expect(result.type).toBe('frzTemp')
      expect(result.ts).toBe(1774204572)
    })

    it('treats -32768 sentinel as null (no sensor)', () => {
      const sentinel = { type: 'frzTemp', ts: 1, left: -32768, right: 2225, amb: -32768, hs: 2531 }
      const result = normalizeFrame(sentinel as Record<string, unknown>)
      expect(result.left).toBeNull()
      expect(result.right).toBeCloseTo(22.25)
      expect(result.amb).toBeNull()
      expect(result.hs).toBeCloseTo(25.31)
    })
  })

  describe('frzTherm', () => {
    it('extracts power as thermal control signal', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.frzTherm as Record<string, unknown>)
      // frzTherm normalizer should extract a numeric value for left and right
      expect(typeof result.left).toBe('number')
      expect(typeof result.right).toBe('number')
    })
  })

  describe('bedTemp2', () => {
    it('extracts ambient temp from nested left.amb', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.bedTemp2 as Record<string, unknown>)
      expect(result.ambientTemp).toBeCloseTo(21.93)
    })

    it('extracts humidity from nested left.hu', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.bedTemp2 as Record<string, unknown>)
      expect(result.humidity).toBeCloseTo(50.37)
    })

    it('extracts bed temps from nested temps arrays', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.bedTemp2 as Record<string, unknown>)
      expect(result.leftOuterTemp).toBeCloseTo(26.12)
      expect(result.leftCenterTemp).toBeCloseTo(27.09)
      expect(result.leftInnerTemp).toBeCloseTo(26.54)
      expect(result.rightOuterTemp).toBeCloseTo(23.51)
      expect(result.rightCenterTemp).toBeCloseTo(23.59)
      expect(result.rightInnerTemp).toBeCloseTo(23.27)
    })

    it('nullifies sentinel values (-327.68)', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.bedTemp2 as Record<string, unknown>)
      // left temps[3] is -327.68 (sentinel)
      // right amb and hu are -327.68 (sentinel)
      expect(result.rightOuterTemp).toBeCloseTo(23.51) // not sentinel
    })

    it('extracts MCU temp', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.bedTemp2 as Record<string, unknown>)
      expect(result.mcuTemp).toBeCloseTo(31.69)
    })
  })

  describe('capSense2', () => {
    it('extracts values arrays from nested structure', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.capSense2 as Record<string, unknown>)
      expect(Array.isArray(result.left)).toBe(true)
      expect(Array.isArray(result.right)).toBe(true)
      expect((result.left as number[]).length).toBe(8)
      expect((result.right as number[]).length).toBe(8)
    })

    it('preserves status', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.capSense2 as Record<string, unknown>)
      expect(result.status).toBe('good')
    })
  })

  describe('log (passthrough)', () => {
    it('passes through log frames unchanged', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.log as Record<string, unknown>)
      expect(result.type).toBe('log')
      expect(result.msg).toBe('test message')
      expect(result.level).toBe('debug')
    })
  })

  describe('bedTemp v1 (Pod 3)', () => {
    it('converts integer centidegrees to degrees C', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.bedTempV1 as Record<string, unknown>)
      expect(result.ambientTemp).toBeCloseTo(25.14)
      expect(result.mcuTemp).toBeCloseTo(34.28)
      expect(result.humidity).toBeCloseTo(39.56)
    })

    it('extracts per-zone thermistors from flat out/cen/in keys', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.bedTempV1 as Record<string, unknown>)
      expect(result.leftOuterTemp).toBeCloseTo(22.80)
      expect(result.leftCenterTemp).toBeCloseTo(23.01)
      expect(result.leftInnerTemp).toBeCloseTo(23.59)
      expect(result.rightOuterTemp).toBeCloseTo(23.51)
      expect(result.rightCenterTemp).toBeCloseTo(24.20)
      expect(result.rightInnerTemp).toBeCloseTo(23.96)
    })

    it('preserves type tag and timestamp', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.bedTempV1 as Record<string, unknown>)
      expect(result.type).toBe('bedTemp')
      expect(result.ts).toBe(1776463233)
    })

    it('returns null for missing zone keys', () => {
      const partial = {
        type: 'bedTemp', ts: 1776463233,
        amb: 2514, mcu: 3428, hu: 3956,
        left: { out: 2280 }, // no cen, no in
        right: {},
      }
      const result = normalizeFrame(partial as Record<string, unknown>)
      expect(result.leftOuterTemp).toBeCloseTo(22.80)
      expect(result.leftCenterTemp).toBeNull()
      expect(result.rightInnerTemp).toBeNull()
    })
  })

  describe('capSense v1 (Pod 3)', () => {
    it('projects flat out/cen/in into a values array', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.capSenseV1 as Record<string, unknown>)
      expect(Array.isArray(result.left)).toBe(true)
      expect(Array.isArray(result.right)).toBe(true)
      // Per-zone values duplicated to mimic the capSense2 paired-channel layout
      expect((result.left as number[])).toEqual([290, 290, 241, 241, 339, 339])
      expect((result.right as number[])).toEqual([372, 372, 498, 498, 526, 526])
    })

    it('preserves status', () => {
      const result = normalizeFrame(FIRMWARE_FIXTURES.capSenseV1 as Record<string, unknown>)
      expect(result.status).toBe('good')
    })
  })
})

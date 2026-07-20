/**
 * Tests for frame normalization — the untyped runtime transform that converts
 * raw firmware CBOR payloads into the typed SensorFrame interfaces.
 *
 * Fixtures are real payloads captured from the pod's RAW files (2026-03-22).
 * If the firmware struct changes, update these fixtures and the normalizer.
 */

import { describe, it, expect } from 'vitest'
import { capSideChannels, normalizeFrame } from '../normalizeFrame'

describe('capSideChannels', () => {
  it('unwraps the Pod 4/5 {values,status} object', () => {
    expect(capSideChannels({ values: [16.2, 16.1, 22.2, 1.16], status: 'good' }))
      .toEqual([16.2, 16.1, 22.2, 1.16])
  })

  it('drops non-numbers from the Pod 4/5 values array', () => {
    expect(capSideChannels({ values: [16.2, null, 'nope', 1.16], status: 'good' }))
      .toEqual([16.2, 1.16])
  })

  it('projects the Pod 3 {out,cen,in} object into the 6-slot paired layout', () => {
    expect(capSideChannels({ out: 10, cen: 20, in: 30 })).toEqual([10, 10, 20, 20, 30, 30])
  })

  it('rejects partial Pod 3 channel objects instead of zero-filling missing zones', () => {
    expect(capSideChannels({ out: 10 })).toBeNull()
    expect(capSideChannels({ out: 10, cen: 20 })).toBeNull()
  })

  it('passes a bare numeric array through, dropping non-numbers', () => {
    expect(capSideChannels([1, 2, null, 3])).toEqual([1, 2, 3])
  })

  it('returns null for an array with nothing numeric left after filtering', () => {
    expect(capSideChannels([])).toBeNull()
    expect(capSideChannels([null, 'nope'])).toBeNull()
  })

  it('wraps a scalar (degenerate) reading', () => {
    expect(capSideChannels(42)).toEqual([42])
  })

  it('returns null for empty/garbage payloads', () => {
    expect(capSideChannels({ values: [] })).toBeNull()
    expect(capSideChannels({})).toBeNull()
    expect(capSideChannels(null)).toBeNull()
    expect(capSideChannels('nope')).toBeNull()
  })
})

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

    it('keeps zone positions stable when a field is missing', () => {
      // If `out` is absent on a partial Pod 3 frame, the inner/center readings
      // must NOT shift left into the outer slot — slot 0 stays null so
      // subscribers indexing by zone aren't lied to.
      const partial = {
        type: 'capSense', ts: 1776463227,
        left: { cen: 241, in: 339, status: 'good' },
        right: { out: 372, cen: 498, in: 526, status: 'good' },
      }
      const result = normalizeFrame(partial as Record<string, unknown>)
      expect((result.left as (number | null)[])).toEqual([null, null, 241, 241, 339, 339])
      expect((result.right as (number | null)[])).toEqual([372, 372, 498, 498, 526, 526])
    })

    it('defaults left/right to empty objects when both sides are missing', () => {
      // Exercises the `rec.left ?? {}` and `rec.right ?? {}` fallbacks.
      const empty = { type: 'capSense', ts: 1776463227 }
      const result = normalizeFrame(empty as Record<string, unknown>)
      expect((result.left as (number | null)[])).toEqual([null, null, null, null, null, null])
      expect((result.right as (number | null)[])).toEqual([null, null, null, null, null, null])
      expect(result.status).toBeUndefined()
    })

    it('falls back to right.status when left.status is missing', () => {
      const partial = {
        type: 'capSense', ts: 1776463227,
        left: { out: 290, cen: 241, in: 339 },
        right: { out: 372, cen: 498, in: 526, status: 'good' },
      }
      const result = normalizeFrame(partial as Record<string, unknown>)
      expect(result.status).toBe('good')
    })
  })

  // -------------------------------------------------------------------------
  // Branch coverage — edge cases for each variant
  // -------------------------------------------------------------------------

  describe('default (unknown type)', () => {
    it('passes through unknown frame types unchanged', () => {
      const unknown = { type: 'somethingNew', ts: 42, payload: 'opaque' }
      const result = normalizeFrame(unknown as Record<string, unknown>)
      expect(result).toEqual(unknown)
    })

    it('passes through records with no type field', () => {
      const noType = { ts: 42, foo: 'bar' }
      const result = normalizeFrame(noType as Record<string, unknown>)
      expect(result).toEqual(noType)
    })
  })

  describe('frzTemp edge cases', () => {
    it('returns null when fields are missing', () => {
      const partial = { type: 'frzTemp', ts: 1 }
      const result = normalizeFrame(partial as Record<string, unknown>)
      expect(result.left).toBeNull()
      expect(result.right).toBeNull()
      expect(result.amb).toBeNull()
      expect(result.hs).toBeNull()
    })

    it('treats float near -32768 sentinel as null (within 1 unit)', () => {
      // Exercises the `Math.abs(v - -32768) < 1` branch in cdToC.
      const nearSentinel = { type: 'frzTemp', ts: 1, left: -32767.5, right: 2225, amb: 2237, hs: 2531 }
      const result = normalizeFrame(nearSentinel as Record<string, unknown>)
      expect(result.left).toBeNull()
      expect(result.right).toBeCloseTo(22.25)
    })

    it.each([-32769, -32767])('does not classify the exclusive %s boundary as the sentinel', (value) => {
      const boundary = { type: 'frzTemp', ts: 1, left: value, right: 0, amb: 0, hs: 0 }
      const result = normalizeFrame(boundary as Record<string, unknown>)

      expect(result.left).toBe(value / 100)
    })

    it('does not treat the positive mirror of the -32768 sentinel as missing', () => {
      // Only the negative sentinel means "no sensor"; +32768 is a real reading.
      const mirrored = { type: 'frzTemp', ts: 1, left: 32768, right: 2225, amb: 2237, hs: 2531 }
      const result = normalizeFrame(mirrored as Record<string, unknown>)
      expect(result.left).toBeCloseTo(327.68)
    })

    it('treats non-numeric values as null', () => {
      // Exercises the `typeof v !== 'number'` branch in cdToC.
      const garbage = { type: 'frzTemp', ts: 1, left: 'oops', right: null, amb: undefined, hs: 2531 }
      const result = normalizeFrame(garbage as Record<string, unknown>)
      expect(result.left).toBeNull()
      expect(result.right).toBeNull()
      expect(result.amb).toBeNull()
      expect(result.hs).toBeCloseTo(25.31)
    })
  })

  describe('frzHealth edge cases', () => {
    it('coerces null/undefined RPM, duty, and current to 0', () => {
      // Exercises every `?? 0` fallback in frzHealth.
      const sparse = {
        type: 'frzHealth', ts: 100,
        left: {
          tec: { current: null },
          pump: { mode: 'pwm', rpm: null, water: false, duty: null },
        },
        right: {
          tec: { current: null },
          pump: { mode: 'pwm', rpm: null, water: false, duty: null },
        },
        fan: { top: { rpm: null, duty: null } },
      }
      const result = normalizeFrame(sparse as Record<string, unknown>)
      const left = result.left as Record<string, unknown>
      const right = result.right as Record<string, unknown>
      const fan = result.fan as Record<string, unknown>
      expect(left.pumpRpm).toBe(0)
      expect(left.pumpDuty).toBe(0)
      expect(left.tecCurrent).toBe(0)
      expect(left.flowrate).toBeNull()
      expect(right.pumpRpm).toBe(0)
      expect(right.pumpDuty).toBe(0)
      expect(right.tecCurrent).toBe(0)
      expect(right.flowrate).toBeNull()
      expect(fan.rpm).toBe(0)
      expect(fan.duty).toBe(0)
      expect(fan.bottomRpm).toBeNull()
    })

    it('extracts pump duty when present', () => {
      const withDuty = {
        type: 'frzHealth', ts: 100,
        left: {
          tec: { current: 2 },
          pump: { mode: 'pwm', rpm: 1800, water: true, duty: 65 },
          temps: { flowrate: 25.5 },
        },
        right: {
          tec: { current: 2 },
          pump: { mode: 'pwm', rpm: 1800, water: true, duty: 70 },
          temps: { flowrate: 25.5 },
        },
        fan: { top: { rpm: 500, duty: 50 }, bottom: { rpm: 300 } },
      }
      const result = normalizeFrame(withDuty as Record<string, unknown>)
      const left = result.left as Record<string, unknown>
      const right = result.right as Record<string, unknown>
      const fan = result.fan as Record<string, unknown>
      expect(left.pumpDuty).toBe(65)
      expect(right.pumpDuty).toBe(70)
      expect(fan.duty).toBe(50)
      expect(fan.bottomRpm).toBe(300)
    })

    it('returns null bottomRpm when fan.bottom is missing entirely', () => {
      const noBottom = {
        type: 'frzHealth', ts: 100,
        left: { tec: { current: 0 }, pump: { mode: 'pwm', rpm: 0, water: true } },
        right: { tec: { current: 0 }, pump: { mode: 'pwm', rpm: 0, water: true } },
        fan: { top: { rpm: 234 } },
      }
      const result = normalizeFrame(noBottom as Record<string, unknown>)
      const fan = result.fan as Record<string, unknown>
      expect(fan.bottomRpm).toBeNull()
    })

    it('defaults every left-side field when the whole side is absent', () => {
      const noLeft = {
        type: 'frzHealth', ts: 100,
        right: {
          tec: { current: 3 },
          pump: { mode: 'pwm', rpm: 1200, water: true, duty: 40 },
          temps: { flowrate: 23.5 },
        },
        fan: { top: { rpm: 500, duty: 50 }, bottom: { rpm: 250 } },
      }

      const result = normalizeFrame(noLeft as Record<string, unknown>)

      expect(result.left).toEqual({
        pumpRpm: 0,
        pumpDuty: 0,
        tecCurrent: 0,
        flowrate: null,
      })
    })

    it('defaults every right-side field when the whole side is absent', () => {
      const noRight = {
        type: 'frzHealth', ts: 100,
        left: {
          tec: { current: 3 },
          pump: { mode: 'pwm', rpm: 1200, water: true, duty: 40 },
          temps: { flowrate: 23.5 },
        },
        fan: { top: { rpm: 500, duty: 50 }, bottom: { rpm: 250 } },
      }

      const result = normalizeFrame(noRight as Record<string, unknown>)

      expect(result.right).toEqual({
        pumpRpm: 0,
        pumpDuty: 0,
        tecCurrent: 0,
        flowrate: null,
      })
    })

    it.each(['left', 'right'] as const)('defaults %s pump and TEC branches independently', (side) => {
      const sparseSide = { temps: { flowrate: 21.25 } }
      const frame = {
        type: 'frzHealth', ts: 100,
        left: side === 'left'
          ? sparseSide
          : { tec: { current: 1 }, pump: { mode: 'pwm', rpm: 900, water: true } },
        right: side === 'right'
          ? sparseSide
          : { tec: { current: 1 }, pump: { mode: 'pwm', rpm: 900, water: true } },
        fan: { top: { rpm: 500 } },
      }

      const result = normalizeFrame(frame as Record<string, unknown>)

      expect(result[side]).toEqual({
        pumpRpm: 0,
        pumpDuty: 0,
        tecCurrent: 0,
        flowrate: 21.25,
      })
    })

    it('defaults fan fields when the whole fan branch is absent', () => {
      const noFan = {
        type: 'frzHealth', ts: 100,
        left: { tec: { current: 0 }, pump: { mode: 'pwm', rpm: 0, water: true } },
        right: { tec: { current: 0 }, pump: { mode: 'pwm', rpm: 0, water: true } },
      }

      const result = normalizeFrame(noFan as Record<string, unknown>)

      expect(result.fan).toEqual({ rpm: 0, duty: 0, bottomRpm: null })
    })

    it('defaults top-fan fields when fan exists without a top branch', () => {
      const noTop = {
        type: 'frzHealth', ts: 100,
        left: { tec: { current: 0 }, pump: { mode: 'pwm', rpm: 0, water: true } },
        right: { tec: { current: 0 }, pump: { mode: 'pwm', rpm: 0, water: true } },
        fan: { bottom: { rpm: 250 } },
      }

      const result = normalizeFrame(noTop as Record<string, unknown>)

      expect(result.fan).toEqual({ rpm: 0, duty: 0, bottomRpm: 250 })
    })
  })

  describe('frzTherm edge cases', () => {
    it('accepts plain numeric left/right (legacy firmware)', () => {
      // Exercises the `typeof wire.left === 'number'` true branch.
      const numeric = { type: 'frzTherm', ts: 1, left: -0.5, right: 0.25 }
      const result = normalizeFrame(numeric as Record<string, unknown>)
      expect(result.left).toBe(-0.5)
      expect(result.right).toBe(0.25)
    })

    it('coerces null power to 0', () => {
      // Exercises the `?? 0` fallback when the .power field is null.
      const nullPower = {
        type: 'frzTherm', ts: 1,
        left: { target: 23, power: null, valid: true, enabled: true },
        right: { target: 27, power: null, valid: true, enabled: false },
      }
      const result = normalizeFrame(nullPower as Record<string, unknown>)
      expect(result.left).toBe(0)
      expect(result.right).toBe(0)
    })

    it('mixes numeric left with object right', () => {
      const mixed = {
        type: 'frzTherm', ts: 1,
        left: -0.75,
        right: { target: 27, power: 0.5, valid: true, enabled: true },
      }
      const result = normalizeFrame(mixed as Record<string, unknown>)
      expect(result.left).toBe(-0.75)
      expect(result.right).toBe(0.5)
    })

    it('defaults missing sides and preserves the canonical type', () => {
      const result = normalizeFrame({ type: 'frzTherm', ts: 1 })

      expect(result).toEqual({ type: 'frzTherm', ts: 1, left: 0, right: 0 })
    })
  })

  describe('bedTemp2 edge cases', () => {
    it('defaults left/right to empty objects when both sides are missing', () => {
      // Exercises `rec.left ?? {}`, `rec.right ?? {}`, and `temps ?? []` fallbacks.
      const empty = { type: 'bedTemp2', ts: 1 }
      const result = normalizeFrame(empty as Record<string, unknown>)
      expect(result.ambientTemp).toBeNull()
      expect(result.humidity).toBeNull()
      expect(result.mcuTemp).toBeNull()
      expect(result.leftOuterTemp).toBeNull()
      expect(result.leftCenterTemp).toBeNull()
      expect(result.leftInnerTemp).toBeNull()
      expect(result.rightOuterTemp).toBeNull()
      expect(result.rightCenterTemp).toBeNull()
      expect(result.rightInnerTemp).toBeNull()
    })

    it('falls back to right.amb/hu when left side is sentinel', () => {
      // Exercises the `?? safeNum(right.amb)` and `?? safeNum(right.hu)` branches.
      const leftSentinel = {
        type: 'bedTemp2', ts: 1,
        left: { amb: -327.68, hu: -327.68, temps: [] },
        right: { amb: 22.5, hu: 48, temps: [] },
      }
      const result = normalizeFrame(leftSentinel as Record<string, unknown>)
      expect(result.ambientTemp).toBeCloseTo(22.5)
      expect(result.humidity).toBeCloseTo(48)
    })

    it('treats non-numeric temps array entries as null', () => {
      // Exercises the `typeof v === 'number'` false branch inside safeNum.
      const oddTemps = {
        type: 'bedTemp2', ts: 1,
        left: { temps: ['nope', null, undefined] },
        right: { temps: [22, 'bad', 24] },
      }
      const result = normalizeFrame(oddTemps as Record<string, unknown>)
      expect(result.leftOuterTemp).toBeNull()
      expect(result.leftCenterTemp).toBeNull()
      expect(result.leftInnerTemp).toBeNull()
      expect(result.rightOuterTemp).toBeCloseTo(22)
      expect(result.rightCenterTemp).toBeNull()
      expect(result.rightInnerTemp).toBeCloseTo(24)
    })

    it('treats the -327.68 sentinel as null with float tolerance', () => {
      // Exercises the `Math.abs(v - NO_SENSOR) < 0.01` close-match branch.
      const near = {
        type: 'bedTemp2', ts: 1,
        left: { temps: [-327.679, -327.681, 26] },
        right: { temps: [] },
      }
      const result = normalizeFrame(near as Record<string, unknown>)
      expect(result.leftOuterTemp).toBeNull()
      expect(result.leftCenterTemp).toBeNull()
      expect(result.leftInnerTemp).toBeCloseTo(26)
    })
  })

  describe('bedTemp v1 edge cases', () => {
    it('defaults left/right to empty objects when both sides are missing', () => {
      // Exercises `rec.left ?? {}` / `rec.right ?? {}` when the side is absent.
      const empty = { type: 'bedTemp', ts: 1 }
      const result = normalizeFrame(empty as Record<string, unknown>)
      expect(result.ambientTemp).toBeNull()
      expect(result.mcuTemp).toBeNull()
      expect(result.humidity).toBeNull()
      expect(result.leftOuterTemp).toBeNull()
      expect(result.rightInnerTemp).toBeNull()
    })

    it('treats -32768 sentinel as null in centidegree fields', () => {
      const sentinel = {
        type: 'bedTemp', ts: 1,
        amb: -32768, mcu: 3428, hu: -32768,
        left: { out: -32768, cen: 2301, in: 2359 },
        right: { out: 2351, cen: -32768, in: 2396 },
      }
      const result = normalizeFrame(sentinel as Record<string, unknown>)
      expect(result.ambientTemp).toBeNull()
      expect(result.humidity).toBeNull()
      expect(result.leftOuterTemp).toBeNull()
      expect(result.rightCenterTemp).toBeNull()
      expect(result.mcuTemp).toBeCloseTo(34.28)
    })
  })

  describe('capSense2 edge cases', () => {
    it('defaults left/right to empty objects when both sides are missing', () => {
      // Falls through every `?? {}` / `?? left` / Array.isArray fallback.
      const empty = { type: 'capSense2', ts: 1 }
      const result = normalizeFrame(empty as Record<string, unknown>)
      expect(result.left).toEqual([])
      expect(result.right).toEqual([])
      expect(result.status).toBeUndefined()
    })

    it('accepts numeric sides (legacy single-value frame)', () => {
      // Exercises the `typeof rec.left === 'number'` branch.
      const numeric = { type: 'capSense2', ts: 1, left: 12.5, right: 14.25 }
      const result = normalizeFrame(numeric as Record<string, unknown>)
      expect(result.left).toEqual([12.5])
      expect(result.right).toEqual([14.25])
    })

    it('falls back to right.status when neither rec.status nor left.status is set', () => {
      // Exercises the right.status branch of the `?? ... ??` fallback chain.
      const onlyRight = {
        type: 'capSense2', ts: 1,
        left: { values: [1, 2, 3] },
        right: { values: [4, 5, 6], status: 'good' },
      }
      const result = normalizeFrame(onlyRight as Record<string, unknown>)
      expect(result.status).toBe('good')
    })

    it('prefers rec.status when set at the top level', () => {
      // Exercises the leading `rec.status ??` branch.
      const topStatus = {
        type: 'capSense2', ts: 1, status: 'warn',
        left: { values: [1], status: 'good' },
        right: { values: [2], status: 'good' },
      }
      const result = normalizeFrame(topStatus as Record<string, unknown>)
      expect(result.status).toBe('warn')
    })

    it('returns empty arrays when sides are objects without values keys', () => {
      // Exercises the `left.values ?? left` fallback. When the side is a plain
      // object with no `values` key (and no numeric coercion path), the result
      // is an empty array — never a stale non-array reference.
      const noValues = {
        type: 'capSense2', ts: 1,
        left: { status: 'good' },
        right: { status: 'good' },
      }
      const result = normalizeFrame(noValues as Record<string, unknown>)
      expect(result.left).toEqual([])
      expect(result.right).toEqual([])
    })
  })
})

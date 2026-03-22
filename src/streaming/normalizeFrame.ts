/**
 * Frame normalization — transforms raw firmware CBOR payloads into the
 * flat SensorFrame interfaces consumed by the React UI.
 *
 * The firmware wire format uses nested objects (e.g. left.pump.rpm,
 * left.tec.current, fan.top.rpm). This module flattens them into the
 * interfaces defined in useSensorStream.ts.
 *
 * Firmware wire types are defined here so TypeScript catches mismatches.
 * If the firmware struct changes, update the Wire* interfaces AND the
 * normalizer — the tests will catch the rest.
 */

// ---------------------------------------------------------------------------
// Firmware wire types (what CBOR decode actually produces)
// ---------------------------------------------------------------------------

/** frzHealth as the firmware writes it to RAW files. */
export interface WireFrzHealth {
  type: 'frzHealth'
  ts: number
  version?: number
  left: {
    tec: { current: number }
    pump: { mode: string; rpm: number; water: boolean; duty?: number }
    temps?: { flowrate?: number }
  }
  right: {
    tec: { current: number }
    pump: { mode: string; rpm: number; water: boolean; duty?: number }
    temps?: { flowrate?: number }
  }
  fan: {
    top: { rpm: number; duty?: number }
    bottom?: { rpm: number }
  }
}

/** frzTherm as the firmware writes it. */
export interface WireFrzTherm {
  type: 'frzTherm'
  ts: number
  version?: number
  left: { target: number; power: number; valid: boolean; enabled: boolean } | number
  right: { target: number; power: number; valid: boolean; enabled: boolean } | number
}

/** frzTemp as the firmware writes it (centidegrees integers). */
export interface WireFrzTemp {
  type: 'frzTemp'
  ts: number
  left: number
  right: number
  amb: number
  hs: number
}

/** bedTemp/bedTemp2 as the firmware writes it. */
export interface WireBedTemp {
  type: 'bedTemp' | 'bedTemp2'
  ts: number
  mcu?: number
  left: {
    amb?: number
    hu?: number
    board?: number
    temps: number[]
  }
  right: {
    amb?: number
    hu?: number
    board?: number
    temps: number[]
  }
}

/** capSense2 as the firmware writes it. */
export interface WireCapSense2 {
  type: 'capSense2'
  ts: number
  left: { values: number[]; status?: string } | number
  right: { values: number[]; status?: string } | number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_SENSOR = -327.68

function isSentinel(v: unknown): boolean {
  return v === null || v === undefined || v === NO_SENSOR ||
    (typeof v === 'number' && Math.abs(v - NO_SENSOR) < 0.01)
}

function safeNum(v: unknown): number | null {
  if (isSentinel(v)) return null
  return typeof v === 'number' ? v : null
}

function cdToC(v: unknown): number | null {
  if (v === null || v === undefined || typeof v !== 'number') return null
  return v / 100
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export function normalizeFrame(rec: Record<string, unknown>): Record<string, unknown> {
  switch (rec.type) {
    case 'bedTemp':
    case 'bedTemp2': {
      const left = (rec.left ?? {}) as Record<string, unknown>
      const right = (rec.right ?? {}) as Record<string, unknown>
      const leftTemps = (left.temps ?? []) as number[]
      const rightTemps = (right.temps ?? []) as number[]
      return {
        type: rec.type, ts: rec.ts,
        ambientTemp: safeNum(left.amb) ?? safeNum(right.amb),
        mcuTemp: safeNum(rec.mcu),
        humidity: safeNum(left.hu) ?? safeNum(right.hu),
        leftOuterTemp: safeNum(leftTemps[0]),
        leftCenterTemp: safeNum(leftTemps[1]),
        leftInnerTemp: safeNum(leftTemps[2]),
        rightOuterTemp: safeNum(rightTemps[0]),
        rightCenterTemp: safeNum(rightTemps[1]),
        rightInnerTemp: safeNum(rightTemps[2]),
      }
    }
    case 'frzTemp':
      return {
        type: 'frzTemp', ts: rec.ts,
        left: cdToC(rec.left), right: cdToC(rec.right),
        amb: cdToC(rec.amb), hs: cdToC(rec.hs),
      }
    case 'frzHealth': {
      const wire = rec as unknown as WireFrzHealth
      return {
        type: 'frzHealth', ts: wire.ts,
        left: {
          pumpRpm: wire.left.pump.rpm ?? 0,
          pumpDuty: wire.left.pump.duty ?? 0,
          tecCurrent: wire.left.tec.current ?? 0,
        },
        right: {
          pumpRpm: wire.right.pump.rpm ?? 0,
          pumpDuty: wire.right.pump.duty ?? 0,
          tecCurrent: wire.right.tec.current ?? 0,
        },
        fan: {
          rpm: wire.fan.top.rpm ?? 0,
          duty: wire.fan.top.duty ?? 0,
        },
      }
    }
    case 'frzTherm': {
      const wire = rec as unknown as WireFrzTherm
      const leftVal = typeof wire.left === 'number' ? wire.left : wire.left.power
      const rightVal = typeof wire.right === 'number' ? wire.right : wire.right.power
      return {
        type: 'frzTherm', ts: wire.ts,
        left: leftVal ?? 0,
        right: rightVal ?? 0,
      }
    }
    case 'capSense2': {
      const left = (rec.left ?? {}) as Record<string, unknown>
      const right = (rec.right ?? {}) as Record<string, unknown>
      const leftVals = (left.values ?? left) as number[] | unknown
      const rightVals = (right.values ?? right) as number[] | unknown
      return {
        type: rec.type, ts: rec.ts,
        left: Array.isArray(leftVals) ? leftVals : (typeof rec.left === 'number' ? [rec.left] : []),
        right: Array.isArray(rightVals) ? rightVals : (typeof rec.right === 'number' ? [rec.right] : []),
        status: rec.status ?? left.status ?? right.status,
      }
    }
    default:
      return rec
  }
}

/**
 * Turn a curve (set points for some sides and days) into the schedule rows
 * that replace those days. Shared by the schedule editor and the MCP
 * apply_sleep_curve tool so both write exactly the same rows.
 */
import type { SetPoint } from '@/src/lib/scheduleGrouping'
import { simplifySetPoints } from '@/src/lib/scheduleGrouping'
import type { DayOfWeek } from '@/src/lib/scheduleTime'

type Side = 'left' | 'right'
export type CurveEndAction = 'turn_off' | 'maintain'

interface ExistingRow {
  id: number
  dayOfWeek: string
}

export interface CurvePowerWindow {
  onTime: string
  offTime: string
  onTemperature: number
  endAction: CurveEndAction
}

export interface CurveSavePlan {
  /** Chronological set points with flat-hold rows dropped. */
  setPoints: SetPoint[]
  /** Auto on/off window, or null when the curve cannot define one. */
  power: CurvePowerWindow | null
  deletes: { temperature: number[], power: number[] }
  creates: {
    temperature: Array<{ side: Side, dayOfWeek: DayOfWeek, time: string, temperature: number, enabled: boolean }>
    power: Array<{ side: Side, dayOfWeek: DayOfWeek, onTime: string, offTime: string, endAction: CurveEndAction, onTemperature: number, enabled: boolean }>
  }
}

/**
 * Every temperature and power row on `clearDays` (default: the target days)
 * is deleted; alarms are left alone. The on/off window comes from the
 * chronologically-first and -last set points (with overnight wrap), so the
 * schedule respects a sleep window instead of running 24/7.
 *
 * `existing` must hold only rows of the sides being written.
 */
export function planCurveSave({
  sides,
  targetDays,
  clearDays = targetDays,
  setPoints,
  endAction = 'turn_off',
  existing,
}: {
  sides: Side[]
  targetDays: DayOfWeek[]
  clearDays?: DayOfWeek[]
  setPoints: SetPoint[]
  endAction?: CurveEndAction
  existing: { temperature: ExistingRow[], power: ExistingRow[] }
}): CurveSavePlan {
  const daysToClear = new Set<string>([...clearDays, ...targetDays])
  const deletes = {
    temperature: existing.temperature.filter(t => daysToClear.has(t.dayOfWeek)).map(t => t.id),
    power: existing.power.filter(p => daysToClear.has(p.dayOfWeek)).map(p => p.id),
  }

  // Rows inside a flat hold are dropped; they never change what the Pod does.
  const sortedPoints = simplifySetPoints(setPoints)
  const onTime = sortedPoints[0]?.time
  const offTime = sortedPoints[sortedPoints.length - 1]?.time
  const onTemperature = sortedPoints[0]?.temperature
  const power = onTime && offTime && onTemperature !== undefined && (onTime !== offTime || endAction === 'maintain')
    ? { onTime, offTime, onTemperature: Math.round(Math.max(55, Math.min(110, onTemperature))), endAction }
    : null

  const creates: CurveSavePlan['creates'] = { temperature: [], power: [] }
  for (const side of sides) {
    for (const day of targetDays) {
      for (const sp of sortedPoints) {
        creates.temperature.push({ side, dayOfWeek: day, time: sp.time, temperature: Math.round(sp.temperature), enabled: true })
      }
      if (power) creates.power.push({ side, dayOfWeek: day, ...power, enabled: true })
    }
  }

  return { setPoints: sortedPoints, power, deletes, creates }
}

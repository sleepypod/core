/**
 * Signal sources for the automation engine.
 *
 * A `SignalReader` returns a synchronous snapshot of currently-available
 * numeric signals keyed by the catalog names in docs/adr/0023-autopilot-reactive-automations.md. Any
 * signal not present resolves to `undefined`, which makes dependent conditions
 * skip rather than fire on stale/missing data.
 *
 * P0 wires the device-status signals that are reliably available now (per-side
 * temperature/level from the live DAC monitor). Ambient and biometric signals
 * are part of the catalog but read `undefined` until their sources are wired in
 * a later phase — the engine degrades to "skip", which is the safe default.
 */

import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import type { AutomationRule, DayOfWeek, Expr, Side } from './types'

export type SignalSnapshot = Record<string, number | undefined>

/** Per-side rolling vitals baseline (mean + SD) from `getVitalsBaseline`. */
export interface SideBaseline {
  hrMean?: number
  hrSD?: number
  hrvMean?: number
  hrvSD?: number
  brMean?: number
  brSD?: number
}
export type BaselineMap = Partial<Record<Side, SideBaseline>>

/** Vital metric → which baseline mean/SD fields back its z-score. */
const ZSCORE_FIELDS: Record<string, { mean: keyof SideBaseline, sd: keyof SideBaseline }> = {
  heartRate: { mean: 'hrMean', sd: 'hrSD' },
  hrv: { mean: 'hrvMean', sd: 'hrvSD' },
  breathingRate: { mean: 'brMean', sd: 'brSD' },
}

/**
 * Resolve a signal key against the live snapshot, computing derived
 * `{side}.{vital}.zscore` signals from the snapshot's raw vital and the
 * supplied baselines: `(value − mean) / SD`. Returns `undefined` (→ skip) when
 * the raw value, the baseline, or a positive SD is missing.
 */
export function resolveSignal(
  get: (key: string) => number | undefined,
  key: string,
  baselines?: BaselineMap,
): number | undefined {
  const direct = get(key)
  if (direct !== undefined) return direct
  if (key.endsWith('.zscore')) return zScore(get, key, baselines)
  return undefined
}

function zScore(
  get: (key: string) => number | undefined,
  key: string,
  baselines?: BaselineMap,
): number | undefined {
  const parts = key.split('.')
  if (parts.length !== 3) return undefined
  const [side, metric] = parts
  if (side !== 'left' && side !== 'right') return undefined
  const fields = ZSCORE_FIELDS[metric]
  if (!fields) return undefined
  const base = baselines?.[side]
  if (!base) return undefined
  const mean = base[fields.mean]
  const sd = base[fields.sd]
  if (mean === undefined || sd === undefined || sd <= 0) return undefined
  const raw = get(`${side}.${metric}`)
  if (raw === undefined) return undefined
  return (raw - mean) / sd
}

export interface SignalReader {
  /** Snapshot the numeric signals available this instant. */
  read: () => SignalSnapshot
}

const DAYS: DayOfWeek[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

/** Timezone-aware wall clock: minutes since local midnight + day of week. */
export function clockInTimezone(
  timezone: string,
  now: Date,
): { nowMinutes: number, dayOfWeek: DayOfWeek } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(now)
  const get = (type: string): string => {
    const part = parts.find(p => p.type === type)
    if (!part) throw new Error(`Invalid timezone: ${timezone}`)
    return part.value
  }
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  const weekday = get('weekday') // e.g. "Mon"
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)
  if (dayIndex < 0) throw new Error(`Unexpected weekday token: ${weekday}`)
  return { nowMinutes: hour * 60 + minute, dayOfWeek: DAYS[dayIndex] }
}

/**
 * Production reader backed by the live DAC monitor's last status frame. Reads
 * are lazy-imported so the engine module stays decoupled from hardware in tests.
 */
export class DeviceSignalReader implements SignalReader {
  read(): SignalSnapshot {
    const snapshot: SignalSnapshot = {}
    try {
      const status = getDacMonitorIfRunning()?.getLastStatus()
      if (!status) return snapshot
      for (const side of ['left', 'right'] as const) {
        const s = side === 'left' ? status.leftSide : status.rightSide
        if (!s) continue
        // null = level 0 (off); leave the signal absent so conditions don't
        // fire against a phantom neutral temperature.
        snapshot[`${side}.currentTemperature`] = s.currentTemperature ?? undefined
        snapshot[`${side}.targetTemperature`] = s.targetTemperature ?? undefined
        snapshot[`${side}.currentLevel`] = s.currentLevel
      }
      if (status.waterLevel === 'low' || status.waterLevel === 'ok') {
        snapshot['water.low'] = status.waterLevel === 'low' ? 1 : 0
      }
    }
    catch (err) {
      // A genuine read failure (the "monitor not running" case returns early
      // above). Surface it rather than swallowing; the empty snapshot makes
      // dependent rules skip, which we don't want to do silently.
      console.warn('[automation] DeviceSignalReader.read failed:', err)
    }
    return snapshot
  }
}

/** Walk an expression tree collecting the signal keys referenced by windows. */
function collectWindowKeysFromExpr(expr: Expr, out: Set<string>): void {
  switch (expr.kind) {
    case 'window':
      out.add(expr.signal)
      break
    case 'binary':
      collectWindowKeysFromExpr(expr.left, out)
      collectWindowKeysFromExpr(expr.right, out)
      break
    case 'clamp':
      collectWindowKeysFromExpr(expr.value, out)
      collectWindowKeysFromExpr(expr.min, out)
      collectWindowKeysFromExpr(expr.max, out)
      break
  }
}

/**
 * The set of signal keys any enabled rule aggregates over a window. The engine
 * samples exactly these each tick to feed the `WindowStore`.
 */
export function collectWindowSignals(rules: AutomationRule[]): Set<string> {
  const out = new Set<string>()
  const walkCond = (c: AutomationRule['conditions']): void => {
    switch (c.kind) {
      case 'and':
      case 'or':
        c.conditions.forEach(walkCond)
        break
      case 'not':
        walkCond(c.condition)
        break
      case 'compare':
        collectWindowKeysFromExpr(c.left, out)
        collectWindowKeysFromExpr(c.right, out)
        break
      case 'between':
        collectWindowKeysFromExpr(c.subject, out)
        collectWindowKeysFromExpr(c.min, out)
        collectWindowKeysFromExpr(c.max, out)
        break
      case 'hysteresis':
        collectWindowKeysFromExpr(c.subject, out)
        break
      case 'sustained':
        walkCond(c.condition)
        break
    }
  }
  for (const rule of rules) {
    if (!rule.enabled) continue
    walkCond(rule.conditions)
    for (const action of rule.actions) {
      if (action.kind === 'setTemperature') collectWindowKeysFromExpr(action.temp, out)
      if (action.kind === 'setPower' && action.temp) collectWindowKeysFromExpr(action.temp, out)
    }
  }
  return out
}

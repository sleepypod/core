/**
 * Signal sources for the automation engine.
 *
 * A `SignalReader` returns a synchronous snapshot of currently-available
 * numeric signals keyed by the catalog names in docs/adr/0023-autopilot-reactive-automations.md. Any
 * signal not present resolves to `undefined`, which makes dependent conditions
 * skip rather than fire on stale/missing data.
 *
 * The DAC reader supplies fresh device status; the companion biometrics reader
 * supplies timestamped environmental, occupancy and biometric measurements.
 */

import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import type { AutomationRule, DayOfWeek, Expr } from './types'
import { finiteSignal } from './signalValidity'

export type SignalSnapshot = Record<string, number | undefined>

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

/** Timezone-aware wall clock: minutes since local midnight + day of week +
 * local calendar date (used to key "already fired today" per actual day). */
export function clockInTimezone(
  timezone: string,
  now: Date,
): { nowMinutes: number, dayOfWeek: DayOfWeek, dateKey: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
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
  return {
    nowMinutes: hour * 60 + minute,
    dayOfWeek: DAYS[dayIndex],
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
  }
}

/**
 * Production reader backed by a healthy, unchanged DAC observation. Fifteen
 * seconds covers the monitor's slowest five-second polling cadence.
 */
export class DeviceSignalReader implements SignalReader {
  read(): SignalSnapshot {
    const snapshot: SignalSnapshot = {}
    try {
      const status = getDacMonitorIfRunning()?.getFreshStatus(15_000)
      if (!status) return snapshot
      for (const side of ['left', 'right'] as const) {
        const reading = side === 'left' ? status.leftSide : status.rightSide
        if (!reading) continue
        // null = level 0 (off); leave the signal absent so conditions don't
        // fire against a phantom neutral temperature.
        snapshot[`${side}.currentTemperature`] = finiteSignal(reading.currentTemperature)
        snapshot[`${side}.targetTemperature`] = finiteSignal(reading.targetTemperature)
        snapshot[`${side}.currentLevel`] = finiteSignal(reading.currentLevel)
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

/**
 * Merge several readers into one snapshot. Readers are applied in order, so a
 * later reader overrides an earlier one on key collision — keep the
 * authoritative source last (e.g. the live DAC reader's `water.low`).
 */
export class CompositeSignalReader implements SignalReader {
  constructor(private readonly readers: SignalReader[]) {}

  read(): SignalSnapshot {
    const out: SignalSnapshot = {}
    for (const reader of this.readers) Object.assign(out, reader.read())
    return out
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

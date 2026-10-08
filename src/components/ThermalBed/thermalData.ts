import type { BedTempFrame, BedTemp2Frame } from '@/src/hooks/useSensorStream'

export type ThermalView = 'overview' | 'regions'
export const meanTemperature = (zones: Zones): number | null => {
  const values = zones.filter((value): value is number => value !== null && Number.isFinite(value))
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

export type ThermalSide = 'left' | 'right'
export type Zones = [number | null, number | null, number | null]
export interface ThermalReading {
  ts: number
  left: Zones
  right: Zones
  source: 'live' | 'stored'
}
export interface ThermalControl {
  currentTemperature: number | null
  targetTemperature: number | null
  targetLevel: number
}
/**
 * What the pod is doing to a side right now, as the firmware reports it. The surface
 * readings are a separate question: a side can be warming while its sensors are stale.
 */
export type ThermalMode = 'unavailable' | 'off' | 'paused' | 'waiting' | 'cooling' | 'heating' | 'holding'
export interface ThermalState {
  zones: Zones
  /** Requested change of the water, for the field's moving tint; 0 whenever readings are missing. */
  direction: -1 | 0 | 1
  strength: number
  mode: ThermalMode
  /** Setpoint in °F while the side is on; null otherwise. */
  targetF: number | null
  /** The firmware's current water temperature in °F; null when unknown. */
  currentF: number | null
}
export const THERMAL_STALE_SECONDS = 90
export const finiteTemperature = (value: number | null | undefined): number | null =>
  value != null && Number.isFinite(value) ? value : null

export const THERMAL_LABELS: Record<ThermalMode, string> = {
  unavailable: 'Unavailable',
  off: 'Off',
  paused: 'Paused',
  waiting: 'Waiting for status',
  cooling: 'Cooling',
  heating: 'Warming',
  holding: 'At target',
}

interface StoredReading {
  timestamp: Date
  leftOuterTemp: number | null
  leftCenterTemp: number | null
  leftInnerTemp: number | null
  rightOuterTemp: number | null
  rightCenterTemp: number | null
  rightInnerTemp: number | null
}

/** Both transports are requested in Celsius. Newest timestamp wins, including across generations. */
export function latestThermalReading(oldFrame?: BedTempFrame, newFrame?: BedTemp2Frame, stored?: StoredReading | null): ThermalReading | null {
  const candidates: ThermalReading[] = []
  for (const frame of [oldFrame, newFrame, stored]) {
    if (!frame) continue
    const ts = 'ts' in frame ? frame.ts : frame.timestamp.getTime() / 1000
    if (!Number.isFinite(ts)) continue
    candidates.push({
      ts,
      left: [finiteTemperature(frame.leftOuterTemp), finiteTemperature(frame.leftCenterTemp), finiteTemperature(frame.leftInnerTemp)],
      right: [finiteTemperature(frame.rightOuterTemp), finiteTemperature(frame.rightCenterTemp), finiteTemperature(frame.rightInnerTemp)],
      source: 'ts' in frame ? 'live' : 'stored',
    })
  }
  return candidates.sort((a, b) => b.ts - a.ts)[0] ?? null
}

/**
 * Direction describes the requested change, not a claim that water is flowing. The mode
 * comes from the controller alone, so the status stays truthful while the surface sensors
 * are stale; only the field's tint waits for readings.
 */
export function thermalState(zones: Zones, control: ThermalControl | undefined, stale: boolean, blocked = false): ThermalState {
  const current = finiteTemperature(control?.currentTemperature)
  const target = finiteTemperature(control?.targetTemperature)
  const powered = control !== undefined && control.targetLevel !== 0
  const delta = powered && !blocked && current !== null && target !== null ? target - current : 0
  const requested = delta > 0.5 ? 1 : delta < -0.5 ? -1 : 0
  const mode: ThermalMode = !control
    ? 'unavailable'
    : !powered
        ? 'off'
        : blocked
          ? 'paused'
          : current === null || target === null
            ? 'waiting'
            : requested < 0 ? 'cooling' : requested > 0 ? 'heating' : 'holding'
  const direction = stale ? 0 : requested
  // Any active side gets a clearly visible tint; the gap to target only adds to it.
  const strength = direction ? 0.5 + 0.5 * Math.min(Math.abs(delta) / 8, 1) : 0
  return { zones: stale ? [null, null, null] : zones, direction, strength, mode, targetF: powered ? target : null, currentF: current }
}

/**
 * Five pastel stops from 18 to 36°C so the midpoints never go muddy: the ends sit near the
 * app's cool and warm accents, the middle is the cover's own grey. "No reading" is that grey,
 * so the label, not the colour, carries the difference.
 */
export const THERMAL_RAMP = {
  dark: ['#6ea9de', '#7a9ab8', '#75777b', '#b98c78', '#e0956f'],
  light: ['#8fc0ea', '#a2bcd4', '#b7b8ba', '#d2a898', '#eaa98e'],
} as const
export type ThermalTheme = keyof typeof THERMAL_RAMP
export const thermalLegend = (theme: ThermalTheme = 'dark') => `linear-gradient(to right, ${THERMAL_RAMP[theme].join(', ')})`
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

/** Fixed 18–36°C scale; never recolor an unchanged sensor when its neighbour changes. */
export function thermalColor(celsius: number | null, theme: ThermalTheme = 'dark'): string {
  const stops = THERMAL_RAMP[theme]
  if (finiteTemperature(celsius) === null) return stops[2]
  const t = Math.max(0, Math.min(1, ((celsius as number) - 18) / 18)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(t))
  const a = rgb(stops[i])
  const b = rgb(stops[i + 1])
  const blend = t - i
  return `#${a.map((value, k) => Math.round(value + (b[k] - value) * blend).toString(16).padStart(2, '0')).join('')}`
}

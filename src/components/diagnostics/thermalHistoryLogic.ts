import type { ThermalHistoryPoint, ThermalSeriesKey } from '@/src/lib/thermalHistory'

/** One downsampled moment on the Thermal page (°F temps, rpm). */
export type HistoryPoint = ThermalHistoryPoint
export type ThermalAvailability = Record<ThermalSeriesKey, boolean>
type NumKey = Exclude<keyof HistoryPoint, 't'>

export interface SeriesDef {
  key: NumKey
  side?: 'left' | 'right'
  label: string
  dashed?: boolean
  color?: string
}

export interface PanelDef {
  id: ThermalSeriesKey
  label: string
  kind: 'temp' | 'rpm'
  height: number
  series: SeriesDef[]
}

export const THERMAL_PANELS: PanelDef[] = [
  {
    id: 'bedTarget',
    label: 'Bed and target',
    kind: 'temp',
    height: 150,
    series: [
      { key: 'leftBed', side: 'left', label: 'bed' },
      { key: 'rightBed', side: 'right', label: 'bed' },
      { key: 'leftTarget', side: 'left', label: 'target', dashed: true },
      { key: 'rightTarget', side: 'right', label: 'target', dashed: true },
    ],
  },
  {
    id: 'water',
    label: 'Water',
    kind: 'temp',
    height: 80,
    series: [
      { key: 'leftWater', side: 'left', label: 'water' },
      { key: 'rightWater', side: 'right', label: 'water' },
    ],
  },
  {
    id: 'surface',
    label: 'Surface',
    kind: 'temp',
    height: 80,
    series: [
      { key: 'leftSurface', side: 'left', label: 'surface' },
      { key: 'rightSurface', side: 'right', label: 'surface' },
    ],
  },
  {
    id: 'pump',
    label: 'Pump rpm',
    kind: 'rpm',
    height: 80,
    series: [
      { key: 'leftRpm', side: 'left', label: 'rpm' },
      { key: 'rightRpm', side: 'right', label: 'rpm' },
    ],
  },
  {
    id: 'hub',
    label: 'Hub',
    kind: 'temp',
    height: 80,
    series: [
      { key: 'heatsink', label: 'heatsink', color: 'var(--accent-warm)' },
      { key: 'ambient', label: 'ambient', color: 'var(--accent-cool)' },
    ],
  },
]

export interface Domain { min: number, max: number, ticks: number[] }

/**
 * Y range and gridline values for a panel, or null when it has nothing to
 * draw. Temperatures are converted with `toUnit` first so ticks land on
 * round numbers in the user's unit; pump speed always starts at zero.
 */
export function panelDomain(panel: PanelDef, points: HistoryPoint[], toUnit: (f: number) => number = f => f): Domain | null {
  const vals: number[] = []
  for (const p of points) {
    for (const s of panel.series) {
      const v = p[s.key]
      if (v != null) vals.push(panel.kind === 'temp' ? toUnit(v) : v)
    }
  }
  if (vals.length === 0) return null
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  if (panel.kind === 'rpm') {
    const max = Math.max(1000, Math.ceil(hi / 1000) * 1000)
    return { min: 0, max, ticks: [0, max / 2, max].filter((v, i, a) => a.indexOf(v) === i) }
  }
  const span = hi - lo
  const step = span <= 4 ? 2 : span <= 12 ? 4 : span <= 30 ? 10 : 20
  lo = Math.floor((lo - 1) / step) * step
  hi = Math.ceil((hi + 1) / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 10) / 10)
  return { min: lo, max: hi, ticks }
}

/**
 * SVG path for one series across a `width`×100 box. The line breaks wherever
 * neighbouring samples are further apart than `gapMs`, so missing data shows
 * as a gap instead of a straight line across it.
 */
export function seriesPath(points: HistoryPoint[], key: NumKey, from: number, span: number, width: number, d: Domain, gapMs: number, toUnit?: (f: number) => number): string {
  let out = ''
  let prevT: number | null = null
  const range = d.max - d.min || 1
  for (const p of points) {
    const raw = p[key]
    if (raw == null) {
      prevT = null
      continue
    }
    const v = toUnit ? toUnit(raw) : raw
    const x = ((p.t - from) / span) * width
    const y = (1 - (v - d.min) / range) * 100
    const move = prevT == null || p.t - prevT > gapMs
    out += `${move ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(2)}`
    prevT = p.t
  }
  return out
}

export function nearestPoint(points: HistoryPoint[], t: number): HistoryPoint | null {
  let best: HistoryPoint | null = null
  for (const p of points) {
    if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p
  }
  return best
}

const MIN = 60_000
const HOUR = 60 * MIN
const TICK_STEPS = [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR]

/** Round local-time ticks, at most ~6 across the window. */
export function hourTicks(from: number, to: number): number[] {
  const span = to - from
  const step = TICK_STEPS.find(s => span / s <= 6) ?? 24 * HOUR
  const offset = new Date(from).getTimezoneOffset() * MIN
  const first = Math.ceil((from - offset) / step) * step + offset
  const out: number[] = []
  for (let t = first; t <= to; t += step) out.push(t)
  return out
}

/** Live-mode buffer entry: the health.thermal payload stamped on arrival. */
export interface LiveThermalSample {
  t: number
  heatsinkTempF?: number | null
  ambientTempF?: number | null
  sides: Array<{
    side: string
    isPowered: boolean
    targetTempF: number | null
    currentTempF: number | null
    waterTempF: number | null
    bedSurfaceTempF?: number | null
    pumpRpm?: number | null
    poweredOnAt?: string | null
  }>
}

/** Map the in-memory 5 s thermal buffer onto the history point shape. */
export function liveToPoints(buffer: LiveThermalSample[]): HistoryPoint[] {
  return buffer.map((h) => {
    const s = (side: 'left' | 'right') => h.sides.find(x => x.side === side)
    const l = s('left')
    const r = s('right')
    return {
      t: h.t,
      leftBed: l?.isPowered ? l.currentTempF : null,
      rightBed: r?.isPowered ? r.currentTempF : null,
      leftTarget: l?.isPowered ? l.targetTempF : null,
      rightTarget: r?.isPowered ? r.targetTempF : null,
      leftWater: l?.waterTempF ?? null,
      rightWater: r?.waterTempF ?? null,
      leftSurface: l?.bedSurfaceTempF ?? null,
      rightSurface: r?.bedSurfaceTempF ?? null,
      leftRpm: l?.pumpRpm ?? null,
      rightRpm: r?.pumpRpm ?? null,
      heatsink: h.heatsinkTempF ?? null,
      ambient: h.ambientTempF ?? null,
    }
  })
}

export function availabilityOf(points: HistoryPoint[]): ThermalAvailability {
  const has = (keys: NumKey[]) => points.some(p => keys.some(k => p[k] != null))
  return {
    bedTarget: has(['leftBed', 'rightBed', 'leftTarget', 'rightTarget']),
    water: has(['leftWater', 'rightWater']),
    surface: has(['leftSurface', 'rightSurface']),
    pump: has(['leftRpm', 'rightRpm']),
    hub: has(['heatsink', 'ambient']),
  }
}

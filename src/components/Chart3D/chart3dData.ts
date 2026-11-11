'use client'

import { useSyncExternalStore } from 'react'
import { usePreference } from '@/src/components/Base/controls'
import { hasWebGL } from '@/src/components/Base/loadThree'
import type { Chart3DData, Chart3DPoint, Chart3DState } from './chart3dScene'

export type ChartStyle = 'flat' | '3d'
export const CHART_STYLES: readonly ChartStyle[] = ['flat', '3d']

// Set once WebGL or three.js has failed (or WebGL is missing): every chart drops back to flat for the session.
let unavailable: boolean | undefined
const listeners = new Set<() => void>()
export function markChart3DUnavailable() {
  if (unavailable) return
  unavailable = true
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Flat recharts/SVG charts, or the three.js versions (per device); flat when WebGL can't run. */
export function useChartStyle() {
  const [style, setStyle] = usePreference<ChartStyle>('charts.style', '3d', CHART_STYLES)
  const failed = useSyncExternalStore(subscribe, () => (unavailable ??= !hasWebGL()), () => false)
  return [failed ? 'flat' : style, setStyle] as const
}

/** Query flags → chart state; `empty` when the request worked but there is nothing to draw. */
export function chartState(q: { isLoading: boolean, isError: boolean }, empty: boolean): Chart3DState {
  if (q.isLoading) return 'loading'
  if (q.isError) return 'error'
  return empty ? 'empty' : 'ready'
}

const MINUTE = 60_000
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map(m => m * MINUTE)

/** Evenly stepped clock ticks (at most `max`) between t0 and t1, as 0..1 positions. */
export function timeTicks(t0: number, t1: number, format: (t: number) => string, max = 6): Array<{ x: number, label: string }> {
  const span = t1 - t0
  if (!(span > 0)) return []
  const step = TICK_STEPS.find(s => span / s <= max) ?? TICK_STEPS[TICK_STEPS.length - 1]
  // Align to local wall-clock steps, not UTC.
  const offset = new Date(t0).getTimezoneOffset() * MINUTE
  const ticks: Array<{ x: number, label: string }> = []
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) ticks.push({ x: (t - t0) / span, label: format(t) })
  return ticks
}

export interface TimeSeriesInput {
  values: Array<number | null>
  color: string
  /** Current-value label at the right end. */
  value?: string
}

/**
 * Time-aligned series on one shared y range → normalised chart data. Times must be
 * ascending; `lo`/`hi` map to the floor and the top of the chart.
 */
export function timeSeries3D(times: number[], series: TimeSeriesInput[], lo: number, hi: number, formatTick: (t: number) => string): Chart3DData {
  const t0 = times[0] ?? 0
  const t1 = times[times.length - 1] ?? t0
  const span = t1 - t0 || 1
  const range = hi - lo || 1
  return {
    series: series.map(s => ({
      color: s.color,
      value: s.value,
      points: times.map((t, i): Chart3DPoint => {
        const v = s.values[i]
        return { x: (t - t0) / span, y: v == null || !Number.isFinite(v) ? null : (v - lo) / range }
      }),
    })),
    xTicks: timeTicks(t0, t1, formatTick),
  }
}

/** The last non-null value. */
export const lastValue = (values: Array<number | null>) => {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i]
  return null
}

'use client'

import { useMemo } from 'react'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatSetpointF } from '@/src/lib/tempUtils'
import { Chart3D } from '@/src/components/Chart3D/Chart3D'
import type { Chart3DData, Chart3DPoint, Chart3DSpec } from '@/src/components/Chart3D/chart3dScene'
import { buildTimeline, chartDomain, formatHourLabel, gridTemps, minutesToTime, useNowMinute, type BedSample, type CurveSetPoint } from './CurveChart'
import { TONE_VAR, tempTone } from './scheduleFormat'

const DAY = 24 * 60
const BED_GAP_MINUTES = 15
const CURVE_SAMPLES = 160

const SPEC: Chart3DSpec = {
  series: [{ kind: 'ribbon' }, { kind: 'line', lane: 0 }],
  reserve: { yTicks: true, now: true },
  samples: 200,
  yaw: 0.22,
}

/** Monotone cubic (Fritsch–Carlson) through the points, as `curvePath` draws it: no overshoot, flat holds. */
export function monotone(pts: Array<{ x: number, y: number }>): (x: number) => number {
  const n = pts.length
  if (n === 0) return () => 0
  if (n === 1) return () => pts[0].y
  const secant = pts.slice(1).map((b, i) => (b.x === pts[i].x ? 0 : (b.y - pts[i].y) / (b.x - pts[i].x)))
  const tangent = pts.map((_, i) => {
    if (i === 0) return secant[0]
    if (i === n - 1) return secant[n - 2]
    return secant[i - 1] * secant[i] <= 0 ? 0 : (secant[i - 1] + secant[i]) / 2
  })
  for (let i = 0; i < n - 1; i++) {
    if (secant[i] === 0) {
      tangent[i] = 0
      tangent[i + 1] = 0
      continue
    }
    const a = tangent[i] / secant[i]
    const b = tangent[i + 1] / secant[i]
    const h = a * a + b * b
    if (h > 9) {
      tangent[i] = (3 / Math.sqrt(h)) * a * secant[i]
      tangent[i + 1] = (3 / Math.sqrt(h)) * b * secant[i]
    }
  }
  return (x) => {
    let i = 0
    while (i < n - 2 && x > pts[i + 1].x) i++
    const a = pts[i]
    const b = pts[i + 1]
    const dx = b.x - a.x
    if (dx === 0) return b.y
    const t = Math.min(1, Math.max(0, (x - a.x) / dx))
    const t2 = t * t
    const t3 = t2 * t
    return (2 * t3 - 3 * t2 + 1) * a.y + (t3 - 2 * t2 + t) * dx * tangent[i] + (-2 * t3 + 3 * t2) * b.y + (t3 - t2) * dx * tangent[i + 1]
  }
}

/**
 * The schedule curve in three.js: the target as a ribbon tinted cool / neutral / warm
 * per set point, the measured bed temperature as a line over it, and a translucent
 * NOW plane. Read-only; the editor keeps the flat chart for dragging.
 */
export function CurveChart3D({ setPoints, bed, showNow = false }: { setPoints: CurveSetPoint[], bed?: BedSample[], showNow?: boolean }) {
  const { formatTime, timeFormat } = useTimeFormatter()
  const { unit } = useTemperatureUnit()
  const nowMinute = useNowMinute()

  const data = useMemo((): Chart3DData | null => {
    const timeline = buildTimeline(setPoints)
    if (timeline.length === 0) return null
    const win = chartDomain(timeline)
    const samples = (bed ?? []).filter(s => s.minutes >= win.start && s.minutes <= win.end)
    const { start, end, step, lo, hi } = chartDomain(timeline, 1, samples.map(s => s.temperature))
    const X = (m: number) => (m - start) / (end - start)
    const Y = (v: number) => (v - lo) / (hi - lo)

    const curve = monotone(timeline.map(p => ({ x: p.minutes, y: p.temperature })))
    const first = timeline[0].minutes
    const last = timeline[timeline.length - 1].minutes
    const planned: Chart3DPoint[] = Array.from({ length: CURVE_SAMPLES }, (_, i) => {
      const m = first + ((last - first) * i) / (CURVE_SAMPLES - 1)
      return { x: X(m), y: Y(curve(m)) }
    })

    const measured: Chart3DPoint[] = []
    samples.forEach((s, i) => {
      if (i > 0 && s.minutes - samples[i - 1].minutes > BED_GAP_MINUTES) measured.push({ x: X(s.minutes - 1), y: null })
      measured.push({ x: X(s.minutes), y: Y(s.temperature) })
    })

    const ticks: number[] = []
    const every = Math.max(1, Math.ceil((end - start) / step / 6))
    for (let t = start; t <= end; t += step * every) ticks.push(t)

    let now: Chart3DData['now'] = null
    if (showNow && nowMinute !== null) {
      const d = new Date(nowMinute * 60_000)
      const clock = d.getHours() * 60 + d.getMinutes()
      const m = [clock, clock + DAY, clock - DAY].find(c => c >= start && c <= end)
      if (m !== undefined) now = { x: X(m), label: `NOW ${formatTime(minutesToTime(clock)).replace(/ [AP]M$/, '')}` }
    }

    return {
      series: [
        { points: planned, color: TONE_VAR.neutral, stops: timeline.map(p => ({ x: X(p.minutes), color: TONE_VAR[tempTone(p.temperature)] })) },
        { points: measured, color: 'var(--text-2)' },
      ],
      xTicks: ticks.map(t => ({ x: X(t), label: formatHourLabel(t, timeFormat) })),
      yTicks: gridTemps(lo, hi).map(v => ({ y: Y(v), label: formatSetpointF(v, unit, { includeUnit: false }) })),
      now,
    }
  }, [setPoints, bed, showNow, nowMinute, formatTime, timeFormat, unit])

  return (
    <Chart3D
      spec={SPEC}
      state={data ? 'ready' : 'empty'}
      data={data}
      aspect={2.8}
      label="Temperature curve"
      message="No set points"
    />
  )
}

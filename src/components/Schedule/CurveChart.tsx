'use client'

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatTime12h } from '@/src/lib/scheduleTime'
import { formatSetpointF } from '@/src/lib/tempUtils'
import { NEUTRAL_TEMP_F, TONE_VAR, tempTone } from './scheduleFormat'

export interface CurveSetPoint {
  time: string
  temperature: number
}

export interface TimelinePoint<T extends CurveSetPoint> {
  item: T
  /** Minutes after the timeline's midnight; overnight points after midnight are shifted by +24h. */
  minutes: number
  temperature: number
}

export interface ChartDomain {
  start: number
  end: number
  step: number
  lo: number
  hi: number
}

/** A measured bed temperature on the chart's minute axis. */
export interface BedSample {
  minutes: number
  temperature: number
}

const DAY = 24 * 60
const HALF_DAY = 12 * 60
const TEMP_MIN_F = 55
const TEMP_MAX_F = 110
/** Bed samples further apart than this break the measured line (missing data shows as a gap). */
const BED_GAP_MINUTES = 15

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

export function minutesToTime(minutes: number): string {
  const m = ((Math.round(minutes) % DAY) + DAY) % DAY
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * Place set points on a continuous timeline, sorted chronologically. Schedules
 * that cross midnight (a gap > 12h between clock-sorted points) shift their
 * early-morning points by +24h — same rule as `sortChronological`.
 */
export function buildTimeline<T extends CurveSetPoint>(points: T[]): TimelinePoint<T>[] {
  const withMinutes = points.map(item => ({ item, minutes: toMinutes(item.time), temperature: item.temperature }))
  const byClock = [...withMinutes].sort((a, b) => a.minutes - b.minutes)
  let overnight = false
  if (byClock.some(p => p.minutes < HALF_DAY) && byClock.some(p => p.minutes >= HALF_DAY)) {
    for (let i = 0; i < byClock.length - 1; i++) {
      if (byClock[i + 1].minutes - byClock[i].minutes > HALF_DAY) {
        overnight = true
        break
      }
    }
  }
  return withMinutes
    .map(p => (overnight && p.minutes < HALF_DAY ? { ...p, minutes: p.minutes + DAY } : p))
    .sort((a, b) => a.minutes - b.minutes)
}

/**
 * Drop set points that repeat the previous temperature — the pod already holds
 * that value, so they change nothing on the chart. The first and last points
 * (power on / off) always stay.
 */
export function dropHolds<P extends { temperature: number }>(timeline: P[]): P[] {
  return timeline.filter((p, i) => i === 0 || i === timeline.length - 1 || p.temperature !== timeline[i - 1].temperature)
}

/**
 * Time window (padded ≥30 min and aligned to the tick step) and temperature
 * range: the curve (and any `extraTemps`, e.g. measured bed temperatures)
 * plus `pad`°, snapped out to even degrees and at least 8° tall. The editor
 * passes a bigger pad so points can be dragged past the current extremes.
 */
export function chartDomain(timeline: Array<{ minutes: number, temperature: number }>, pad = 1, extraTemps: number[] = []): ChartDomain {
  const first = timeline[0]?.minutes ?? 22 * 60
  const last = timeline[timeline.length - 1]?.minutes ?? first
  const span = last - first + 60
  const step = span <= 12 * 60 ? 120 : span <= 18 * 60 ? 180 : 240
  const start = Math.floor((first - 30) / step) * step
  const end = Math.max(Math.ceil((last + 30) / step) * step, start + 2 * step)
  const temps = timeline.length > 0 ? [...timeline.map(p => p.temperature), ...extraTemps] : [80]
  let lo = Math.floor((Math.min(...temps) - pad) / 2) * 2
  let hi = Math.ceil((Math.max(...temps) + pad) / 2) * 2
  if (hi - lo < 8) {
    // Grow evenly around the curve, keeping both edges on even degrees.
    lo -= Math.floor((8 - (hi - lo)) / 4) * 2
    hi = lo + 8
  }
  return { start, end, step, lo, hi }
}

export function formatHourLabel(minutes: number): string {
  const h = Math.floor((((minutes % DAY) + DAY) % DAY) / 60)
  const period = h >= 12 ? 'PM' : 'AM'
  const display = h % 12 === 0 ? 12 : h % 12
  return `${display} ${period}`
}

/** Horizontal grid temperatures: even steps (2°/4°/10°) across the domain. */
export function gridTemps(lo: number, hi: number): number[] {
  const span = hi - lo
  const every = span <= 12 ? 2 : span <= 24 ? 4 : 10
  const out: number[] = []
  for (let t = Math.ceil(lo / every) * every; t <= hi; t += every) out.push(t)
  return out.reverse()
}

/**
 * Step path, which is what the scheduler sends: the pod holds each set point
 * until the next one fires, then jumps to the new value.
 */
export function stepPath(pts: Array<{ x: number, y: number }>): string {
  if (pts.length === 0) return ''
  let d = `M${pts[0].x},${pts[0].y}`
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    d += a.y === b.y ? ` L${b.x},${b.y}` : ` L${b.x},${a.y} L${b.x},${b.y}`
  }
  return d
}

/**
 * Polyline through measured samples, broken wherever neighbours are further
 * apart than `gap` minutes so missing data shows as a gap.
 */
export function measuredPath(samples: BedSample[], X: (m: number) => number, Y: (v: number) => number, gap = BED_GAP_MINUTES): string {
  let d = ''
  let prev: number | null = null
  for (const s of samples) {
    d += `${prev === null || s.minutes - prev > gap ? 'M' : 'L'}${X(s.minutes).toFixed(1)},${Y(s.temperature).toFixed(1)}`
    prev = s.minutes
  }
  return d
}

/** The set point the schedule holds at `minutes`; null outside the curve. */
export function heldTemperature(timeline: Array<{ minutes: number, temperature: number }>, minutes: number): number | null {
  if (timeline.length === 0 || minutes < timeline[0].minutes || minutes > timeline[timeline.length - 1].minutes) return null
  let held = timeline[0].temperature
  for (const p of timeline) if (p.minutes <= minutes) held = p.temperature
  return held
}

/** Target held and bed measured at `minutes`, for readouts drawn outside the chart. */
export function readAt(setPoints: CurveSetPoint[], bed: BedSample[], minutes: number): { target: number | null, bed: number | null } {
  return { target: heldTemperature(buildTimeline(setPoints), minutes), bed: nearestSample(bed, minutes)?.temperature ?? null }
}

/** The bed sample nearest `minutes`, if one lies within `gap` minutes. */
export function nearestSample(samples: BedSample[], minutes: number, gap = BED_GAP_MINUTES): BedSample | null {
  let best: BedSample | null = null
  for (const s of samples) if (!best || Math.abs(s.minutes - minutes) < Math.abs(best.minutes - minutes)) best = s
  return best && Math.abs(best.minutes - minutes) <= gap ? best : null
}

/** Smooth path through the points: horizontal tangents at each set point. */
function smoothPath(pts: Array<{ x: number, y: number }>): string {
  if (pts.length === 0) return ''
  let d = `M${pts[0].x},${pts[0].y}`
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const mx = (a.x + b.x) / 2
    d += ` C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`
  }
  return d
}

function subscribeMinute(cb: () => void) {
  const id = setInterval(cb, 30_000)
  return () => clearInterval(id)
}
const getMinute = () => Math.floor(Date.now() / 60_000)
const getServerMinute = () => null

/** Current epoch minute on the client, null during SSR (avoids hydration drift). */
export function useNowMinute(): number | null {
  return useSyncExternalStore(subscribeMinute, getMinute, getServerMinute)
}

interface CurveChartProps<T extends CurveSetPoint> {
  /** Set points in °F. Order doesn't matter — the chart sorts them. */
  setPoints: T[]
  height?: number
  /** Dashed NOW marker when the current time falls inside the window. */
  showNow?: boolean
  /** Editor only: draw the chronologically-last handle hollow (the Pod powers off there). */
  markOff?: boolean
  /** Larger drag handles for the editor. */
  large?: boolean
  /** Enables dragging (and arrow keys on) a point to change its time/temperature. */
  onChangePoint?: (item: T, next: CurveSetPoint) => void
  getKey?: (item: T, index: number) => string | number
  /** Fixed time window (e.g. shared by stacked lanes); the temperature range stays per-chart. */
  timeDomain?: Pick<ChartDomain, 'start' | 'end' | 'step'>
  /** 'neutral' draws only a dashed 80°F reference instead of the even-degree grid. */
  grid?: 'temps' | 'neutral'
  /** Hour labels under the chart. */
  showAxis?: boolean
  /** Measured bed temperature (°F) on the chart's minute axis, drawn as a thin grey line under the target steps. */
  bed?: BedSample[]
  /** "on" / "off" labels at the first and last set point (read-only charts). */
  endLabels?: boolean
  /** Controlled hover (stacked lanes share one): the minute under the pointer, reported through `onHoverMinutes`. */
  hoverMinutes?: number | null
  onHoverMinutes?: (minutes: number | null) => void
  /** Draw the hover line and readout; stacked lanes turn this off and draw their own across all lanes. */
  hoverMarks?: boolean
  className?: string
}

/**
 * Schedule curve drawn as sharp steps (what the scheduler sends), stroked
 * with a cool/neutral/warm colour per set point vs 80°F, over an even-degree
 * grid that always covers the peak, with an optional NOW line and the
 * measured bed temperature as a thin grey line. Read-only charts have no
 * dots: hovering reads out the target and bed at that time. The editor
 * (onChangePoint) shows every point as a drag handle. Fluid width, measured
 * so handles stay round.
 */
export function CurveChart<T extends CurveSetPoint>({
  setPoints,
  height = 220,
  showNow = false,
  markOff = true,
  large = false,
  onChangePoint,
  getKey = (_item, i) => i,
  timeDomain,
  grid = 'temps',
  showAxis = true,
  bed,
  endLabels = !onChangePoint,
  hoverMinutes,
  onHoverMinutes,
  hoverMarks = true,
  className,
}: CurveChartProps<T>) {
  const { unit } = useTemperatureUnit()
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(0)
  const gradientId = `curve-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const nowMinute = useNowMinute()

  // Dragging freezes the domain so the axis doesn't rescale under the pointer.
  const [drag, setDrag] = useState<{ key: string | number, domain: ChartDomain } | null>(null)
  // Read-only charts: the minute under the pointer.
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    if (typeof ResizeObserver === 'undefined') {
      setWidth(el.clientWidth || 636)
      return
    }
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0)
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const allPoints = buildTimeline(setPoints)
  const timeline = onChangePoint ? allPoints : dropHolds(allPoints)
  const win = { ...chartDomain(allPoints), ...timeDomain }
  const samples = (bed ?? []).filter(s => s.minutes >= win.start && s.minutes <= win.end)
  const domain = drag?.domain ?? { ...chartDomain(allPoints, onChangePoint ? 4 : 1, samples.map(s => s.temperature)), ...timeDomain }
  const { start, end, step, lo, hi } = domain
  const padY = large ? 18 : 14
  const X = (m: number) => ((m - start) / (end - start)) * width
  const Y = (v: number) => height - padY - ((v - lo) / (hi - lo)) * (height - padY * 2)
  const invX = (x: number) => start + (x / width) * (end - start)
  const invY = (y: number) => lo + ((height - padY - y) / (height - padY * 2)) * (hi - lo)

  const coords = timeline.map(p => ({ x: X(p.minutes), y: Y(p.temperature) }))
  const path = stepPath(coords)
  const bedPath = measuredPath(samples, X, Y)
  const x0 = coords[0]?.x ?? 0
  const x1 = coords[coords.length - 1]?.x ?? width
  // Hard colour stops: each hold keeps its own tone right up to the step.
  const stops = timeline.flatMap((p, i) => {
    const offset = ((coords[i].x - x0) / (x1 - x0 || 1)).toFixed(3)
    const color = TONE_VAR[tempTone(p.temperature)]
    return i === 0 ? [{ offset, color }] : [{ offset, color: TONE_VAR[tempTone(timeline[i - 1].temperature)] }, { offset, color }]
  })

  const hoverAt = hoverMinutes !== undefined ? hoverMinutes : hover
  const setHoverAt = (m: number | null) => (onHoverMinutes ? onHoverMinutes(m) : setHover(m))
  let readout: { x: number, label: string } | null = null
  if (hoverMarks && hoverAt !== null && !onChangePoint && hoverAt >= start && hoverAt <= end) {
    const target = heldTemperature(allPoints, hoverAt)
    const sample = nearestSample(samples, hoverAt)
    const fmt = (v: number | null, decimals = 0) => (v === null ? '—' : formatSetpointF(v, unit, { includeUnit: false, decimals }))
    readout = {
      x: X(hoverAt),
      label: `${formatTime12h(minutesToTime(hoverAt))} · ${fmt(target)}${samples.length > 0 ? ` / ${fmt(sample?.temperature ?? null, 1)}` : ''}`,
    }
  }

  let nowX: number | null = null
  let nowLabel = ''
  if (showNow && nowMinute !== null) {
    const d = new Date(nowMinute * 60_000)
    const clock = d.getHours() * 60 + d.getMinutes()
    const m = [clock, clock + DAY, clock - DAY].find(c => c >= start && c <= end)
    if (m !== undefined) {
      nowX = X(m)
      nowLabel = `NOW ${formatTime12h(minutesToTime(clock)).replace(/ [AP]M$/, '')}`
    }
  }

  const keyOf = (p: TimelinePoint<T>) => getKey(p.item, setPoints.indexOf(p.item))

  // Thin the hour labels on narrow charts so they never collide (~56px each).
  const slots = (end - start) / step
  const every = width > 0 ? Math.max(1, Math.ceil((56 * slots) / width)) : 1
  const ticks: number[] = []
  for (let t = start; t <= end; t += step * every) ticks.push(t)

  const emit = useCallback((item: T, minutes: number, temperature: number) => {
    const snapped = Math.round(minutes / 15) * 15
    onChangePoint?.(item, {
      time: minutesToTime(snapped),
      temperature: Math.max(TEMP_MIN_F, Math.min(TEMP_MAX_F, Math.round(temperature))),
    })
  }, [onChangePoint])

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(width, e.clientX - rect.left))
    if (!onChangePoint) {
      setHoverAt(Math.round(invX(x)))
      return
    }
    if (!drag) return
    const target = timeline.find(p => keyOf(p) === drag.key)
    if (!target) return
    const y = Math.max(0, Math.min(height, e.clientY - rect.top))
    emit(target.item, invX(x), invY(y))
  }

  const onKeyDown = (e: KeyboardEvent<SVGCircleElement>, p: TimelinePoint<T>) => {
    const moves: Record<string, [number, number]> = {
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
      ArrowRight: [15, 0],
      ArrowLeft: [-15, 0],
    }
    const move = moves[e.key]
    if (!move) return
    e.preventDefault()
    emit(p.item, p.minutes + move[0], p.temperature + move[1])
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div ref={wrapRef} className="w-full" style={{ height }} data-no-swipe={onChangePoint ? true : undefined}>
        {width > 0 && timeline.length > 0 && (
          <svg
            ref={svgRef}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="block overflow-visible"
            role="img"
            aria-label="Temperature curve"
            onPointerMove={drag || !onChangePoint ? onPointerMove : undefined}
            onPointerLeave={onChangePoint ? undefined : () => setHoverAt(null)}
            onPointerUp={() => setDrag(null)}
            onPointerCancel={() => setDrag(null)}
          >
            <defs>
              <linearGradient id={gradientId} x1={x0} y1="0" x2={x1 === x0 ? x0 + 1 : x1} y2="0" gradientUnits="userSpaceOnUse">
                {stops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.color} />)}
              </linearGradient>
            </defs>
            {(grid === 'neutral' ? [NEUTRAL_TEMP_F].filter(v => v >= lo && v <= hi) : gridTemps(lo, hi)).map(v => (
              <g key={v}>
                <line x1="0" x2={width} y1={Y(v)} y2={Y(v)} stroke="var(--border-grid)" strokeDasharray={grid === 'neutral' ? '2 4' : undefined} />
                <text x="0" y={Y(v) - 4} fill="var(--text-3)" className="font-mono" fontSize="10">
                  {formatSetpointF(v, unit, { includeUnit: false })}
                </text>
              </g>
            ))}
            <path d={`${path} L${x1},${height} L${x0},${height} Z`} fill="var(--text-1)" fillOpacity="0.04" />
            {bedPath && (
              <path data-testid="curve-bed" d={bedPath} fill="none" stroke="var(--text-3)" strokeWidth="1.25" strokeLinejoin="round" />
            )}
            <path d={path} fill="none" stroke={`url(#${gradientId})`} strokeWidth="2.5" strokeLinejoin="round" />
            {/* Same marks as the System → Scheduler lanes: green "on", grey "off" with its line. */}
            {endLabels && coords.length > 1 && (
              <g className="font-mono" fontSize="10" data-testid="curve-ends">
                <text x={x0 - 4} y={height - padY + 4} textAnchor="end" fill="var(--status-ok)">on</text>
                <line x1={x1} x2={x1} y1={padY} y2={height - padY} stroke="var(--text-3)" />
                <text x={x1 + 4} y={height - padY + 4} fill="var(--text-3)">off</text>
              </g>
            )}
            {nowX !== null && (
              <g data-testid="curve-now">
                <line x1={nowX} x2={nowX} y1="18" y2={height} stroke="var(--text-1)" strokeOpacity="0.5" strokeDasharray="3 4" />
                <text x={nowX + 6} y="28" fill="var(--text-1)" className="font-mono" fontSize="10">{nowLabel}</text>
              </g>
            )}
            {readout && (
              <g data-testid="curve-hover" pointerEvents="none">
                <line x1={readout.x} x2={readout.x} y1="0" y2={height} stroke="var(--text-1)" strokeOpacity="0.35" />
                <text
                  x={readout.x > width / 2 ? readout.x - 6 : readout.x + 6}
                  y="12"
                  textAnchor={readout.x > width / 2 ? 'end' : 'start'}
                  fill="var(--text-1)"
                  className="font-mono"
                  fontSize="10"
                >
                  {readout.label}
                </text>
              </g>
            )}
            {onChangePoint && timeline.map((p, i) => {
              const key = keyOf(p)
              const off = markOff && timeline.length > 1 && i === timeline.length - 1
              return (
                <circle
                  key={String(key)}
                  cx={coords[i].x}
                  cy={coords[i].y}
                  r={large ? (off ? 6 : 7) : 5}
                  fill={off ? 'var(--surface-card)' : TONE_VAR[tempTone(p.temperature)]}
                  stroke={off ? 'var(--text-2)' : 'var(--surface-card)'}
                  strokeWidth={off || !large ? 2 : 3}
                  tabIndex={0}
                  role="slider"
                  aria-label={`Set point ${formatTime12h(p.item.time)}`}
                  aria-valuenow={p.temperature}
                  aria-valuemin={TEMP_MIN_F}
                  aria-valuemax={TEMP_MAX_F}
                  aria-valuetext={`${formatTime12h(p.item.time)}, ${formatSetpointF(p.temperature, unit)}`}
                  style={{ cursor: drag ? 'grabbing' : 'grab', touchAction: 'none', outline: 'none' }}
                  onPointerDown={(e: PointerEvent<SVGCircleElement>) => {
                    e.preventDefault()
                    svgRef.current?.setPointerCapture?.(e.pointerId)
                    setDrag({ key, domain })
                  }}
                  onKeyDown={(e: KeyboardEvent<SVGCircleElement>) => onKeyDown(e, p)}
                />
              )
            })}
          </svg>
        )}
      </div>
      {showAxis && (
        <div className="relative h-4 font-mono text-[11px] text-fg-3" aria-hidden>
          {width > 0 && ticks.map((t, i) => (
            <span
              key={t}
              className="absolute top-0 whitespace-nowrap"
              style={{
                left: X(t),
                transform: i === 0 ? undefined : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {formatHourLabel(t)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** "— Target  — Bed · last night" key for charts that overlay the measured bed temperature. */
export function CurveLegend({ bedLabel = 'Bed', className }: { bedLabel?: string, className?: string }) {
  return (
    <span className={cn('flex items-center gap-x-3 font-mono text-[11px] text-fg-2', className)} data-testid="curve-legend">
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-3 rounded bg-warm" />
        Target
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-px w-3 bg-fg-3" />
        {bedLabel}
      </span>
    </span>
  )
}

/**
 * Compact sparkline for the curve list cards. Stretches to the card width.
 */
export function MiniCurve({ setPoints, height = 32, className }: { setPoints: CurveSetPoint[], height?: number, className?: string }) {
  const id = `mini-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const timeline = buildTimeline(setPoints)
  if (timeline.length === 0) return null
  const W = 200
  const first = timeline[0].minutes
  const last = timeline[timeline.length - 1].minutes
  const temps = timeline.map(p => p.temperature)
  const lo = Math.min(...temps) - 1
  const hi = Math.max(...temps) + 1
  const pts = timeline.map(p => ({
    x: last === first ? W / 2 : ((p.minutes - first) / (last - first)) * W,
    y: 2 + (1 - (p.temperature - lo) / (hi - lo)) * (height - 4),
  }))
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className={cn('block', className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2={W} y2="0" gradientUnits="userSpaceOnUse">
          {timeline.map((p, i) => (
            <stop key={i} offset={(pts[i].x / W).toFixed(3)} stopColor={TONE_VAR[tempTone(p.temperature)]} />
          ))}
        </linearGradient>
      </defs>
      <path d={smoothPath(pts)} fill="none" stroke={`url(#${id})`} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

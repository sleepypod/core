'use client'

import { useState, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* Lightweight SVG charts from the design system. Use recharts where
   interaction (tooltips, zoom) matters; these are for compact cards. */

/**
 * Where the pointer is across a chart box, as a 0..1 fraction of its width
 * (minus any padding), or null when outside. Every chart's hover readout is
 * built on this so they all behave alike.
 */
export function useHoverFraction(padLeft = 0, padRight = 0) {
  const [frac, setFrac] = useState<number | null>(null)
  const onPointerMove = (e: PointerEvent<Element>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const w = rect.width - padLeft - padRight
    if (w <= 0) return
    const x = e.clientX - rect.left - padLeft
    setFrac(x < 0 || x > w ? null : x / w)
  }
  const onPointerLeave = () => setFrac(null)
  return { frac, onPointerMove, onPointerLeave }
}

/** Vertical hover line with a readout, laid over a `relative` chart box at `pct` percent across. */
export function HoverMark({ pct, label, className, labelClassName }: { pct: number, label: ReactNode, className?: string, labelClassName?: string }) {
  const flip = pct > 55
  return (
    <div
      aria-hidden
      data-testid="chart-hover"
      className={cn('pointer-events-none absolute inset-y-0 border-l border-fg/35', className)}
      style={{ left: `${pct}%` }}
    >
      <span
        className={cn('absolute top-0 rounded-tag px-1 font-mono text-[10px] leading-4 whitespace-nowrap text-fg', flip ? 'right-1' : 'left-1', labelClassName)}
        style={{ background: 'color-mix(in srgb, var(--surface-card) 85%, transparent)' }}
      >
        {label}
      </span>
    </div>
  )
}

export interface LineSeries {
  data: number[]
  /** CSS color, e.g. 'var(--accent-cool)'. */
  color: string
  dash?: boolean
  fill?: boolean
  width?: number
  /** Mark every point, so a value between two gaps still shows. */
  dots?: boolean
}

/** A horizontal rule at `value`; `strong` for a reference such as zero. */
export interface ChartGuide {
  value: number
  label?: string
  strong?: boolean
}

/** A vertical hairline at a fractional point index, e.g. 2.5 between points 2 and 3. */
export interface ChartMarker {
  at: number
  label: string
}

/**
 * Fluid-width sparkline/line chart. Non-finite points are skipped. Passing
 * `xLabel` turns on the hover readout: the label for the point under the
 * pointer and each series' value there (through `format`, default 1 decimal).
 */
export function LineChart({ series, min, max, height = 80, className, xLabel, format = v => v.toFixed(1), guides = [], markers = [] }: {
  series: LineSeries[]
  min?: number
  max?: number
  height?: number
  className?: string
  xLabel?: (index: number) => string
  format?: (value: number, series: number) => string
  guides?: ChartGuide[]
  markers?: ChartMarker[]
}) {
  const width = 300
  const hover = useHoverFraction()
  const all = series.flatMap(s => s.data).filter(Number.isFinite)
  if (all.length === 0) return <div className={className} style={{ height }} />
  const n = Math.max(...series.map(s => s.data.length))
  const idx = xLabel && hover.frac !== null && n > 0 ? Math.round(hover.frac * (n - 1)) : null
  const lo = min ?? Math.min(...all)
  const hi = max ?? Math.max(...all)
  const yOf = (v: number) => 4 + (1 - (v - lo) / (hi - lo || 1)) * (height - 8)
  const xPct = (i: number) => (i / Math.max(1, n - 1)) * 100
  const points = (d: number[]) => d.flatMap((v, i) => Number.isFinite(v)
    ? [{ i, x: ((i / Math.max(1, d.length - 1)) * width).toFixed(1), y: yOf(v).toFixed(1) }]
    : [])
  const path = (d: number[]) => {
    let out = ''
    let last = -2
    for (const p of points(d)) {
      out += `${p.i === last + 1 ? 'L' : 'M'}${p.x},${p.y} `
      last = p.i
    }
    return out.trim()
  }
  const labelled = guides.filter(g => g.label)
  const bare = !xLabel && markers.length === 0 && labelled.length === 0
  const svg = (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn('block', bare && className)}>
      {guides.map(g => (
        <line
          key={`guide-${g.value}`}
          x1={0}
          x2={width}
          y1={yOf(g.value)}
          y2={yOf(g.value)}
          stroke={g.strong ? 'var(--text-3)' : 'var(--border-1)'}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {markers.map(m => (
        <line
          key={`marker-${m.label}`}
          x1={(xPct(m.at) / 100) * width}
          x2={(xPct(m.at) / 100) * width}
          y1={0}
          y2={height}
          stroke="var(--text-2)"
          strokeWidth={1}
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {series.map((s, i) => {
        const d = path(s.data)
        if (!d) return null
        return (
          <g key={i}>
            {s.fill && <path d={`${d} L${width},${height} L0,${height} Z`} fill={s.color} fillOpacity={0.1} />}
            <path
              d={d}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width ?? 1.75}
              strokeDasharray={s.dash ? '4 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
            {/* Zero-length round-capped segments: dots that stay round under preserveAspectRatio="none". */}
            {s.dots && (
              <path
                data-testid="chart-dots"
                d={points(s.data).map(p => `M${p.x},${p.y} h0`).join(' ')}
                fill="none"
                stroke={s.color}
                strokeWidth={(s.width ?? 1.75) + 3}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        )
      })}
    </svg>
  )
  if (bare) return svg
  const values = idx === null ? [] : series.map((s, i) => (Number.isFinite(s.data[idx]) ? format(s.data[idx], i) : null)).filter((v): v is string => v !== null)
  return (
    <div className={cn('relative', className)} onPointerMove={xLabel ? hover.onPointerMove : undefined} onPointerLeave={xLabel ? hover.onPointerLeave : undefined}>
      {svg}
      {labelled.map(g => (
        <span key={`guide-${g.value}`} aria-hidden className="pointer-events-none absolute right-full -translate-y-1/2 pr-1.5 font-mono text-[10px] leading-3 text-fg-3" style={{ top: yOf(g.value) }}>
          {g.label}
        </span>
      ))}
      {markers.map(m => (
        <span
          key={`marker-${m.label}`}
          aria-hidden
          data-testid="chart-marker"
          className={cn('pointer-events-none absolute bottom-0 font-mono text-[10px] leading-3 whitespace-nowrap text-fg-2', xPct(m.at) > 55 ? 'pr-1' : 'pl-1')}
          style={xPct(m.at) > 55 ? { right: `${100 - xPct(m.at)}%` } : { left: `${xPct(m.at)}%` }}
        >
          {m.label}
        </span>
      ))}
      {idx !== null && xLabel && (
        <HoverMark pct={xPct(idx)} label={`${xLabel(idx)}${values.length ? ` · ${values.join(' / ')}` : ''}`} />
      )}
    </div>
  )
}

export const STAGE_COLORS = {
  awake: 'var(--stage-awake)',
  rem: 'var(--stage-rem)',
  light: 'var(--stage-light)',
  deep: 'var(--stage-deep)',
} as const
export type StageKey = keyof typeof STAGE_COLORS
const LANE_ORDER: StageKey[] = ['awake', 'rem', 'light', 'deep']

export interface HypnoBlock {
  stage: StageKey
  /** 0..100 */
  startPct: number
  /** 0..100 */
  widthPct: number
}

/** Four-lane hypnogram (AWAKE / REM / LIGHT / DEEP). */
export function Hypnogram({ blocks, lane = 26, bar = 16, labels = true, ticks, reference = [] }: {
  blocks: HypnoBlock[]
  reference?: HypnoBlock[]
  lane?: number
  bar?: number
  labels?: boolean
  ticks?: string[]
}) {
  return (
    <div className="grid gap-x-2.5" style={{ gridTemplateColumns: labels ? '48px minmax(0,1fr)' : 'minmax(0,1fr)' }}>
      {labels && (
        <div className="flex flex-col font-mono text-[10px] tracking-[0.04em] text-fg-3">
          {LANE_ORDER.map(l => (
            <span key={l} className="flex items-center uppercase" style={{ height: lane }}>{l}</span>
          ))}
        </div>
      )}
      <div className={cn('relative', labels && 'border-l border-line')} style={{ height: lane * 4 }}>
        {[1, 2, 3].map(i => (
          <div key={i} className="absolute inset-x-0 border-t border-grid" style={{ top: lane * i }} />
        ))}
        {blocks.map((b, i) => (
          <span
            key={i}
            className="absolute rounded-[3px]"
            style={{
              top: LANE_ORDER.indexOf(b.stage) * lane + (lane - bar) / 2,
              height: bar,
              left: `${b.startPct}%`,
              width: `max(${b.widthPct}%, 1px)`,
              background: STAGE_COLORS[b.stage],
            }}
          />
        ))}
        {reference.length > 0 && (
          <svg className="absolute inset-0 h-full w-full overflow-visible text-fg" viewBox={`0 0 100 ${lane * 4}`} preserveAspectRatio="none" role="img" aria-label="Apple Watch sleep stages">
            {reference.map((b, i) => {
              const y = (LANE_ORDER.indexOf(b.stage) + 0.5) * lane
              const previous = reference[i - 1]
              const connected = previous && Math.abs(previous.startPct + previous.widthPct - b.startPct) < 0.001
              const fromY = connected ? (LANE_ORDER.indexOf(previous.stage) + 0.5) * lane : y
              return <path key={i} d={`M ${b.startPct} ${fromY} V ${y} H ${b.startPct + b.widthPct}`} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            })}
          </svg>
        )}
      </div>
      {ticks && labels && <div />}
      {ticks && (
        <div className="flex justify-between pt-1.5 font-mono text-[11px] text-fg-3">
          {ticks.map((t, i) => <span key={`${t}-${i}`}>{t}</span>)}
        </div>
      )}
    </div>
  )
}

/** Horizontal stacked stage proportion bar. Values are percentages. */
export function StageBar({ awake = 0, rem = 0, light = 0, deep = 0, height = 10 }: Partial<Record<StageKey, number>> & { height?: number }) {
  const segs: [number, string][] = [
    [awake, STAGE_COLORS.awake],
    [rem, STAGE_COLORS.rem],
    [light, STAGE_COLORS.light],
    [deep, STAGE_COLORS.deep],
  ]
  return (
    <div className="flex gap-0.5 overflow-hidden" style={{ height, borderRadius: height / 2 }}>
      {segs.filter(([w]) => w > 0).map(([w, c], i) => <span key={i} style={{ width: `${w}%`, background: c }} />)}
    </div>
  )
}

const LEGEND: [StageKey, string][] = [['awake', 'Awake'], ['rem', 'REM'], ['light', 'Light'], ['deep', 'Deep']]

export function StageLegend({ durations }: { durations?: Partial<Record<StageKey, string>> }) {
  if (durations) {
    return (
      <div className="grid grid-cols-4 gap-2">
        {LEGEND.map(([k, l]) => (
          <div key={k} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-xs text-fg-2">
              <span className="size-2 rounded-[2px]" style={{ background: STAGE_COLORS[k] }} />
              {l}
            </span>
            <span className="font-mono text-[15px]">{durations[k] ?? '—'}</span>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-wrap gap-3.5 text-xs text-fg-2">
      {LEGEND.map(([k, l]) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="size-2 rounded-[2px]" style={{ background: STAGE_COLORS[k] }} />
          {l}
        </span>
      ))}
    </div>
  )
}

export interface WeekNight {
  label: string
  hours: number
  quality?: number | null
  /** Stage split in percent; defaults to 21/54/25 REM/Light/Deep. */
  split?: { rem: number, light: number, deep: number }
}

/** Stacked per-night bars. Tapping selects a night. */
export function WeekBars({ nights, selected, height = 140, detailed, onSelect, maxHours = 9 }: {
  nights: WeekNight[]
  selected?: number
  height?: number
  detailed?: boolean
  onSelect?: (i: number) => void
  maxHours?: number
}) {
  const sel = selected ?? nights.length - 1
  const fmt = (h: number) => `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`
  return (
    <div className="grid items-end gap-2.5" style={{ gridTemplateColumns: `repeat(${nights.length}, minmax(0,1fr))` }}>
      {nights.map((n, i) => {
        const s = i === sel
        const split = n.split ?? { rem: 21, light: 54, deep: 25 }
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSelect?.(i)}
            disabled={!onSelect}
            className="flex cursor-pointer flex-col items-center gap-1.5 border-0 bg-transparent p-0 text-inherit disabled:cursor-default"
          >
            <span className={cn('whitespace-nowrap font-mono', detailed ? 'text-xs' : 'text-[10px]', s ? 'text-fg' : 'text-fg-2')}>
              {n.hours > 0 ? (detailed ? fmt(n.hours) : n.hours.toFixed(1)) : '—'}
            </span>
            <div
              className="flex w-full max-w-14 flex-col gap-0.5"
              style={{ height: Math.max(2, Math.round((Math.min(n.hours, maxHours) / maxHours) * height)), opacity: s ? 1 : 0.55 }}
            >
              {n.hours > 0 && (
                <>
                  <span className="rounded-t-[3px]" style={{ flex: split.rem, background: STAGE_COLORS.rem }} />
                  <span style={{ flex: split.light, background: STAGE_COLORS.light }} />
                  <span className="rounded-b-[3px]" style={{ flex: split.deep, background: STAGE_COLORS.deep }} />
                </>
              )}
            </div>
            <span className={cn('font-mono text-[11px]', s ? 'border-b border-fg text-fg' : 'text-fg-2')}>{n.label}</span>
            {detailed && n.quality != null && (
              <span className="font-mono text-[11px] text-fg-2">
                {`Q ${n.quality}`}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** Circular score ring. */
export function QualityRing({ score, size = 96, label = 'quality', full, color = 'var(--status-ok)', text }: {
  score?: number | null
  size?: number
  label?: string | null
  full?: boolean
  color?: string
  text?: string
}) {
  const c = 2 * Math.PI * 42
  const frac = full ? 1 : Math.max(0, Math.min(1, (score ?? 0) / 100))
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 96 96">
        <circle cx="48" cy="48" r="42" fill="none" stroke="var(--dial-track)" strokeWidth="5" />
        <circle
          cx="48"
          cy="48"
          r="42"
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${(c * frac).toFixed(1)} ${c.toFixed(1)}`}
          transform="rotate(-90 48 48)"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono font-light leading-none" style={{ fontSize: size * 0.29 }}>{text ?? (score ?? '—')}</span>
        {label && size >= 80 && <span className="text-[11px] text-fg-2">{label}</span>}
      </div>
    </div>
  )
}

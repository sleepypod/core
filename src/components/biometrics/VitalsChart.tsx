/**
 * Vitals chart — heart rate, HRV and breathing as three stacked rows on one
 * shared x axis (different units and normal ranges, so never a dual axis).
 * Only in-bed sessions are drawn, each as wide as its share of the time; the
 * empty stretches between them collapse to a dashed break labelled with the
 * gap. When the side is in bed but vitals stopped, a hatched amber segment
 * shows the stall. Each row draws gridlines → the range's p25–p75 band → the
 * raw per-minute line → a 9-minute centred mean. Hover (or tap and drag)
 * shows one crosshair through all rows, snapped to the nearest reading.
 * Imported Apple Watch heart rate (`reference`) is drawn as a dashed line over
 * the heart-rate row so the two sensors can be compared night by night.
 */
'use client'

import { useTimeFormat } from '@/src/providers/TimeFormatProvider'

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react'
import {
  axisTicks, timeAtX, clampTo, clock, fmtDuration, fmtGap, layoutAxis, METRICS, nearestIndex, rollingMean, sessionHeader,
  type MetricKey, type RangeWindow, type Session,
} from './biometricsLogic'

const LABEL_W = 130
const GUTTER = 34
const ROW_H = 78
const ROW_GAP = 18
const HEAD_H = 24
const AXIS_H = 26
const VITALS_H = METRICS.length * ROW_H + (METRICS.length - 1) * ROW_GAP

type Band = { lo: number, hi: number } | null

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

function pathOf(xs: number[], ys: Array<number | null>): string {
  let d = ''
  let pen = false
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i]
    if (y == null) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${xs[i].toFixed(1)} ${y.toFixed(1)}`
    pen = true
  }
  return d
}

const rowTop = (i: number) => HEAD_H + i * (ROW_H + ROW_GAP)
const yOf = (i: number, v: number) => {
  const [lo, hi] = METRICS[i].domain
  return rowTop(i) + ROW_H - ((clampTo(v, METRICS[i].domain) - lo) / (hi - lo)) * ROW_H
}

export interface ReferencePoint { t: number, hr: number }

/** Reference samples inside a session, in time order. */
export function referenceInSession(reference: ReferencePoint[], s: { start: number, end: number }): ReferencePoint[] {
  return reference.filter(p => p.t >= s.start && p.t <= s.end)
}

/** The reference sample nearest `t`, or null when none is within `tolMs`. */
export function nearestReference<T extends { t: number }>(points: T[], t: number, tolMs = REFERENCE_TOL_MS): T | null {
  let best: T | null = null
  for (const p of points) {
    if (best == null || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p
  }
  return best && Math.abs(best.t - t) <= tolMs ? best : null
}

/** Consecutive reference samples further apart than this are not joined. */
export const REFERENCE_GAP_MS = 15 * 60_000

/** Time-sorted samples split into runs with no gap over `gapMs`. */
export function referenceRuns<T extends { t: number }>(points: T[], gapMs = REFERENCE_GAP_MS): T[][] {
  const runs: T[][] = []
  for (const p of points) {
    const run = runs[runs.length - 1]
    if (run && p.t - run[run.length - 1].t <= gapMs) run.push(p)
    else runs.push([p])
  }
  return runs
}

const REFERENCE_TOL_MS = 5 * 60_000
const REFERENCE_STROKE = 'var(--text-1)'

export function VitalsChart({ sessions, stall, bands, reference = [], referenceHrv = [], referenceBr = [], movement = [], onSelectWindow }: {
  sessions: Session[]
  /** In bed with no vitals: from the last reading to now. */
  stall: { start: number, end: number } | null
  bands: Record<MetricKey, Band>
  /** Imported Apple Watch heart rate, time-sorted. */
  reference?: ReferencePoint[]
  referenceHrv?: Array<{ t: number, value: number }>
  referenceBr?: Array<{ t: number, value: number }>
  movement?: Array<{ bucketStart: Date, eventCount: number }>
  onSelectWindow?: (window: RangeWindow) => void
}) {
  const PLOT_H = VITALS_H + 76
  const timeFormat = useTimeFormat()
  const [wrapRef, wrapW] = useWidth<HTMLDivElement>()
  const hatchId = useId()
  const plotW = Math.max(0, wrapW - LABEL_W - GUTTER)
  const axis = useMemo(() => layoutAxis(sessions, plotW, stall), [sessions, plotW, stall])
  const smooth = useMemo(() => sessions.map(s => ({
    hr: rollingMean(s.points, 'hr'),
    hrv: rollingMean(s.points, 'hrv'),
    br: rollingMean(s.points, 'br'),
  })), [sessions])
  const [hover, setHover] = useState<{ seg: number, idx: number } | null>(null)
  const referenceBySession = useMemo(() => sessions.map(s => referenceInSession(reference, s)), [sessions, reference])

  const [brush, setBrush] = useState<{ start: number, end: number } | null>(null)
  const brushStart = useRef<number | null>(null)
  const ticks = axisTicks(axis, timeFormat)
  const multiNight = sessions.length > 1 && (sessions.at(-1)?.end ?? 0) - sessions[0].start > 24 * 60 * 60_000
  const maxMovement = Math.max(1, ...movement.map(b => b.eventCount))

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - box.left
    if (brushStart.current != null) setBrush({ start: brushStart.current, end: Math.max(0, Math.min(plotW, x)) })
    const seg = axis.segments.find(s => s.kind === 'session' && x >= s.x && x <= s.x + s.w)
    if (!seg) return setHover(null)
    const session = sessions[seg.index]
    const t = seg.start + ((Math.min(Math.max(x, seg.x), seg.x + seg.w) - seg.x) / Math.max(1, seg.w)) * (seg.end - seg.start)
    setHover({ seg: seg.index, idx: nearestIndex(session.points, t) })
  }

  const hovered = hover ? sessions[hover.seg]?.points[hover.idx] : undefined
  const hoverSmooth = hover ? smooth[hover.seg] : undefined
  const hoverSeg = hover ? axis.segments.find(s => s.kind === 'session' && s.index === hover.seg) : undefined
  const hoverX = hovered && hoverSeg ? axis.xOf(hoverSeg, hovered.t) : null
  const hoverReference = hovered && hover ? nearestReference(referenceBySession[hover.seg] ?? [], hovered.t) : null

  const traces = useMemo(() => axis.segments.filter(s => s.kind === 'session').map((seg) => {
    const session = sessions[seg.index]
    const xs = session.points.map(p => axis.xOf(seg, p.t))
    return (
      <g key={`s${seg.index}`}>
        {METRICS.map((m, i) => {
          const band = bands[m.key]
          const raw = session.points.map(p => (p[m.key] == null ? null : yOf(i, p[m.key] as number)))
          const sm = smooth[seg.index][m.key].map(v => (v == null ? null : yOf(i, v)))
          return (
            <g key={m.key}>
              {band && (
                <rect x={seg.x} width={seg.w} y={yOf(i, band.hi)} height={Math.max(0, yOf(i, band.lo) - yOf(i, band.hi))} fill={m.color} fillOpacity={0.07} />
              )}
              <path d={pathOf(xs, raw)} fill="none" stroke={m.color} strokeOpacity={0.3} strokeWidth={1} />
              <path d={pathOf(xs, sm)} fill="none" stroke={m.color} strokeWidth={1.75} strokeLinejoin="round" />
            </g>
          )
        })}
        {[
          { key: 'hrv', points: referenceHrv, row: 1, title: (value: number) => `Apple Watch SDNN · ${Math.round(value)} ms` },
          { key: 'br', points: referenceBr, row: 2, title: (value: number) => `Apple Watch breathing · ${value.toFixed(1)} br/min` },
        ].map(({ key, points, row, title }) => (
          <g key={key}>
            {referenceRuns(points.filter(p => p.t >= session.start && p.t <= session.end)).map((run, r) => (
              <g key={r}>
                {run.length > 1 && (
                  <path data-testid={`vitals-watch-${key}-line`} d={pathOf(run.map(p => axis.xOf(seg, p.t)), run.map(p => yOf(row, p.value)))} fill="none" stroke={REFERENCE_STROKE} strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.8} />
                )}
                {run.map((p, i) => (
                  <circle key={i} data-testid={`vitals-watch-${key}`} cx={axis.xOf(seg, p.t)} cy={yOf(row, p.value)} r={2} fill="var(--surface-card)" stroke={REFERENCE_STROKE} strokeWidth={1} strokeOpacity={0.8}>
                    <title>{title(p.value)}</title>
                  </circle>
                ))}
              </g>
            ))}
          </g>
        ))}
        {referenceBySession[seg.index]?.length > 0 && (() => {
          // Lift the pen across sampling gaps (Watch taken off) and
          // mark samples with no neighbour, which a path cannot show.
          const runs = referenceRuns(referenceBySession[seg.index])
          const xs: number[] = []
          const ys: Array<number | null> = []
          runs.forEach((run, r) => {
            if (r > 0) {
              xs.push(0)
              ys.push(null)
            }
            for (const p of run) {
              xs.push(axis.xOf(seg, p.t))
              ys.push(yOf(0, p.hr))
            }
          })
          return (
            <>
              <path
                data-testid="vitals-reference"
                d={pathOf(xs, ys)}
                fill="none"
                stroke={REFERENCE_STROKE}
                strokeWidth={1.25}
                strokeDasharray="3 3"
                strokeLinejoin="round"
              />
              {runs.filter(run => run.length === 1).map(([p]) => (
                <circle key={p.t} data-testid="vitals-reference-dot" cx={axis.xOf(seg, p.t)} cy={yOf(0, p.hr)} r={1.5} fill={REFERENCE_STROKE} />
              ))}
            </>
          )
        })()}
      </g>
    )
  }), [axis, sessions, bands, smooth, referenceBySession, referenceHrv, referenceBr])

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height: HEAD_H + PLOT_H + AXIS_H }} data-testid="vitals-chart">
      {/* Keep units and scales visible while the time axis pans underneath. */}
      <div className="sticky left-0 z-10 h-full bg-surface" style={{ width: LABEL_W + GUTTER }}>
        {METRICS.flatMap((m, i) => m.ticks.map(v => (
          <span key={`${m.key}-${v}`} className="absolute right-2 font-mono text-[10px] text-fg-3" style={{ top: yOf(i, v) - 7 }}>{v}</span>
        )))}
        <span className="absolute right-2 font-mono text-[10px] text-fg-3" style={{ top: HEAD_H + PLOT_H - 10 }}>0</span>
        <span className="absolute right-2 font-mono text-[10px] text-fg-3" style={{ top: HEAD_H + VITALS_H + 18 }}>{maxMovement}</span>
        {/* Row labels */}
        {METRICS.map((m, i) => (
          <div key={m.key} className="absolute left-0 flex flex-col" style={{ top: rowTop(i) + 8, width: LABEL_W }}>
            <span className="flex items-center gap-2 text-[13px]">
              <span className="h-0.5 w-2.5 rounded" style={{ background: m.color }} />
              {m.label}
            </span>
            <span className="pl-[18px] font-mono text-[11px] text-fg-2">{m.unit}</span>
          </div>
        ))}

        <div className="absolute left-0 flex flex-col text-[13px]" style={{ top: HEAD_H + VITALS_H + 22, width: LABEL_W }}>
          <span>Movement</span>
          <span className="font-mono text-[11px] text-fg-2">changes / 5 min</span>
        </div>
      </div>
      {plotW > 0 && (
        <svg className="absolute top-0 overflow-visible" style={{ left: LABEL_W }} width={plotW + GUTTER} height={HEAD_H + PLOT_H + AXIS_H} role="img" aria-label="Heart rate, HRV, breathing and movement per session">
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--status-warn)" strokeOpacity="0.45" strokeWidth="1" />
            </pattern>
          </defs>
          <g transform={`translate(${GUTTER},0)`}>
            {/* Gridlines + tick labels */}
            {METRICS.map((m, i) => m.ticks.map(v => (
              <g key={`${m.key}-${v}`}>
                <line x1={0} x2={plotW} y1={yOf(i, v)} y2={yOf(i, v)} stroke="var(--border-grid)" />
              </g>
            )))}

            {/* Session headers and breaks */}
            {axis.segments.map(seg => seg.kind === 'session'
              ? (
                  <text key={`h${seg.index}`} x={seg.x} y={12} className="fill-fg-2 font-mono" fontSize={10}>
                    {!multiNight && seg.w >= 200 ? sessionHeader(seg) : ''}
                  </text>
                )
              : (
                  <text key="stall-h" x={seg.x + seg.w / 2} y={12} textAnchor="middle" className="fill-warn font-mono" fontSize={10}>NO VITALS</text>
                ))}
            {axis.breaks.map(b => (
              <g key={b.x}>
                <line x1={b.x} x2={b.x} y1={HEAD_H} y2={HEAD_H + PLOT_H} stroke="var(--text-3)" strokeDasharray="2 3" opacity={0.6} />
                {!multiNight && <text x={b.x - 6} y={12} textAnchor="end" className="fill-fg-3 font-mono" fontSize={10}>{fmtGap(b.gapMs)}</text>}
              </g>
            ))}

            {/* Bands, raw and smoothed lines per session */}
            {traces}

            {/* Stalled period */}
            {axis.segments.filter(s => s.kind === 'stall').map(seg => (
              <g key="stall" data-testid="vitals-stall">
                <rect x={seg.x} y={HEAD_H} width={seg.w} height={PLOT_H} fill={`url(#${hatchId})`} />
                <line x1={seg.x} x2={seg.x} y1={HEAD_H} y2={HEAD_H + PLOT_H} stroke="var(--status-warn)" strokeOpacity={0.7} />
                <text x={seg.x + seg.w / 2} y={HEAD_H + PLOT_H + 17} textAnchor="middle" className="fill-warn font-mono" fontSize={10}>{fmtDuration(seg.end - seg.start)}</text>
              </g>
            ))}

            {/* Movement shares the exact same compressed time axis, with its own units. */}
            <line x1={0} x2={plotW} y1={HEAD_H + PLOT_H} y2={HEAD_H + PLOT_H} stroke="var(--border-grid)" />
            {axis.segments.filter(s => s.kind === 'session').flatMap(seg => movement.filter((b) => {
              const t = new Date(b.bucketStart).getTime()
              return t + 300_000 > seg.start && t <= seg.end && b.eventCount > 0
            }).map((b) => {
              const t = new Date(b.bucketStart).getTime()
              const x = axis.xOf(seg, t)
              const h = b.eventCount / maxMovement * 48
              return <rect key={`${seg.index}-${t}`} data-testid="movement-bar" x={x} y={HEAD_H + PLOT_H - h} width={Math.max(1, axis.xOf(seg, t + 300_000) - x)} height={h} fill="var(--text-3)"><title>{`${clock(t, timeFormat)} · ${b.eventCount} position changes`}</title></rect>
            }))}

            {/* Globally spaced date labels for multiple nights, clock labels for one night. */}
            {ticks.map(tick => (
              <text
                key={tick.x}
                x={tick.x}
                y={HEAD_H + PLOT_H + 17}
                textAnchor="start"
                className="fill-fg-3 font-mono"
                fontSize={10}
                opacity={hoverX != null && Math.abs(tick.x - hoverX) < 60 ? 0 : 1}
              >
                {tick.label}
              </text>
            ))}

            {/* Crosshair */}
            {hovered && hoverX != null && (
              <g pointerEvents="none" data-testid="vitals-crosshair">
                <line x1={hoverX} x2={hoverX} y1={HEAD_H} y2={HEAD_H + PLOT_H} stroke="var(--text-2)" strokeOpacity={0.6} />
                {METRICS.map((m, i) => {
                  const v = (hover && hoverSmooth?.[m.key][hover.idx]) ?? hovered[m.key]
                  if (v == null) return null
                  const y = yOf(i, v)
                  const text = v.toFixed(m.digits)
                  const w = text.length * 6.6 + 10
                  const flip = hoverX + 8 + w > plotW
                  return (
                    <g key={m.key}>
                      <circle cx={hoverX} cy={y} r={3} fill={m.color} stroke="var(--surface-card)" strokeWidth={1.5} />
                      <rect x={flip ? hoverX - 8 - w : hoverX + 8} y={y - 22} width={w} height={17} rx={3} fill="var(--surface-active)" stroke="var(--border-2)" />
                      <text x={flip ? hoverX - 8 - w / 2 : hoverX + 8 + w / 2} y={y - 10} textAnchor="middle" className="fill-fg font-mono" fontSize={11}>{text}</text>
                    </g>
                  )
                })}
                {hoverReference && hoverSeg && (
                  <g data-testid="vitals-reference-hover">
                    <circle cx={axis.xOf(hoverSeg, hoverReference.t)} cy={yOf(0, hoverReference.hr)} r={3} fill={REFERENCE_STROKE} stroke="var(--surface-card)" strokeWidth={1.5} />
                    <text x={axis.xOf(hoverSeg, hoverReference.t) + (hoverX + 8 + 60 > plotW ? -8 : 8)} y={yOf(0, hoverReference.hr) + 14} textAnchor={hoverX + 8 + 60 > plotW ? 'end' : 'start'} className="fill-fg-2 font-mono" fontSize={10}>
                      {`watch ${Math.round(hoverReference.hr)}`}
                    </text>
                  </g>
                )}
                {hoverSeg && [
                  { key: 'hrv', points: referenceHrv, row: 1, label: (v: number) => `Watch SDNN ${Math.round(v)} ms` },
                  { key: 'br', points: referenceBr, row: 2, label: (v: number) => `Watch breathing ${v.toFixed(1)} br/min` },
                ].map(({ key, points, row, label }) => {
                  const sample = nearestReference(points.filter(p => p.t >= hoverSeg.start && p.t <= hoverSeg.end), hovered.t)
                  if (!sample) return null
                  const x = axis.xOf(hoverSeg, sample.t)
                  const flip = x + 180 > plotW
                  return (
                    <text key={key} data-testid={`vitals-watch-${key}-hover`} x={x + (flip ? -8 : 8)} y={yOf(row, sample.value) + 14} textAnchor={flip ? 'end' : 'start'} className="fill-fg-2 font-mono" fontSize={10}>
                      {label(sample.value)}
                    </text>
                  )
                })}
                <rect x={Math.min(Math.max(0, hoverX - 70), Math.max(0, plotW - 140))} y={HEAD_H + PLOT_H + 4} width={140} height={18} rx={3} fill="var(--border-2)" />
                <text x={Math.min(Math.max(70, hoverX), Math.max(70, plotW - 70))} y={HEAD_H + PLOT_H + 17} textAnchor="middle" className="fill-fg font-mono" fontSize={11}>{`${new Date(hovered.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${clock(hovered.t, timeFormat)}`}</text>
              </g>
            )}

            {brush && <rect x={Math.min(brush.start, brush.end)} y={HEAD_H} width={Math.abs(brush.end - brush.start)} height={PLOT_H} fill="var(--text-2)" fillOpacity={0.15} stroke="var(--text-2)" pointerEvents="none" data-testid="vitals-selection" />}
            <rect
              x={0}
              y={HEAD_H}
              width={plotW}
              height={PLOT_H}
              fill="transparent"
              style={{ touchAction: 'pan-x pan-y', cursor: onSelectWindow ? 'crosshair' : undefined }}
              onPointerMove={onMove}
              onPointerDown={(e) => {
                onMove(e)
                if (!onSelectWindow || e.shiftKey || e.button !== 0 || e.pointerType === 'touch') return
                const x = e.clientX - e.currentTarget.getBoundingClientRect().left
                brushStart.current = x
                setBrush({ start: x, end: x })
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerUp={(e) => {
                const startX = brushStart.current
                brushStart.current = null
                setBrush(null)
                if (startX == null) return
                const endX = Math.max(0, Math.min(plotW, e.clientX - e.currentTarget.getBoundingClientRect().left))
                if (Math.abs(endX - startX) < 8) return
                const start = timeAtX(axis, Math.min(startX, endX))
                const end = timeAtX(axis, Math.max(startX, endX))
                if (start != null && end != null && end > start) onSelectWindow?.({ start, end })
              }}
              onPointerCancel={() => {
                brushStart.current = null
                setBrush(null)
              }}
              onPointerLeave={e => e.pointerType === 'mouse' && setHover(null)}
            />
          </g>
        </svg>
      )}
    </div>
  )
}

export function VitalsLegend({ bandLabel, stalled, reference = false, referenceHrv = false, referenceBr = false }: { bandLabel: string, stalled: boolean, reference?: boolean, referenceHrv?: boolean, referenceBr?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-[11px] text-fg-2">
      <span className="flex items-center gap-2">
        <span className="h-0.5 w-4 rounded bg-fg-2" />
        9-min average
      </span>
      {referenceHrv && (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1 rounded-full border border-fg/80" />
          Apple Watch HRV · SDNN
        </span>
      )}
      {referenceBr && (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1 rounded-full border border-fg/80" />
          Apple Watch breathing
        </span>
      )}
      {reference && (
        <span className="flex items-center gap-2">
          <span className="h-0 w-4 border-t border-dashed border-fg" />
          Apple Watch heart rate
        </span>
      )}
      <span className="flex items-center gap-2">
        <span className="h-px w-4 bg-fg-3" />
        per minute
      </span>
      <span className="flex items-center gap-2">
        <span className="h-2.5 w-4 rounded-[2px] bg-fg-3/25" />
        {bandLabel}
      </span>
      {stalled && (
        <span className="flex items-center gap-2">
          <span className="h-2.5 w-4 rounded-[2px] border-l border-warn" style={{ backgroundImage: 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--status-warn) 45%, transparent) 0 1px, transparent 1px 5px)' }} />
          in bed, no vitals
        </span>
      )}
    </div>
  )
}

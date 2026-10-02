/**
 * Vitals chart — heart rate, HRV and breathing as three stacked rows on one
 * shared x axis (different units and normal ranges, so never a dual axis).
 * Only in-bed sessions are drawn, each as wide as its share of the time; the
 * empty stretches between them collapse to a dashed break labelled with the
 * gap. When the side is in bed but vitals stopped, a hatched amber segment
 * shows the stall. Each row draws gridlines → the range's p25–p75 band → the
 * raw per-minute line → a 9-minute centred mean. Hover (or tap and drag)
 * shows one crosshair through all rows, snapped to the nearest reading.
 */
'use client'

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react'
import {
  BREAK_PX, clampTo, clock, fmtDuration, fmtGap, layoutAxis, METRICS, nearestIndex, rollingMean, segmentTicks, sessionHeader,
  type MetricKey, type Session,
} from './biometricsLogic'

const LABEL_W = 130
const GUTTER = 34
const ROW_H = 78
const ROW_GAP = 18
const HEAD_H = 24
const AXIS_H = 26
const PLOT_H = METRICS.length * ROW_H + (METRICS.length - 1) * ROW_GAP

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

export function VitalsChart({ sessions, stall, bands }: {
  sessions: Session[]
  /** In bed with no vitals: from the last reading to now. */
  stall: { start: number, end: number } | null
  bands: Record<MetricKey, Band>
}) {
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

  const rowTop = (i: number) => HEAD_H + i * (ROW_H + ROW_GAP)
  const yOf = (i: number, v: number) => {
    const [lo, hi] = METRICS[i].domain
    return rowTop(i) + ROW_H - ((clampTo(v, METRICS[i].domain) - lo) / (hi - lo)) * ROW_H
  }

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - box.left
    const seg = axis.segments.find(s => s.kind === 'session' && x >= s.x - BREAK_PX / 2 && x <= s.x + s.w + BREAK_PX / 2)
    if (!seg) return setHover(null)
    const session = sessions[seg.index]
    const t = seg.start + ((Math.min(Math.max(x, seg.x), seg.x + seg.w) - seg.x) / Math.max(1, seg.w)) * (seg.end - seg.start)
    setHover({ seg: seg.index, idx: nearestIndex(session.points, t) })
  }

  const hovered = hover ? sessions[hover.seg]?.points[hover.idx] : undefined
  const hoverSmooth = hover ? smooth[hover.seg] : undefined
  const hoverSeg = hover ? axis.segments.find(s => s.kind === 'session' && s.index === hover.seg) : undefined
  const hoverX = hovered && hoverSeg ? axis.xOf(hoverSeg, hovered.t) : null

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height: HEAD_H + PLOT_H + AXIS_H }} data-testid="vitals-chart">
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

      {plotW > 0 && (
        <svg className="absolute top-0 overflow-visible" style={{ left: LABEL_W }} width={plotW + GUTTER} height={HEAD_H + PLOT_H + AXIS_H} role="img" aria-label="Heart rate, HRV and breathing per session">
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
                <text x={-8} y={yOf(i, v) + 3.5} textAnchor="end" className="fill-fg-3 font-mono" fontSize={10}>{v}</text>
              </g>
            )))}

            {/* Session headers and breaks */}
            {axis.segments.map(seg => seg.kind === 'session'
              ? (
                  <text key={`h${seg.index}`} x={seg.x} y={12} className="fill-fg-2 font-mono" fontSize={10}>
                    {seg.w >= 130 ? sessionHeader(seg) : seg.w >= 56 ? fmtDuration(seg.end - seg.start) : ''}
                  </text>
                )
              : (
                  <text key="stall-h" x={seg.x + seg.w / 2} y={12} textAnchor="middle" className="fill-warn font-mono" fontSize={10}>NO VITALS</text>
                ))}
            {axis.breaks.map(b => (
              <g key={b.x}>
                <line x1={b.x} x2={b.x} y1={HEAD_H} y2={HEAD_H + PLOT_H} stroke="var(--text-3)" strokeDasharray="2 3" opacity={0.6} />
                <text x={b.x - 6} y={12} textAnchor="end" className="fill-fg-3 font-mono" fontSize={10}>{fmtGap(b.gapMs)}</text>
              </g>
            ))}

            {/* Bands, raw and smoothed lines per session */}
            {axis.segments.filter(s => s.kind === 'session').map((seg) => {
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
                </g>
              )
            })}

            {/* Stalled period */}
            {axis.segments.filter(s => s.kind === 'stall').map(seg => (
              <g key="stall" data-testid="vitals-stall">
                <rect x={seg.x} y={HEAD_H} width={seg.w} height={PLOT_H} fill={`url(#${hatchId})`} />
                <line x1={seg.x} x2={seg.x} y1={HEAD_H} y2={HEAD_H + PLOT_H} stroke="var(--status-warn)" strokeOpacity={0.7} />
                <text x={seg.x + seg.w / 2} y={HEAD_H + PLOT_H + 17} textAnchor="middle" className="fill-warn font-mono" fontSize={10}>{fmtDuration(seg.end - seg.start)}</text>
              </g>
            ))}

            {/* X axis ticks */}
            {axis.segments.filter(s => s.kind === 'session').map(seg => segmentTicks(seg).map(tk => (
              <text
                key={`${seg.index}-${tk.t}`}
                x={axis.xOf(seg, tk.t)}
                y={HEAD_H + PLOT_H + 17}
                textAnchor={tk.t === seg.start ? 'start' : 'middle'}
                className="fill-fg-3 font-mono"
                fontSize={10}
                opacity={hoverX != null && Math.abs(axis.xOf(seg, tk.t) - hoverX) < 40 ? 0 : 1}
              >
                {tk.label}
              </text>
            )))}

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
                <rect x={hoverX - 34} y={HEAD_H + PLOT_H + 4} width={68} height={18} rx={3} fill="var(--border-2)" />
                <text x={hoverX} y={HEAD_H + PLOT_H + 17} textAnchor="middle" className="fill-fg font-mono" fontSize={11}>{clock(hovered.t)}</text>
              </g>
            )}

            <rect
              x={0}
              y={HEAD_H}
              width={plotW}
              height={PLOT_H}
              fill="transparent"
              style={{ touchAction: 'pan-y' }}
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={e => e.pointerType === 'mouse' && setHover(null)}
            />
          </g>
        </svg>
      )}
    </div>
  )
}

export function VitalsLegend({ bandLabel, stalled }: { bandLabel: string, stalled: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-[11px] text-fg-2">
      <span className="flex items-center gap-2">
        <span className="h-0.5 w-4 rounded bg-fg-2" />
        9-min average
      </span>
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

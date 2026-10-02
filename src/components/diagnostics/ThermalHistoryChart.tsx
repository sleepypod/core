'use client'

import { useMemo, useRef, useState, type PointerEvent } from 'react'
import { Card } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import {
  THERMAL_PANELS, hourTicks, nearestPoint, panelDomain, seriesPath, type HistoryPoint, type PanelDef, type ThermalAvailability,
} from './thermalHistoryLogic'

const W = 1000

export interface ThermalHistoryChartProps extends ThermalChartData {
  names: { left: string, right: string }
  formatValue: (panel: PanelDef, v: number | null) => string
  formatTemp: (f: number) => number
  tickFormat: (ms: number) => string
}

export interface ThermalChartData {
  title: string
  points: HistoryPoint[]
  from: number
  to: number
  /** Max gap between neighbouring points before the line breaks, ms. */
  gapMs: number
  powerOn: Array<{ side: 'left' | 'right', at: number }>
  available: ThermalAvailability
  /** Why a panel is empty, keyed by panel id; overrides the default note. */
  emptyNote?: Partial<Record<PanelDef['id'], string>>
}

/**
 * Five stacked panels (bed and target, water, surface, pump rpm, hub) on one
 * time axis. Hovering drops a crosshair through every panel and the right
 * column reads out the values at that moment; otherwise it shows the latest.
 * Power-on times run as dotted lines through all panels.
 */
export function ThermalHistoryChart({
  title, points, from, to, gapMs, powerOn, available, emptyNote, names, formatValue, formatTemp, tickFormat,
}: ThermalHistoryChartProps) {
  const plotRef = useRef<HTMLDivElement>(null)
  const [hoverT, setHoverT] = useState<number | null>(null)
  const span = Math.max(1, to - from)
  const xPct = (t: number) => ((t - from) / span) * 100

  const hovered = hoverT != null ? nearestPoint(points, hoverT) : null
  const ticks = useMemo(() => hourTicks(from, to), [from, to])

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = plotRef.current
    if (!el || points.length === 0) return
    const r = el.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    setHoverT(from + f * span)
  }

  const seriesColor = (side: 'left' | 'right') => (side === 'left' ? 'var(--text-1)' : 'var(--stage-rem)')

  return (
    <Card className="gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-[15px] font-medium">{title}</span>
        <span className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-fg-2">
          <Swatch color={seriesColor('left')} label={`${names.left} · left`} />
          <Swatch color={seriesColor('right')} label={`${names.right} · right`} />
          <Swatch color="var(--text-2)" dashed label="target" />
        </span>
        <span className="ml-auto hidden font-mono text-[11px] text-fg-3 @min-[640px]:inline">hover to inspect</span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-x-4 @min-[760px]:grid-cols-[minmax(0,1fr)_170px]">
        <div
          ref={plotRef}
          data-testid="thermal-plot"
          className="relative ml-9 flex flex-col gap-2 touch-none"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHoverT(null)}
        >
          {THERMAL_PANELS.map((panel) => {
            const ok = available[panel.id]
            const domain = panelDomain(panel, points, formatTemp)
            return (
              <div key={panel.id} className="flex flex-col gap-1">
                <span className="text-xs text-fg-2">{panel.label}</span>
                <div className="relative" style={{ height: panel.height }}>
                  {!ok || !domain
                    ? (
                        <div className="flex h-full items-center justify-center rounded-[6px] border border-dashed border-line font-mono text-[11px] text-fg-3">
                          {emptyNote?.[panel.id] ?? 'no stored readings in this window'}
                        </div>
                      )
                    : (
                        <>
                          {domain.ticks.map(v => (
                            <span
                              key={v}
                              className="absolute -left-9 w-8 -translate-y-1/2 text-right font-mono text-[10px] text-fg-3"
                              style={{ top: `${(1 - (v - domain.min) / (domain.max - domain.min)) * 100}%` }}
                            >
                              {panel.kind === 'rpm' ? (v >= 1000 ? `${v / 1000}k` : String(v)) : `${v}°`}
                            </span>
                          ))}
                          <svg viewBox={`0 0 ${W} 100`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
                            {domain.ticks.map(v => (
                              <line key={v} x1={0} x2={W} y1={(1 - (v - domain.min) / (domain.max - domain.min)) * 100} y2={(1 - (v - domain.min) / (domain.max - domain.min)) * 100} stroke="var(--border-1, var(--text-3))" strokeOpacity={0.25} vectorEffect="non-scaling-stroke" />
                            ))}
                            {panel.series.map(s => (
                              <path
                                key={s.key}
                                d={seriesPath(points, s.key, from, span, W, domain, gapMs, panel.kind === 'temp' ? formatTemp : undefined)}
                                fill="none"
                                stroke={s.color ?? seriesColor(s.side ?? 'left')}
                                strokeWidth={1.5}
                                strokeDasharray={s.dashed ? '5 4' : undefined}
                                strokeOpacity={s.dashed ? 0.8 : 1}
                                vectorEffect="non-scaling-stroke"
                              />
                            ))}
                          </svg>
                        </>
                      )}
                </div>
              </div>
            )
          })}

          {powerOn.filter(p => p.at >= from && p.at <= to).map(p => (
            <div key={`${p.side}-${p.at}`} className="pointer-events-none absolute inset-y-0 border-l border-dotted border-fg-3" style={{ left: `${xPct(p.at)}%` }}>
              <span className="absolute -top-0.5 left-1 whitespace-nowrap font-mono text-[10px] text-fg-3">{`${names[p.side]} on`}</span>
            </div>
          ))}

          {hovered && (
            <div data-testid="thermal-crosshair" className="pointer-events-none absolute inset-y-0 border-l border-fg-2" style={{ left: `${xPct(hovered.t)}%` }} />
          )}

          <div className="relative h-4 font-mono text-[10px] text-fg-3">
            {ticks.map(t => (
              <span key={t} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${xPct(t)}%` }}>{tickFormat(t)}</span>
            ))}
            {hovered && (
              <span className="absolute -translate-x-1/2 rounded-[4px] bg-fg px-1.5 text-inverse" style={{ left: `${xPct(hovered.t)}%` }}>
                {tickFormat(hovered.t)}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {THERMAL_PANELS.map(panel => (
            <div key={panel.id} className="flex flex-col justify-center gap-1" style={{ height: panel.height + 20 }}>
              {panel.series.map((s) => {
                const v = hovered ? hovered[s.key] : latest(points, s.key)
                return (
                  <div key={s.key} className="flex items-center gap-2 font-mono text-xs">
                    <Swatch color={s.color ?? seriesColor(s.side ?? 'left')} dashed={s.dashed} />
                    <span className="truncate text-fg-2">{s.side && !s.dashed ? names[s.side] : s.label}</span>
                    <span className={cn('ml-auto', v == null && 'text-fg-3')}>{formatValue(panel, v)}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}

function latest(points: HistoryPoint[], key: keyof HistoryPoint): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i][key]
    if (v != null) return v
  }
  return null
}

function Swatch({ color, dashed, label }: { color: string, dashed?: boolean, label?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('block w-3.5 border-t-2', dashed && 'border-dashed')} style={{ borderColor: color }} />
      {label}
    </span>
  )
}

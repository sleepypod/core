'use client'

import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useId, useState, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { Card, Skeleton } from '@/src/components/ds'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { dropHolds, stepPath, useNowMinute } from '@/src/components/Schedule/CurveChart'
import { formatCountdown } from '@/src/components/Schedule/bothNight'
import { NEUTRAL_TEMP_F, TONE_VAR, tempTone } from '@/src/components/Schedule/scheduleFormat'
import { useSideNames } from '@/src/hooks/useSideNames'
import { formatSetpointF, type TempUnit } from '@/src/lib/tempUtils'
import type { Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import {
  nextPoint, nightCurve, nightMismatch, powerIntervals, presenceIntervals, targetAt, tempRange, timelineWindow,
  type CurvePoint, type Interval, type TimelineWindow,
} from './timelineLogic'

const SIDES: Side[] = ['left', 'right']
const HOUR = 3_600_000
const CURVE_H = 56
/** SVG user-space width; the curve stretches to the lane (strokes stay 1.5px). */
const VB_W = 1000

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const nightDate = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')

/**
 * Temp → Schedule and sleep: one time axis from 6 PM before last night to
 * 9 AM after tonight. Per side: the schedule curve for both nights, when the
 * side was actually powered (last 24 h), and when someone was in bed, with
 * last night's mismatches (bed empty while the schedule ran, still in bed
 * after it ended) labelled on the chart. A now line and the next set point
 * tie it to the present.
 *
 * Wires into schedules.getAll, biometrics.getSleepRecords and
 * health.thermalHistory (24h).
 */
export function ScheduleTimeline({ unit, className, sides = SIDES }: { unit: TempUnit, className?: string, sides?: readonly Side[] }) {
  const lang = langFromPath(usePathname())
  const nowMinute = useNowMinute()
  const win = nowMinute == null ? null : timelineWindow(new Date(nowMinute * 60_000))

  if (!win || nowMinute == null) return <Skeleton className={cn('h-[300px]', className)} />
  const now = nowMinute * 60_000

  return (
    <Card className={cn('@container gap-3', className)} data-testid="schedule-timeline">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-medium">Schedule and sleep</span>
        <span className="font-mono text-xs text-fg-2">last night and tonight</span>
        <Link
          href={`/${lang}/schedule`}
          className="ml-auto flex items-center gap-1 text-[13px] text-fg-2 no-underline hover:text-fg hover:no-underline"
        >
          Schedule
          <ArrowRight size={14} />
        </Link>
      </div>
      <TimelineBody win={win} now={now} unit={unit} sides={sides} />
    </Card>
  )
}

function TimelineBody({ win, now, unit, sides }: { win: TimelineWindow, now: number, unit: TempUnit, sides: readonly Side[] }) {
  const span = win.end - win.start
  const pct = (t: number) => ((t - win.start) / span) * 100
  const ticks: number[] = []
  for (let t = win.start; t <= win.end; t += 3 * HOUR) ticks.push(t)
  const [last, tonight] = win.nights
  const tonightAt = new Date(tonight.midnight.getFullYear(), tonight.midnight.getMonth(), tonight.midnight.getDate(), 18).getTime()
  // Same hover as the Schedule charts: a line across the lanes and each side's target at that time.
  const [hoverT, setHoverT] = useState<number | null>(null)
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - 96
    const w = rect.width - 96
    setHoverT(x < 0 || w <= 0 ? null : win.start + Math.min(1, x / w) * span)
  }

  return (
    <div
      className="relative grid grid-cols-[84px_minmax(0,1fr)] gap-x-3"
      data-testid="timeline-body"
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHoverT(null)}
    >
      {/* Hour grid behind the lanes. */}
      <div aria-hidden className="pointer-events-none absolute top-5 bottom-5 right-0 left-[96px]">
        {ticks.map(t => (
          <span key={t} className="absolute inset-y-0 border-l border-grid" style={{ left: `${pct(t)}%` }} />
        ))}
      </div>

      <span />
      <div className="relative h-5 font-mono text-[10px] tracking-[0.06em] text-fg-3 uppercase">
        <span className="absolute left-0">{`Last night · ${nightDate(last.midnight)}`}</span>
        <span className="absolute" style={{ left: `${pct(tonightAt)}%` }}>{`Tonight · ${nightDate(tonight.midnight)}`}</span>
      </div>

      <span />
      <div className="h-4" />

      {sides.map(side => <SideRows key={side} side={side} win={win} now={now} unit={unit} pct={pct} hoverT={hoverT} />)}

      <span />
      <div className="relative h-5 font-mono text-[10px] text-fg-3" aria-hidden>
        {ticks.map((t, i) => (
          <span
            key={t}
            className={cn('absolute bottom-0 whitespace-nowrap', i % 2 === 1 && i !== ticks.length - 1 && '@max-[860px]:hidden')}
            style={{ left: `${pct(t)}%`, transform: i === 0 ? undefined : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}
          >
            {new Date(t).toLocaleTimeString([], { hour: 'numeric' })}
          </span>
        ))}
      </div>

      <div
        aria-hidden
        data-testid="timeline-now"
        className="pointer-events-none absolute top-5 bottom-5 border-l border-fg-2"
        style={{ left: `calc(96px + (100% - 96px) * ${pct(now) / 100})` }}
      >
        <span className="absolute top-0 left-1.5 whitespace-nowrap font-mono text-[10px] leading-4 text-fg-2">{`now ${clock(now)}`}</span>
      </div>
      {hoverT != null && (
        <div
          aria-hidden
          data-testid="timeline-hover"
          className="pointer-events-none absolute top-5 bottom-5 border-l border-fg/35"
          style={{ left: `calc(96px + (100% - 96px) * ${pct(hoverT) / 100})` }}
        >
          <span className={cn('absolute top-0 whitespace-nowrap font-mono text-[10px] leading-4 text-fg', pct(hoverT) > 50 ? 'right-1.5' : 'left-1.5')}>
            {clock(hoverT)}
          </span>
        </div>
      )}
    </div>
  )
}

function SideRows({ side, win, now, unit, pct, hoverT }: {
  side: Side
  win: TimelineWindow
  now: number
  unit: TempUnit
  pct: (t: number) => number
  hoverT: number | null
}) {
  const { sideName } = useSideNames()
  const schedules = trpc.schedules.getAll.useQuery({ side }, { staleTime: 60_000 })
  const records = trpc.biometrics.getSleepRecords.useQuery(
    { side, startDate: new Date(win.start - 12 * HOUR), limit: 10 },
    { staleTime: 60_000, refetchInterval: 5 * 60_000 },
  )
  const history = trpc.health.thermalHistory.useQuery({ range: '24h' }, { staleTime: 60_000, refetchInterval: 60_000 })

  const curves = win.nights.map(n => nightCurve(schedules.data?.temperature, n.midnight))
  const range = tempRange(curves)
  const presence = presenceIntervals(records.data, win.start, win.end, now)
  const power = history.data
    ? powerIntervals(history.data.points, side === 'left' ? 'leftTarget' : 'rightTarget', history.data.bucketSec * 1000)
    : []
  const mismatches = curves.map(c => nightMismatch(c, presence))
  const next = nextPoint(curves, now)
  const annotations = mismatches.flatMap((m, i) => [
    m.emptyBefore && {
      key: `${i}-empty`,
      at: m.emptyBefore,
      label: `bed empty while ${bedAction(heldAt(curves[i], m.emptyBefore.end))} · ${formatCountdown(m.emptyBefore.end - m.emptyBefore.start)}`,
    },
    m.pastEnd && {
      key: `${i}-past`,
      at: m.pastEnd,
      label: `in bed ${formatCountdown(m.pastEnd.end - m.pastEnd.start)} past schedule`,
    },
  ]).filter(a => !!a)

  const fmt = (f: number) => formatSetpointF(f, unit, { includeUnit: false })
  const rangeLabel = range
    ? `${fmt(Math.min(...curves.flat().map(p => p.temperature)))}–${formatSetpointF(Math.max(...curves.flat().map(p => p.temperature)), unit)}`
    : 'no schedule'

  return (
    <>
      <div className="flex min-w-0 flex-col justify-center">
        <span className="truncate text-[13px]">{sideName(side)}</span>
        <span className="font-mono text-[10px] text-fg-3">{rangeLabel}</span>
      </div>
      <div className="relative" style={{ height: CURVE_H }} data-testid={`timeline-${side}-curve`}>
        {range && <CurveLane curves={curves} range={range} win={win} />}
        {next && range && (
          <>
            <span
              className="absolute size-2.5 -translate-1/2 rounded-full border-2 border-fg-2 bg-surface"
              style={{ left: `${pct(next.at)}%`, top: yPct(next.temperature, range) * CURVE_H / 100 }}
            />
            <span
              className="absolute top-0 -translate-x-full pr-2 whitespace-nowrap font-mono text-[10px] text-fg-2"
              style={{ left: `${pct(next.at)}%` }}
            >
              {`next · ${fmt(next.temperature)} in ${formatCountdown(next.at - now)}`}
            </span>
          </>
        )}
        {hoverT != null && range && (
          <span
            data-testid={`timeline-${side}-hover`}
            className={cn('absolute bottom-0 whitespace-nowrap font-mono text-[10px] text-fg', pct(hoverT) > 50 ? '-translate-x-full pr-1.5' : 'pl-1.5')}
            style={{ left: `${pct(hoverT)}%` }}
          >
            {(() => {
              const t = targetAt(curves, hoverT)
              return t == null ? '—' : fmt(t)
            })()}
          </span>
        )}
      </div>

      <span className="self-center font-mono text-[10px] text-fg-3">on</span>
      <Bars intervals={power} pct={pct} className="bg-fg-3" testId={`timeline-${side}-power`} label={`${sideName(side)} powered`} />

      <span className="self-center font-mono text-[10px] text-fg-3">in bed</span>
      <Bars intervals={presence} pct={pct} className="bg-ok" testId={`timeline-${side}-presence`} label={`${sideName(side)} in bed`} />

      <span />
      <div className={cn('relative', annotations.length > 0 ? 'mb-2 h-6' : 'h-2')}>
        {annotations.map(a => (
          <div key={a.key} className="absolute top-0.5" style={{ left: `${pct(a.at.start)}%`, width: `${pct(a.at.end) - pct(a.at.start)}%` }}>
            <div className="h-1.5 border-x border-b border-warn" />
            <span className="absolute top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] text-warn">{a.label}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/** The set point the schedule was holding at `t`. */
function heldAt(curve: CurvePoint[], t: number): number {
  let held = curve[0].temperature
  for (const p of curve) if (p.at <= t) held = p.temperature
  return held
}

function bedAction(tempF: number): string {
  const tone = tempTone(tempF)
  return tone === 'cool' ? 'cooling' : tone === 'warm' ? 'warming' : 'on'
}

function yPct(temperature: number, range: { lo: number, hi: number }): number {
  const pad = 8
  return pad + (1 - (temperature - range.lo) / (range.hi - range.lo)) * (100 - pad * 2)
}

function CurveLane({ curves, range, win }: { curves: CurvePoint[][], range: { lo: number, hi: number }, win: TimelineWindow }) {
  const id = `tl-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const span = win.end - win.start
  const X = (t: number) => ((t - win.start) / span) * VB_W
  const Y = (v: number) => yPct(v, range)
  const neutral = NEUTRAL_TEMP_F >= range.lo && NEUTRAL_TEMP_F <= range.hi ? Y(NEUTRAL_TEMP_F) : null

  return (
    <svg viewBox={`0 0 ${VB_W} 100`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
      {neutral != null && (
        <line x1="0" x2={VB_W} y1={neutral} y2={neutral} stroke="var(--border-grid)" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
      )}
      {curves.map((curve, i) => {
        const pts = dropHolds(curve)
        if (pts.length < 2) return null
        const coords = pts.map(p => ({ x: X(p.at), y: Y(p.temperature) }))
        const x0 = coords[0].x
        const x1 = coords[coords.length - 1].x
        const path = stepPath(coords)
        return (
          <g key={i}>
            <defs>
              <linearGradient id={`${id}-${i}`} x1={x0} y1="0" x2={x1} y2="0" gradientUnits="userSpaceOnUse">
                {pts.map((p, j) => (
                  <stop key={j} offset={((coords[j].x - x0) / (x1 - x0 || 1)).toFixed(3)} stopColor={TONE_VAR[tempTone(p.temperature)]} />
                ))}
              </linearGradient>
            </defs>
            <path d={`${path} L${x1},100 L${x0},100 Z`} fill="var(--text-1)" fillOpacity="0.04" />
            <path d={path} fill="none" stroke={`url(#${id}-${i})`} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </g>
        )
      })}
    </svg>
  )
}

function Bars({ intervals, pct, className, testId, label }: {
  intervals: Interval[]
  pct: (t: number) => number
  className: string
  testId: string
  label: string
}) {
  return (
    <div className="relative my-1 h-2 rounded-full bg-active" data-testid={testId}>
      {intervals.map(iv => (
        <span
          key={iv.start}
          title={`${label} ${clock(iv.start)} → ${clock(iv.end)}`}
          className={cn('absolute inset-y-0 min-w-0.5 rounded-full', className)}
          style={{ left: `${Math.max(0, pct(iv.start))}%`, width: `${pct(iv.end) - Math.max(0, pct(iv.start))}%` }}
        />
      ))}
    </div>
  )
}

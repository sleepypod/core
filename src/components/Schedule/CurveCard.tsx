'use client'

import { Fragment, type MouseEvent } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge, Card, GhostIcon, StatusDot } from '@/src/components/ds'
import type { ScheduleGroup } from '@/src/lib/scheduleGrouping'
import { sortChronological } from '@/src/lib/scheduleGrouping'
import { formatTime12h } from '@/src/lib/scheduleTime'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatSetpointF, setpointFToDisplay, type TempUnit } from '@/src/lib/tempUtils'
import { buildTimeline, CurveChart, CurveLegend, dropHolds, MiniCurve, type BedSample } from './CurveChart'
import { TONE_TEXT, formatDayRange, tempTone } from './scheduleFormat'

interface CurveCardProps {
  group: ScheduleGroup
  onEdit: () => void
  onDelete: () => void
  /** True when this curve covers today and the schedule is enabled */
  isActive?: boolean
  /** Next upcoming set point (only meaningful when isActive) */
  nextEvent?: { time: string, temperature: number } | null
  /** Large chart card (the curve running today) vs. compact list card. */
  featured?: boolean
  /** Featured only: measured bed temperature on the chart's minute axis, with its legend label ("last night"). */
  bed?: { samples: BedSample[], label: string }
}

/** "79–84°F" / "79–84°" — set-point range in the user's unit. */
export function formatTempRange(setPoints: Array<{ temperature: number }>, unit: TempUnit, withUnit = true): string {
  if (setPoints.length === 0) return ''
  const temps = setPoints.map(p => Math.round(setpointFToDisplay(p.temperature, unit) ?? p.temperature))
  const min = Math.min(...temps)
  const max = Math.max(...temps)
  const range = min === max ? `${min}` : `${min}–${max}`
  return `${range}°${withUnit ? unit : ''}`
}

/** "11:15 PM → 7:00 AM" from the chronologically first and last set points. */
export function formatWindow(setPoints: Array<{ time: string, temperature: number }>): string | null {
  if (setPoints.length < 2) return null
  const sorted = sortChronological(setPoints)
  return `${formatTime12h(sorted[0].time)} → ${formatTime12h(sorted[sorted.length - 1].time)}`
}

export interface CurvePhase {
  time: string
  caption: string
  /** Start temperature (°F) of a ramp; absent for a hold, power-on or off. */
  from?: number
  /** Temperature (°F) the phase holds or ramps to; absent for power off. */
  to?: number
}

/** Ramp endpoint: the temperature in `pts` farthest from `start`. */
function extreme(start: number, pts: Array<{ temperature: number }>): number {
  return pts.reduce((best, p) => (Math.abs(p.temperature - start) > Math.abs(best - start) ? p.temperature : best), start)
}

function formatDuration(minutes: number): string {
  return minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes)} min`
}

/**
 * The night in (up to) four parts instead of individual set points: the
 * ramp before the longest hold, the hold itself, the ramp after it, and power
 * off. Points that repeat the previous temperature are ignored.
 */
export function curvePhases(setPoints: Array<{ time: string, temperature: number }>): CurvePhase[] {
  const pts = dropHolds(buildTimeline(setPoints))
  if (pts.length === 0) return []
  if (pts.length === 1) return [{ time: pts[0].item.time, caption: 'Power on', to: pts[0].temperature }]

  const last = pts.length - 1
  let hold = 0
  for (let i = 1; i < last; i++) {
    if (pts[i + 1].minutes - pts[i].minutes > pts[hold + 1].minutes - pts[hold].minutes) hold = i
  }

  const phases: CurvePhase[] = []
  if (hold > 0) {
    const start = pts[0].temperature
    const to = extreme(start, pts.slice(1, hold))
    phases.push(to === start
      ? { time: pts[0].item.time, caption: 'Power on', to: start }
      : { time: pts[0].item.time, caption: to > start ? 'Warm-up' : 'Cool-down', from: start, to })
  }
  phases.push({
    time: pts[hold].item.time,
    caption: `${hold === 0 ? 'Power on · hold' : 'Hold'} · ${formatDuration(pts[hold + 1].minutes - pts[hold].minutes)}`,
    to: pts[hold].temperature,
  })
  if (hold + 1 < last) {
    const start = pts[hold].temperature
    phases.push({ time: pts[hold + 1].item.time, caption: 'Wake ramp', from: start, to: extreme(start, pts.slice(hold + 1, last)) })
  }
  phases.push({ time: pts[last].item.time, caption: 'Power off' })
  return phases
}

/** The night's phases as columns: time, temperature (or ramp), caption. */
export function PhaseStrip({ setPoints, className }: { setPoints: Array<{ time: string, temperature: number }>, className?: string }) {
  const { unit } = useTemperatureUnit()
  const phases = curvePhases(setPoints)
  return (
    <div
      className={cn('grid gap-2', className)}
      style={{ gridTemplateColumns: `repeat(${phases.length}, minmax(0, 1fr))` }}
    >
      {phases.map(ph => (
        <div key={`${ph.time}-${ph.caption}`} className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-[11px] text-fg-2">{formatTime12h(ph.time)}</span>
          <span className="whitespace-nowrap font-mono text-lg">
            {ph.to === undefined
              ? <span>Off</span>
              : (
                  <>
                    {ph.from !== undefined && (
                      <>
                        <span className={TONE_TEXT[tempTone(ph.from)]}>{formatSetpointF(ph.from, unit, { includeUnit: false }).replace(/°$/, '')}</span>
                        <span className="text-fg-3">{' → '}</span>
                      </>
                    )}
                    <span className={TONE_TEXT[tempTone(ph.to)]}>{formatSetpointF(ph.to, unit, { includeUnit: false })}</span>
                  </>
                )}
          </span>
          <span className="text-xs text-fg-2">{ph.caption}</span>
        </div>
      ))}
    </div>
  )
}

function stop(fn: () => void) {
  return (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }
}

export function CurveCard({ group, onEdit, onDelete, isActive = false, nextEvent = null, featured = false, bed }: CurveCardProps) {
  const { unit } = useTemperatureUnit()
  const hasSetPoints = group.setPoints.length > 0
  const paused = !!group.allDisabled
  const label = formatDayRange(group.days)
  const sleepWindow = formatWindow(group.setPoints)
  const active = isActive && hasSetPoints && !paused

  const actions = (
    <div className="ml-auto flex items-center gap-1">
      <GhostIcon icon={Pencil} size={15} label={`Edit ${label}`} onClick={stop(onEdit)} />
      <GhostIcon icon={Trash2} size={15} label={`Delete ${label}`} className="text-fg-3" onClick={stop(onDelete)} />
    </div>
  )

  if (featured && hasSetPoints && !paused) {
    const meta = [sleepWindow, formatTempRange(group.setPoints, unit)].filter(Boolean).join(' · ')
    return (
      <Card
        highlight={active}
        className="gap-2 px-4 py-3.5 min-[900px]:gap-3.5 min-[900px]:p-5"
        data-testid="curve-card-featured"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-[15px] font-medium min-[900px]:text-base">{label}</span>
          {active && (
            <>
              <Badge variant="active" className="hidden min-[900px]:inline-flex" />
              <StatusDot tone="ok" size={5} mono label="ACTIVE" className="text-[10px] min-[900px]:hidden" />
            </>
          )}
          <span className="hidden font-mono text-xs text-fg-2 min-[900px]:inline">{meta}</span>
          {bed && bed.samples.length > 0 && <CurveLegend bedLabel={`Bed · ${bed.label}`} className="ml-auto hidden min-[900px]:flex" />}
          {actions}
        </div>

        {/* Desktop: full chart + set-point strip */}
        <div className="hidden flex-col gap-3.5 min-[900px]:flex">
          <CurveChart setPoints={group.setPoints} height={220} showNow={active} bed={bed?.samples} />
          <PhaseStrip setPoints={group.setPoints} className="border-t border-line pt-3.5" />
        </div>

        {/* Phone: sparkline + next set point */}
        <div className="flex flex-col gap-2 min-[900px]:hidden">
          <MiniCurve setPoints={group.setPoints} height={44} />
          <span className="font-mono text-xs text-fg-2">{meta}</span>
          {active && nextEvent && (
            <span className="border-t border-line pt-2 font-mono text-xs text-fg-2">
              Next
              {' '}
              <span className="text-ok">{nextEvent.time}</span>
              {' · '}
              <span className="text-fg">{formatSetpointF(nextEvent.temperature, unit, { includeUnit: false })}</span>
            </span>
          )}
        </div>
      </Card>
    )
  }

  return (
    <Card
      flat
      dashed={paused}
      tone={paused ? 'warn' : undefined}
      onClick={onEdit}
      className="gap-2 px-4 py-3.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[15px] font-medium min-[900px]:text-sm">{label}</span>
        {paused && <Badge variant="paused" />}
        {actions}
      </div>
      {paused
        ? (
            <div className="flex items-center text-xs text-fg-3 min-[900px]:h-8">No set points active</div>
          )
        : hasSetPoints && <MiniCurve setPoints={group.setPoints} className="hidden min-[900px]:block" />}
      <span className="font-mono text-xs text-fg-2">
        {paused
          ? 'Schedule paused'
          : [sleepWindow, formatTempRange(group.setPoints, unit, false)].filter(Boolean).map((part, i) => (
              <Fragment key={i}>
                {i > 0 && ' · '}
                <span className="whitespace-nowrap">{part}</span>
              </Fragment>
            ))}
      </span>
    </Card>
  )
}

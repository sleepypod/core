'use client'

import { useMemo, useState } from 'react'
import { ChevronRight, Calendar } from 'lucide-react'
import clsx from 'clsx'
import { AreaChart, Area, ResponsiveContainer, YAxis } from 'recharts'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { groupDaysBySharedCurve } from '@/src/lib/scheduleGrouping'
import type { ScheduleGroup } from '@/src/lib/scheduleGrouping'
import type { DayOfWeek } from './DaySelector'
import { DAYS } from './DaySelector'
import { colorForTempF } from '@/src/lib/sleepCurve/tempColor'

/** Short labels keyed by DayOfWeek */
const DAY_SHORT: Record<DayOfWeek, string> = {
  sunday: 'Sun',
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
}

interface ScheduleWeekOverviewProps {
  /** Called when the user taps a group to edit it */
  onSelectGroup?: (group: ScheduleGroup) => void
  /** Controlled expanded state */
  expanded?: boolean
  /** Called when expanded state changes */
  onExpandedChange?: (expanded: boolean) => void
}

export function ScheduleWeekOverview({ onSelectGroup, expanded: controlledExpanded, onExpandedChange }: ScheduleWeekOverviewProps) {
  const { side } = useSide()
  const [internalExpanded, setInternalExpanded] = useState(false)
  const expanded = controlledExpanded ?? internalExpanded
  const setExpanded = onExpandedChange ?? setInternalExpanded

  const { data, isLoading } = trpc.schedules.getAll.useQuery({ side })

  const temperature = data?.temperature
  const groups = useMemo<ScheduleGroup[]>(() => {
    if (!temperature) return []
    return groupDaysBySharedCurve(temperature)
  }, [temperature])

  // Don't render anything if there are no schedules at all
  const hasAnyContent = groups.some(g => g.setPoints.length > 0 || g.allDisabled)
  if (!isLoading && !hasAnyContent) return null

  if (isLoading) {
    return (
      <div className="h-12 animate-pulse rounded-2xl bg-zinc-900" />
    )
  }

  return (
    <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2"
      >
        <Calendar size={16} className="text-zinc-500" />
        <span className="text-sm font-medium text-zinc-400">Week Overview</span>
        <span className="ml-auto text-[10px] text-zinc-600">
          {groups.filter(g => g.setPoints.length > 0).length}
          {' '}
          {groups.filter(g => g.setPoints.length > 0).length === 1 ? 'curve' : 'curves'}
        </span>
        <ChevronRight
          size={14}
          className={clsx(
            'text-zinc-600 transition-transform duration-200',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {/* Expanded content — only show groups that have set points or are explicitly paused */}
      {expanded && (
        <div className="mt-3 space-y-2">
          {groups.filter(g => g.setPoints.length > 0 || g.allDisabled).map(group => (
            <GroupCard
              key={group.key}
              group={group}
              onTap={onSelectGroup ? () => onSelectGroup(group) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Group Card ──────────────────────────────────────────────────────

interface GroupCardProps {
  group: ScheduleGroup
  onTap?: () => void
}

function GroupCard({ group, onTap }: GroupCardProps) {
  const hasSetPoints = group.setPoints.length > 0

  return (
    <button
      onClick={onTap}
      disabled={!onTap}
      className={clsx(
        'w-full rounded-xl border p-2.5 text-left transition-colors sm:p-3',
        hasSetPoints
          ? 'border-zinc-800 bg-zinc-800/50 active:border-sky-500/40'
          : group.allDisabled
            ? 'border-dashed border-zinc-700/50 bg-zinc-900/50'
            : 'border-zinc-800/50 bg-zinc-900/50',
        onTap && 'cursor-pointer',
      )}
    >
      <div className="flex items-center gap-2.5">
        {/* Day pills */}
        <div className="flex flex-wrap gap-1">
          {DAYS.map(({ key }) => {
            const isInGroup = group.days.includes(key)
            return (
              <span
                key={key}
                className={clsx(
                  'inline-flex h-6 min-w-[2rem] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold transition-colors',
                  isInGroup
                    ? hasSetPoints
                      ? 'bg-sky-500/20 text-sky-400'
                      : group.allDisabled
                        ? 'bg-amber-500/10 text-amber-600/70'
                        : 'bg-zinc-700/50 text-zinc-500'
                    : 'bg-transparent text-zinc-700',
                )}
              >
                {DAY_SHORT[key]}
              </span>
            )
          })}
        </div>

        {/* Temp range + set point count */}
        <div className="ml-auto shrink-0 text-right">
          {hasSetPoints && (
            <span className="block text-[11px] font-medium text-zinc-300">
              {Math.min(...group.setPoints.map(p => p.temperature))}
              °–
              {Math.max(...group.setPoints.map(p => p.temperature))}
              °
            </span>
          )}
          <span className={clsx(
            'text-[10px]',
            group.allDisabled ? 'text-amber-600/70' : 'text-zinc-500',
          )}
          >
            {hasSetPoints
              ? `${group.setPoints.length} set ${group.setPoints.length === 1 ? 'point' : 'points'}`
              : 'Schedule paused'}
          </span>
        </div>
      </div>

      {/* Mini curve sparkline */}
      {hasSetPoints && (
        <div className="mt-2">
          <MiniCurve setPoints={group.setPoints} />
        </div>
      )}
    </button>
  )
}

// ── Mini Curve Sparkline ────────────────────────────────────────────

interface MiniCurveProps {
  setPoints: Array<{ time: string, temperature: number }>
}

/**
 * Mini Recharts sparkline showing temperature set points.
 * No axes, no tooltips — just a smooth monotone curve.
 *
 * Handles overnight schedules: if set points span midnight
 * (e.g. 22:00, 00:30, 06:00), early-morning times are shifted
 * by +24h so the sparkline reads left-to-right chronologically.
 */
let miniCurveCounter = 0

function MiniCurve({ setPoints }: MiniCurveProps) {
  const gradientId = useMemo(() => `miniCurveGrad-${miniCurveCounter++}`, [])

  const { chartData, gradientStops } = useMemo(() => {
    if (setPoints.length === 0) return { chartData: [], gradientStops: [] }

    const HALF_DAY = 12 * 60

    const withMinutes = setPoints.map((p) => {
      const [h, m] = p.time.split(':').map(Number)
      return { ...p, minutes: h * 60 + m }
    })

    // Detect overnight wrap
    const byClock = [...withMinutes].sort((a, b) => a.minutes - b.minutes)
    let isOvernight = false
    const hasEarlyMorning = byClock.some(p => p.minutes < HALF_DAY)
    const hasEvening = byClock.some(p => p.minutes >= HALF_DAY)
    if (hasEarlyMorning && hasEvening) {
      for (let i = 0; i < byClock.length - 1; i++) {
        if (byClock[i + 1].minutes - byClock[i].minutes > HALF_DAY) {
          isOvernight = true
          break
        }
      }
    }

    const sorted = withMinutes
      .map(p => ({
        minutes: isOvernight && p.minutes < HALF_DAY ? p.minutes + 24 * 60 : p.minutes,
        temp: p.temperature,
      }))
      .sort((a, b) => a.minutes - b.minutes)

    const minM = sorted[0].minutes
    const maxM = sorted[sorted.length - 1].minutes
    const range = maxM - minM || 1
    const stops = sorted.map(d => ({
      offset: `${((d.minutes - minM) / range) * 100}%`,
      color: colorForTempF(d.temp),
    }))

    return { chartData: sorted, gradientStops: stops }
  }, [setPoints])

  if (chartData.length === 0) return null

  return (
    <ResponsiveContainer width="100%" height={36} minWidth={1} minHeight={1}>
      <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            {gradientStops.map((stop, i) => (
              <stop key={i} offset={stop.offset} stopColor={stop.color} stopOpacity={0.6} />
            ))}
          </linearGradient>
          <linearGradient id={`${gradientId}-line`} x1="0" y1="0" x2="1" y2="0">
            {gradientStops.map((stop, i) => (
              <stop key={i} offset={stop.offset} stopColor={stop.color} stopOpacity={1} />
            ))}
          </linearGradient>
        </defs>
        <YAxis domain={['dataMin - 2', 'dataMax + 2']} hide />
        <Area
          type="monotone"
          dataKey="temp"
          stroke={`url(#${gradientId}-line)`}
          strokeWidth={1.5}
          fill={`url(#${gradientId})`}
          fillOpacity={0.15}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

'use client'

import { useMemo } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { AreaChart, Area, ResponsiveContainer, YAxis } from 'recharts'
import type { ScheduleGroup } from '@/src/lib/scheduleGrouping'
import type { DayOfWeek } from './DaySelector'
import { colorForTempF } from '@/src/lib/sleepCurve/tempColor'

interface CurveCardProps {
  group: ScheduleGroup
  onEdit: () => void
  onDelete: () => void
}

const DAY_SHORT: Record<DayOfWeek, string> = {
  sunday: 'Sun', monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed',
  thursday: 'Thu', friday: 'Fri', saturday: 'Sat',
}

const DAY_ORDER: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

/**
 * Format a set of days as a human-readable range, e.g.
 *   ["monday", "tuesday", "wednesday"] → "Mon–Wed"
 *   ["monday", "wednesday", "friday"]  → "Mon, Wed, Fri"
 *   ["saturday", "sunday"]             → "Sat, Sun"
 *   all 7                              → "Every day"
 */
function formatDayRange(days: DayOfWeek[]): string {
  if (days.length === 0) return ''
  if (days.length === 7) return 'Every day'

  const ordered = DAY_ORDER.filter(d => days.includes(d))
  // Detect contiguous range in DAY_ORDER
  const indices = ordered.map(d => DAY_ORDER.indexOf(d))
  const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1)
  if (isContiguous && ordered.length > 2) {
    return `${DAY_SHORT[ordered[0]]}–${DAY_SHORT[ordered[ordered.length - 1]]}`
  }
  return ordered.map(d => DAY_SHORT[d]).join(', ')
}

export function CurveCard({ group, onEdit, onDelete }: CurveCardProps) {
  const hasSetPoints = group.setPoints.length > 0
  const minTemp = hasSetPoints ? Math.min(...group.setPoints.map(p => p.temperature)) : 0
  const maxTemp = hasSetPoints ? Math.max(...group.setPoints.map(p => p.temperature)) : 0
  const label = formatDayRange(group.days)

  return (
    <div
      className={clsx(
        'rounded-2xl border p-3 sm:p-4',
        hasSetPoints
          ? 'border-zinc-800 bg-zinc-900'
          : group.allDisabled
            ? 'border-dashed border-amber-500/30 bg-zinc-900/50'
            : 'border-zinc-800/50 bg-zinc-900/50',
      )}
    >
      {/* Header row: label + actions */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-white">{label}</span>
        {group.allDisabled && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[9px] font-medium uppercase text-amber-500">
            Paused
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={onEdit}
            className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition-colors active:bg-zinc-800 active:text-sky-400"
            aria-label={`Edit ${label}`}
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={onDelete}
            className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-colors active:bg-zinc-800 active:text-red-400"
            aria-label={`Delete ${label}`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Sparkline */}
      {hasSetPoints && (
        <div className="mt-2">
          <MiniCurve setPoints={group.setPoints} />
        </div>
      )}

      {/* Footer: temp range + count */}
      <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
        {hasSetPoints
          ? (
              <>
                <span className="font-medium text-zinc-300">
                  {minTemp}
                  °–
                  {maxTemp}
                  °F
                </span>
                <span>·</span>
                <span>
                  {group.setPoints.length}
                  {' '}
                  set
                  {' '}
                  {group.setPoints.length === 1 ? 'point' : 'points'}
                </span>
              </>
            )
          : (
              <span>Schedule paused</span>
            )}
      </div>
    </div>
  )
}

// ── Sparkline with set-point dots ──────────────────────────────────

let miniCurveCounter = 0

interface MiniCurveProps {
  setPoints: Array<{ time: string, temperature: number }>
}

function MiniCurve({ setPoints }: MiniCurveProps) {
  const gradientId = useMemo(() => `curveCardGrad-${miniCurveCounter++}`, [])

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

  const renderDot = (props: { cx?: number, cy?: number, payload?: { temp: number } }) => {
    const { cx, cy, payload } = props
    if (cx == null || cy == null || !payload) return <g />
    return <circle cx={cx} cy={cy} r={2.5} fill={colorForTempF(payload.temp)} />
  }

  return (
    <ResponsiveContainer width="100%" height={40} minWidth={1} minHeight={1}>
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
          dot={renderDot}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

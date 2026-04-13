'use client'

import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { useWeekNavigator } from '@/src/hooks/useWeekNavigator'
import { Card, CardContent, CardHeader, CardTitle } from '@/src/ui/card'
import { WeekNavigator } from '@/src/components/WeekNavigator/WeekNavigator'
import { Activity } from 'lucide-react'
import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'

interface MovementRecord {
  id: number
  side: string
  totalMovement: number
  timestamp: Date
}

interface ChartDataPoint {
  time: string
  timestamp: number
  movement: number
  /** Secondary side movement (for dual-side comparison) */
  movementOther?: number
}

/**
 * Compute movement summary stats matching iOS MovementCardView.
 */
function computeStats(records: MovementRecord[], sleepDurationSeconds?: number) {
  const positionChanges = records.length
  const totalMovement = records.reduce((sum, r) => sum + r.totalMovement, 0)
  const restlessMinutes = Math.min(totalMovement, 60)

  let timeStillPercent = 0
  if (sleepDurationSeconds && sleepDurationSeconds > 0) {
    const restlessSeconds = restlessMinutes * 60
    timeStillPercent = Math.max(0, 100 - Math.round((restlessSeconds * 100) / sleepDurationSeconds))
  }

  let restlessnessLevel: 'Low' | 'Medium' | 'High' = 'Low'
  if (restlessMinutes >= 30) restlessnessLevel = 'High'
  else if (restlessMinutes >= 15) restlessnessLevel = 'Medium'

  return { positionChanges, restlessMinutes, timeStillPercent, restlessnessLevel }
}

/**
 * Format movement records into chart data points, sorted chronologically.
 */
function toChartData(records: MovementRecord[]): ChartDataPoint[] {
  return [...records]
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .map((record) => {
      const date = new Date(record.timestamp)
      return {
        time: date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
        timestamp: date.getTime(),
        movement: record.totalMovement,
      }
    })
}

/**
 * Merge primary and secondary records into a single chart dataset keyed by time bucket.
 * Aligns the two sides by rounding timestamps to 5-minute intervals.
 */
function mergeDualSideData(
  primary: MovementRecord[],
  secondary: MovementRecord[],
): ChartDataPoint[] {
  const bucket = (ts: Date) => {
    const d = new Date(ts)
    d.setSeconds(0, 0)
    d.setMinutes(Math.round(d.getMinutes() / 5) * 5)
    return d.getTime()
  }

  const map = new Map<number, ChartDataPoint>()

  for (const r of primary) {
    const key = bucket(new Date(r.timestamp))
    const existing = map.get(key)
    if (existing) {
      existing.movement += r.totalMovement
    }
    else {
      const date = new Date(key)
      map.set(key, {
        time: date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
        timestamp: key,
        movement: r.totalMovement,
        movementOther: 0,
      })
    }
  }

  for (const r of secondary) {
    const key = bucket(new Date(r.timestamp))
    const existing = map.get(key)
    if (existing) {
      existing.movementOther = (existing.movementOther ?? 0) + r.totalMovement
    }
    else {
      const date = new Date(key)
      map.set(key, {
        time: date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
        timestamp: key,
        movement: 0,
        movementOther: r.totalMovement,
      })
    }
  }

  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Custom tooltip for the movement bar chart.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MovementTooltip({ active, payload, dualSide }: { active?: boolean, payload?: any[], dualSide?: boolean }) {
  if (!active || !payload?.[0]) return null
  const data = payload[0].payload as ChartDataPoint
  return (
    <div className="rounded-lg bg-zinc-800 px-3 py-2 text-xs shadow-lg ring-1 ring-white/10">
      <p className="text-zinc-400">{data.time}</p>
      <p className="font-semibold text-amber-400">
        {dualSide ? 'Left: ' : 'Movement: '}
        {data.movement}
      </p>
      {dualSide && data.movementOther != null && (
        <p className="font-semibold text-teal-400">
          Right:
          {' '}
          {data.movementOther}
        </p>
      )}
    </div>
  )
}

interface MovementChartProps {
  /** When true, show both sides as grouped bars for comparison */
  dualSide?: boolean
  /** When true, hide the built-in WeekNavigator (used when embedded in another page) */
  hideNav?: boolean
}

/**
 * Movement/activity graph component displaying piezo-derived movement intensity over time.
 * Matches iOS MovementCardView with bar chart, summary stats, and week navigation.
 *
 * Supports dual-side comparison: grouped bars for left (amber) and right (teal).
 */
export function MovementChart({ dualSide = false, hideNav = false }: MovementChartProps) {
  const { side } = useSide()
  const otherSide: 'left' | 'right' = side === 'left' ? 'right' : 'left'
  const {
    weekStart,
    weekEnd,
    label,
    isCurrentWeek,
    goToPreviousWeek,
    goToNextWeek,
    goToCurrentWeek,
  } = useWeekNavigator()

  // Fetch movement data for the selected week and side
  const {
    data: movementData,
    isLoading: movementLoading,
    error: movementError,
  } = trpc.biometrics.getMovement.useQuery(
    {
      side,
      startDate: weekStart,
      endDate: weekEnd,
      limit: 1000,
    },
    {
      refetchOnWindowFocus: false,
    }
  )

  // Fetch movement for the OTHER side (only when dual-side)
  const {
    data: otherMovementData,
  } = trpc.biometrics.getMovement.useQuery(
    {
      side: otherSide,
      startDate: weekStart,
      endDate: weekEnd,
      limit: 1000,
    },
    {
      refetchOnWindowFocus: false,
      enabled: dualSide,
    }
  )

  // Fetch sleep records for the week to compute time-still percentage
  const { data: sleepData } = trpc.biometrics.getSleepRecords.useQuery(
    {
      side,
      startDate: weekStart,
      endDate: weekEnd,
      limit: 7,
    },
    {
      refetchOnWindowFocus: false,
    }
  )

  const records = useMemo(() => (movementData ?? []) as MovementRecord[], [movementData])
  const otherRecords = useMemo(() => (otherMovementData ?? []) as MovementRecord[], [otherMovementData])

  // Compute total sleep duration for the week
  const totalSleepSeconds = useMemo(() => {
    if (!sleepData || !Array.isArray(sleepData)) return undefined
    return sleepData.reduce(
      (sum: number, r: { sleepDurationSeconds?: number }) => sum + (r.sleepDurationSeconds ?? 0),
      0
    )
  }, [sleepData])

  const stats = useMemo(() => computeStats(records, totalSleepSeconds), [records, totalSleepSeconds])
  const otherStats = useMemo(() => dualSide ? computeStats(otherRecords) : null, [dualSide, otherRecords])
  const chartData = useMemo(
    () => dualSide && otherRecords.length > 0
      ? mergeDualSideData(records, otherRecords)
      : toChartData(records),
    [records, otherRecords, dualSide],
  )

  // Compute smart tick interval for X-axis (show ~5-6 labels max)
  const tickInterval = useMemo(() => {
    if (chartData.length <= 6) return 0
    return Math.floor(chartData.length / 5) - 1
  }, [chartData.length])

  const restlessnessColor
    = stats.restlessnessLevel === 'High'
      ? 'text-red-400'
      : stats.restlessnessLevel === 'Medium'
        ? 'text-amber-400'
        : 'text-emerald-400'

  return (
    <div className="space-y-3 sm:space-y-4">
      {!hideNav && (
        <WeekNavigator
          label={label}
          isCurrentWeek={isCurrentWeek}
          onPrevious={goToPreviousWeek}
          onNext={goToNextWeek}
          onToday={goToCurrentWeek}
        />
      )}

      <Card className="border-zinc-800 bg-zinc-900/50">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity size={14} className="text-amber-400" />
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Movement
              </CardTitle>
            </div>
            <span className="text-xs text-amber-400">
              Restless:
              {' '}
              {stats.restlessMinutes}
              {' '}
              min
            </span>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Summary stats row — matches iOS 3-stat layout */}
          <div className="grid grid-cols-3 divide-x divide-zinc-700">
            <StatItem
              value={String(stats.positionChanges)}
              label="Position Changes"
              secondaryValue={otherStats ? String(otherStats.positionChanges) : undefined}
            />
            <StatItem
              value={`${stats.timeStillPercent}%`}
              label="Time Still"
              secondaryValue={otherStats ? `${otherStats.timeStillPercent}%` : undefined}
            />
            <StatItem
              value={stats.restlessnessLevel}
              label="Restlessness"
              valueClassName={restlessnessColor}
              secondaryValue={otherStats ? otherStats.restlessnessLevel : undefined}
            />
          </div>

          {/* Dual-side legend */}
          {dualSide && (
            <div className="flex items-center justify-center gap-4 text-[10px]">
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-3 rounded-sm bg-amber-500" />
                <span className="text-zinc-400 capitalize">{side}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-3 rounded-sm bg-teal-400" />
                <span className="text-zinc-400 capitalize">{otherSide}</span>
              </div>
            </div>
          )}

          {/* Bar chart */}
          {movementLoading
            ? (
                <div className="flex h-[140px] items-center justify-center">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-amber-400" />
                </div>
              )
            : movementError
              ? (
                  <div className="flex h-[140px] items-center justify-center">
                    <p className="text-sm text-red-400">Failed to load movement data</p>
                  </div>
                )
              : chartData.length === 0
                ? (
                    <div className="flex h-[140px] items-center justify-center">
                      <p className="text-sm text-zinc-500">No movement data available</p>
                    </div>
                  )
                : (
                    <div className="h-[140px] w-full">
                      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                        <BarChart
                          data={chartData}
                          margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
                          barCategoryGap="15%"
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="rgba(255,255,255,0.06)"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="time"
                            tick={{ fontSize: 10, fill: '#71717a' }}
                            tickLine={false}
                            axisLine={false}
                            interval={tickInterval}
                          />
                          <YAxis
                            tick={{ fontSize: 10, fill: '#71717a' }}
                            tickLine={false}
                            axisLine={false}
                            width={36}
                          />
                          <Tooltip
                            content={<MovementTooltip dualSide={dualSide} />}
                            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                          />
                          <Bar
                            dataKey="movement"
                            fill="#f59e0b"
                            radius={[2, 2, 0, 0]}
                            maxBarSize={dualSide ? 8 : 12}
                          />
                          {dualSide && (
                            <Bar
                              dataKey="movementOther"
                              fill="#2dd4bf"
                              radius={[2, 2, 0, 0]}
                              maxBarSize={8}
                            />
                          )}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Individual stat display in the 3-column summary row.
 */
function StatItem({
  value,
  label,
  valueClassName = 'text-white',
  secondaryValue,
}: {
  value: string
  label: string
  valueClassName?: string
  secondaryValue?: string
}) {
  return (
    <div className="flex flex-col items-center gap-1 py-1">
      <div className="flex items-baseline gap-1">
        <span className={`text-base font-semibold sm:text-lg ${valueClassName}`}>{value}</span>
        {secondaryValue && (
          <span className="text-xs text-zinc-500">
            /
            {secondaryValue}
          </span>
        )}
      </div>
      <span className="text-[10px] text-zinc-500">{label}</span>
    </div>
  )
}

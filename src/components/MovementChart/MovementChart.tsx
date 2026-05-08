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
import { pickMovementBucketSeconds } from '@/src/lib/movement'

interface BucketRecord {
  side: 'left' | 'right'
  bucketStart: Date
  totalMovement: number
  sampleCount: number
}

interface SummaryRecord {
  positionChanges: number
  restlessMinutes: number
  sampleCount: number
}

interface ChartDataPoint {
  time: string
  timestamp: number
  movement: number
  movementOther?: number
}

/**
 * Derive display stats from a SQL summary row plus a sleep duration.
 *
 * Restlessness thresholds operate on minutes-per-night, not absolute
 * minutes, so the chip stays meaningful across day and week ranges.
 */
function deriveStats(
  summary: SummaryRecord | undefined,
  sleepDurationSeconds: number | undefined,
  nights: number,
) {
  const positionChanges = summary?.positionChanges ?? 0
  const restlessMinutes = summary?.restlessMinutes ?? 0

  let timeStillPercent = 0
  if (sleepDurationSeconds && sleepDurationSeconds > 0) {
    const restlessSeconds = restlessMinutes * 60
    timeStillPercent = Math.max(0, 100 - Math.round((restlessSeconds * 100) / sleepDurationSeconds))
  }

  const minutesPerNight = restlessMinutes / Math.max(1, nights)
  let restlessnessLevel: 'Low' | 'Medium' | 'High' = 'Low'
  if (minutesPerNight >= 30) restlessnessLevel = 'High'
  else if (minutesPerNight >= 15) restlessnessLevel = 'Medium'

  return { positionChanges, restlessMinutes, timeStillPercent, restlessnessLevel }
}

/**
 * Zip primary + (optional) secondary bucket series into a single chart
 * dataset keyed by bucket start timestamp.
 *
 * `bucketSeconds` controls the axis-label format: a multi-day view (>= 30
 * min buckets) prefixes weekday so 8:00 AM doesn't appear seven times.
 */
function toChartData(
  primary: BucketRecord[],
  bucketSeconds: number,
  secondary?: BucketRecord[],
): ChartDataPoint[] {
  const isMultiDay = bucketSeconds >= 30 * 60
  const formatTime = (ts: number) => {
    const d = new Date(ts)
    if (isMultiDay) {
      return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', hour12: true })
    }
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  }
  const map = new Map<number, ChartDataPoint>()

  for (const r of primary) {
    const ts = new Date(r.bucketStart).getTime()
    map.set(ts, {
      time: formatTime(ts),
      timestamp: ts,
      movement: r.totalMovement,
      movementOther: secondary ? 0 : undefined,
    })
  }

  if (secondary) {
    for (const r of secondary) {
      const ts = new Date(r.bucketStart).getTime()
      const existing = map.get(ts)
      if (existing) {
        existing.movementOther = r.totalMovement
      }
      else {
        map.set(ts, {
          time: formatTime(ts),
          timestamp: ts,
          movement: 0,
          movementOther: r.totalMovement,
        })
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp)
}

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
 *
 * Stats (Position Changes, Time Still, Restlessness) come from a SQL
 * aggregation so they're independent of the row-fetch cap. Bars come from
 * server-side bucketed sums so a week view fits in one query.
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

  const bucketSeconds = useMemo(
    () => pickMovementBucketSeconds(weekEnd.getTime() - weekStart.getTime()),
    [weekStart, weekEnd],
  )

  const bucketsQuery = trpc.biometrics.getMovementBuckets.useQuery(
    { side, startDate: weekStart, endDate: weekEnd, bucketSeconds },
    { refetchOnWindowFocus: false },
  )
  const otherBucketsQuery = trpc.biometrics.getMovementBuckets.useQuery(
    { side: otherSide, startDate: weekStart, endDate: weekEnd, bucketSeconds },
    { refetchOnWindowFocus: false, enabled: dualSide },
  )

  const summaryQuery = trpc.biometrics.getMovementSummary.useQuery(
    { side, startDate: weekStart, endDate: weekEnd },
    { refetchOnWindowFocus: false },
  )
  const otherSummaryQuery = trpc.biometrics.getMovementSummary.useQuery(
    { side: otherSide, startDate: weekStart, endDate: weekEnd },
    { refetchOnWindowFocus: false, enabled: dualSide },
  )

  const { data: sleepData } = trpc.biometrics.getSleepRecords.useQuery(
    { side, startDate: weekStart, endDate: weekEnd, limit: 7 },
    { refetchOnWindowFocus: false },
  )
  const { data: otherSleepData } = trpc.biometrics.getSleepRecords.useQuery(
    { side: otherSide, startDate: weekStart, endDate: weekEnd, limit: 7 },
    { refetchOnWindowFocus: false, enabled: dualSide },
  )

  const buckets = useMemo(() => (bucketsQuery.data ?? []) as BucketRecord[], [bucketsQuery.data])
  const otherBuckets = useMemo(
    () => (otherBucketsQuery.data ?? []) as BucketRecord[],
    [otherBucketsQuery.data],
  )

  const sumDurations = (records: { sleepDurationSeconds?: number }[] | undefined) =>
    records?.reduce((sum, r) => sum + (r.sleepDurationSeconds ?? 0), 0)

  const totalSleepSeconds = useMemo(
    () => Array.isArray(sleepData) ? sumDurations(sleepData) : undefined,
    [sleepData],
  )
  const otherTotalSleepSeconds = useMemo(
    () => Array.isArray(otherSleepData) ? sumDurations(otherSleepData) : undefined,
    [otherSleepData],
  )

  const nights = Math.max(sleepData?.length ?? 1, otherSleepData?.length ?? 1)

  const stats = useMemo(
    () => deriveStats(summaryQuery.data ?? undefined, totalSleepSeconds, nights),
    [summaryQuery.data, totalSleepSeconds, nights],
  )
  const otherStats = useMemo(
    () => dualSide
      ? deriveStats(otherSummaryQuery.data ?? undefined, otherTotalSleepSeconds, nights)
      : null,
    [dualSide, otherSummaryQuery.data, otherTotalSleepSeconds, nights],
  )

  const chartData = useMemo(
    () => toChartData(buckets, bucketSeconds, dualSide ? otherBuckets : undefined),
    [buckets, otherBuckets, bucketSeconds, dualSide],
  )

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

  const isLoading
    = bucketsQuery.isLoading
      || summaryQuery.isLoading
      || (dualSide && (otherBucketsQuery.isLoading || otherSummaryQuery.isLoading))
  const hasError = Boolean(
    bucketsQuery.error
    || summaryQuery.error
    || (dualSide && (otherBucketsQuery.error || otherSummaryQuery.error)),
  )

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
          {isLoading
            ? (
                <div className="flex h-[140px] items-center justify-center">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-amber-400" />
                </div>
              )
            : hasError
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
                          margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
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

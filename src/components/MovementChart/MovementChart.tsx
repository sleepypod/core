'use client'

import { trpc } from '@/src/utils/trpc'
import { useBiometricsSide } from '@/src/hooks/useBiometricsSide'
import { useWeekNavigator } from '@/src/hooks/useWeekNavigator'
import { Card, InlineError, SectionLabel } from '@/src/components/ds'
import { cn } from '@/lib/utils'
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
  eventCount: number
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
}

/**
 * Format the header "Restless: X" chip. Single-night ranges get raw
 * minutes; multi-night ranges average per night and switch to hours so
 * "Restless: 3.7h/night" reads naturally instead of "Restless: 1559 min".
 */
function formatRestlessChip(restlessMinutes: number, nights: number): string {
  if (nights <= 1) return `Restless: ${restlessMinutes} min`
  const minPerNight = restlessMinutes / nights
  if (minPerNight >= 60) return `Restless: ${(minPerNight / 60).toFixed(1)}h/night`
  return `Restless: ${Math.round(minPerNight)} min/night`
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
 * Bucket rows → chart points keyed by bucket start timestamp.
 *
 * `bucketSeconds` controls the axis-label format: a multi-day view (>= 30
 * min buckets) prefixes weekday so 8:00 AM doesn't appear seven times.
 */
function toChartData(buckets: BucketRecord[], bucketSeconds: number): ChartDataPoint[] {
  // Movement events / hour, normalised by bucket width so the y-axis
  // unit is constant across day (5-min) and week (30-min) views. Mirrors
  // Whoop "Disturbances/hr" and Garmin "Restless Moments" conventions.
  const eventsPerHour = (count: number) => Math.round(count / (bucketSeconds / 3600))
  return buckets
    .map((r) => {
      const ts = new Date(r.bucketStart).getTime()
      return { time: new Date(ts).toISOString(), timestamp: ts, movement: eventsPerHour(r.eventCount) }
    })
    .sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * For week view, return one tick key per calendar day (the first bucket
 * of that day) so the axis shows Mon/Tue/Wed/... cleanly. Day view
 * returns undefined and lets recharts auto-space ticks.
 */
function pickTickKeys(chartData: ChartDataPoint[], isMultiDay: boolean): string[] | undefined {
  if (!isMultiDay) return undefined
  const seen = new Set<string>()
  const keys: string[] = []
  for (const p of chartData) {
    const day = new Date(p.timestamp).toDateString()
    if (!seen.has(day)) {
      seen.add(day)
      keys.push(p.time)
    }
  }
  return keys
}

/**
 * X-axis label for a bucket — weekday in week view, hh:mm in day view.
 * Tooltip uses the same format so the user sees the same string they
 * see on the axis.
 */
function formatTickLabel(timeIso: string, isMultiDay: boolean): string {
  const d = new Date(timeIso)
  return isMultiDay
    ? d.toLocaleDateString('en-US', { weekday: 'short' })
    : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

interface MovementTooltipProps {
  active?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[]
  bucketSeconds: number
}

function MovementTooltip({ active, payload, bucketSeconds }: MovementTooltipProps) {
  if (!active || !payload?.[0]) return null
  const data = payload[0].payload as ChartDataPoint
  // Tooltip shows the full bucket timestamp regardless of whether the
  // axis hides labels for non-day-boundary buckets.
  const tooltipLabel = new Date(data.timestamp).toLocaleString('en-US', {
    weekday: bucketSeconds >= 30 * 60 ? 'short' : undefined,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  return (
    <div className="rounded-ctl border border-line-2 bg-surface px-3 py-2 text-xs">
      <p className="text-fg-2">{tooltipLabel}</p>
      <p className="font-mono text-fg">
        {`${data.movement} /hr`}
      </p>
    </div>
  )
}

const RESTLESS_TONE = { Low: 'text-ok', Medium: 'text-warn', High: 'text-danger' } as const
const AXIS_TICK = { fontSize: 10, fill: 'var(--text-3)', fontFamily: 'var(--font-mono)' }

/**
 * Movement/activity graph for the shared week, displaying piezo-derived
 * movement intensity over time.
 *
 * Stats (Position Changes, Time Still, Restlessness) come from a SQL
 * aggregation so they're independent of the row-fetch cap. Bars come from
 * server-side bucketed sums so a week view fits in one query.
 */
export function MovementChart() {
  const { side } = useBiometricsSide()
  const { weekStart, weekEnd } = useWeekNavigator()

  const bucketSeconds = useMemo(
    () => pickMovementBucketSeconds(weekEnd.getTime() - weekStart.getTime()),
    [weekStart, weekEnd],
  )

  const bucketsQuery = trpc.biometrics.getMovementBuckets.useQuery(
    { side, startDate: weekStart, endDate: weekEnd, bucketSeconds },
    { refetchOnWindowFocus: false },
  )
  const summaryQuery = trpc.biometrics.getMovementSummary.useQuery(
    { side, startDate: weekStart, endDate: weekEnd },
    { refetchOnWindowFocus: false },
  )
  const { data: sleepData } = trpc.biometrics.getSleepRecords.useQuery(
    { side, startDate: weekStart, endDate: weekEnd, limit: 7 },
    { refetchOnWindowFocus: false },
  )

  const buckets = useMemo(() => (bucketsQuery.data ?? []) as BucketRecord[], [bucketsQuery.data])

  const totalSleepSeconds = useMemo(
    () => Array.isArray(sleepData) ? sleepData.reduce((sum, r) => sum + (r.sleepDurationSeconds ?? 0), 0) : undefined,
    [sleepData],
  )

  const nights = Math.max(sleepData?.length ?? 1, 1)

  const stats = useMemo(
    () => deriveStats(summaryQuery.data ?? undefined, totalSleepSeconds, nights),
    [summaryQuery.data, totalSleepSeconds, nights],
  )

  const chartData = useMemo(() => toChartData(buckets, bucketSeconds), [buckets, bucketSeconds])

  const isMultiDay = bucketSeconds >= 30 * 60
  const tickKeys = useMemo(() => pickTickKeys(chartData, isMultiDay), [chartData, isMultiDay])
  const tickInterval = useMemo(() => {
    if (tickKeys || chartData.length <= 6) return 0
    return Math.floor(chartData.length / 5) - 1
  }, [chartData.length, tickKeys])

  const isLoading = bucketsQuery.isLoading || summaryQuery.isLoading
  const hasError = Boolean(bucketsQuery.error || summaryQuery.error)

  return (
    <Card>
      <SectionLabel right={<span className="font-mono">{formatRestlessChip(stats.restlessMinutes, nights)}</span>}>
        Movement
      </SectionLabel>

      <div className="grid grid-cols-3 gap-3">
        <StatItem value={String(stats.positionChanges)} label="Position changes" />
        <StatItem value={`${stats.timeStillPercent}%`} label="Time still" />
        <StatItem value={stats.restlessnessLevel} label="Restlessness" valueClassName={RESTLESS_TONE[stats.restlessnessLevel]} />
      </div>

      {isLoading
        ? <div className="h-[140px] animate-pulse rounded-ctl bg-active" />
        : hasError
          ? <InlineError>Failed to load movement data</InlineError>
          : chartData.length === 0
            ? (
                <div className="flex h-[140px] items-center justify-center text-[13px] text-fg-2">
                  No movement data this week
                </div>
              )
            : (
                <div className="h-[140px] w-full">
                  <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                    <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="15%">
                      <CartesianGrid stroke="var(--border-grid)" vertical={false} />
                      <XAxis
                        dataKey="time"
                        tick={AXIS_TICK}
                        tickLine={false}
                        axisLine={false}
                        interval={tickInterval}
                        ticks={tickKeys}
                        tickFormatter={(t: string) => formatTickLabel(t, isMultiDay)}
                        padding={{ left: 8, right: 8 }}
                      />
                      <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} unit="/hr" allowDecimals={false} />
                      <Tooltip
                        content={<MovementTooltip bucketSeconds={bucketSeconds} />}
                        cursor={{ fill: 'var(--surface-active)' }}
                      />
                      <Bar dataKey="movement" fill="var(--accent-warm)" radius={[2, 2, 0, 0]} maxBarSize={12} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
    </Card>
  )
}

function StatItem({ value, label, valueClassName }: { value: string, label: string, valueClassName?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-fg-2">{label}</div>
      <div className={cn('font-mono text-sm', valueClassName)}>{value}</div>
    </div>
  )
}

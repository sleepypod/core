'use client'

import { useSide } from '@/src/hooks/useSide'
import { useWeekNavigator } from '@/src/hooks/useWeekNavigator'
import { trpc } from '@/src/utils/trpc'
import {
  Activity,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Heart,
  Wind,
} from 'lucide-react'
import { useMemo } from 'react'
import { VitalsChart } from '../VitalsChart/VitalsChart'

// Zone definitions matching iOS HealthScreen.swift
const HR_ZONES = [
  { label: 'Resting', min: 40, max: 60, color: 'rgba(56, 189, 248, 0.08)' },
  { label: 'Normal', min: 60, max: 100, color: 'rgba(34, 197, 94, 0.05)' },
  { label: 'Elevated', min: 100, max: 140, color: 'rgba(245, 158, 11, 0.05)' },
]

const HRV_ZONES = [
  { label: 'Low', min: 0, max: 30, color: 'rgba(245, 158, 11, 0.08)' },
  { label: 'Normal', min: 30, max: 100, color: 'rgba(34, 197, 94, 0.05)' },
  { label: 'High', min: 100, max: 200, color: 'rgba(56, 189, 248, 0.05)' },
]

const BR_ZONES = [
  { label: 'Normal', min: 12, max: 20, color: 'rgba(34, 197, 94, 0.08)' },
]

interface VitalsRecord {
  id: number
  side: string
  timestamp: Date
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
}

/**
 * Filter physiologically impossible values matching iOS smoothedVitals logic.
 */
function filterOutliers(records: VitalsRecord[]): VitalsRecord[] {
  return records.filter((r) => {
    if (r.heartRate != null && (r.heartRate < 45 || r.heartRate > 130)) return false
    if (r.hrv != null && r.hrv > 300) return false
    if (r.breathingRate != null && (r.breathingRate < 8 || r.breathingRate > 25)) return false
    return true
  })
}

function computeTrend(records: VitalsRecord[]): { text: string, direction: 'up' | 'down' | 'stable' } | null {
  const values = records.map(r => r.hrv).filter((v): v is number => v != null)
  if (values.length < 10) return null

  const mid = Math.floor(values.length / 2)
  const recent = values.slice(mid)
  const older = values.slice(0, mid)
  if (recent.length === 0 || older.length === 0) return null

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length
  if (olderAvg === 0) return null

  const delta = ((recentAvg - olderAvg) / olderAvg) * 100

  if (delta > 10) return { text: `HRV improving +${Math.round(delta)}%`, direction: 'up' }
  if (delta < -10) return { text: `HRV declining ${Math.round(delta)}%`, direction: 'down' }
  return { text: 'HRV stable', direction: 'stable' }
}

function avg(values: number[]): string {
  if (values.length === 0) return '--'
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length).toString()
}

/**
 * Apply a centered moving average to a numeric field on an array of objects.
 * Window size of 5 smooths noise while preserving trends.
 */
function smoothData<T extends Record<string, unknown>>(
  data: T[],
  key: keyof T,
  windowSize = 5,
): T[] {
  return data.map((point, i) => {
    const start = Math.max(0, i - Math.floor(windowSize / 2))
    const end = Math.min(data.length, i + Math.ceil(windowSize / 2))
    const windowSlice = data.slice(start, end)
    const nums = windowSlice.map(w => w[key]).filter((v): v is T[keyof T] & number => typeof v === 'number')
    if (nums.length === 0) return point
    const smoothedAvg = nums.reduce((sum: number, v) => sum + v, 0) / nums.length
    return { ...point, [key]: smoothedAvg }
  })
}

// Side colors for dual-side comparison
const SIDE_COLORS = {
  left: { primary: '#5cb8e0', label: 'Left' }, // cool blue
  right: { primary: '#40e0d0', label: 'Right' }, // turquoise
} as const

interface VitalsPanelProps {
  /** When true, fetch and overlay both sides on each chart */
  dualSide?: boolean
  /** When true, hide the built-in week navigator + side toggle */
  hideNav?: boolean
  /** When true, hide the summary card (BPM/HRV/BR block) */
  hideSummary?: boolean
}

/**
 * Pod-derived vitals panel displaying heart rate, HRV, and breathing rate charts.
 * Wired to biometrics.getVitals and biometrics.getVitalsSummary tRPC endpoints.
 * Week-based time range selection matching iOS WeekNavigatorView.
 *
 * Supports dual-side comparison mode: overlays left and right side data on each chart.
 */
export function VitalsPanel({ dualSide = false, hideNav = false, hideSummary = false }: VitalsPanelProps) {
  const { side, toggleSide } = useSide()
  const week = useWeekNavigator()

  // Determine which side to use as the primary line
  const primarySide = side
  const otherSide: 'left' | 'right' = side === 'left' ? 'right' : 'left'

  // Fetch vitals for the selected week and side (primary)
  const vitalsQuery = trpc.biometrics.getVitals.useQuery({
    side: primarySide,
    startDate: week.weekStart,
    endDate: week.weekEnd,
    limit: 1000,
  })

  // Fetch summary stats (primary)
  const summaryQuery = trpc.biometrics.getVitalsSummary.useQuery({
    side: primarySide,
    startDate: week.weekStart,
    endDate: week.weekEnd,
  })

  // Fetch vitals for the OTHER side (only when dual-side is active)
  const otherVitalsQuery = trpc.biometrics.getVitals.useQuery(
    {
      side: otherSide,
      startDate: week.weekStart,
      endDate: week.weekEnd,
      limit: 1000,
    },
    { enabled: dualSide },
  )

  // Fetch summary for the other side (only when dual-side)
  const otherSummaryQuery = trpc.biometrics.getVitalsSummary.useQuery(
    {
      side: otherSide,
      startDate: week.weekStart,
      endDate: week.weekEnd,
    },
    { enabled: dualSide },
  )

  const rawRecords: VitalsRecord[] = vitalsQuery.data ?? []
  const smoothed = useMemo(() => filterOutliers(rawRecords), [rawRecords])
  const sortedRecords = useMemo(
    () => [...smoothed].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
    [smoothed],
  )

  // Other side records
  const otherRawRecords: VitalsRecord[] = otherVitalsQuery.data ?? []
  const otherSmoothed = useMemo(() => filterOutliers(otherRawRecords), [otherRawRecords])
  const otherSortedRecords = useMemo(
    () => [...otherSmoothed].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
    [otherSmoothed],
  )

  const summary = summaryQuery.data
  const otherSummary = otherSummaryQuery.data

  // Extract chart data — primary (smoothed with window=5 moving average)
  const hrData = useMemo(() =>
    smoothData(
      sortedRecords
        .filter(r => r.heartRate != null)
        .map(r => ({ timestamp: new Date(r.timestamp), value: r.heartRate! })),
      'value',
    ),
  [sortedRecords])

  const hrvData = useMemo(() =>
    smoothData(
      sortedRecords
        .filter(r => r.hrv != null)
        .map(r => ({ timestamp: new Date(r.timestamp), value: r.hrv! })),
      'value',
    ),
  [sortedRecords])

  const brData = useMemo(() =>
    smoothData(
      sortedRecords
        .filter(r => r.breathingRate != null)
        .map(r => ({ timestamp: new Date(r.timestamp), value: r.breathingRate! })),
      'value',
    ),
  [sortedRecords])

  // Extract chart data — other side (for dual-side overlay, also smoothed)
  const otherHrData = useMemo(() =>
    smoothData(
      otherSortedRecords
        .filter(r => r.heartRate != null)
        .map(r => ({ timestamp: new Date(r.timestamp), value: r.heartRate! })),
      'value',
    ),
  [otherSortedRecords])

  const otherHrvData = useMemo(() =>
    smoothData(
      otherSortedRecords
        .filter(r => r.hrv != null)
        .map(r => ({ timestamp: new Date(r.timestamp), value: r.hrv! })),
      'value',
    ),
  [otherSortedRecords])

  const otherBrData = useMemo(() =>
    smoothData(
      otherSortedRecords
        .filter(r => r.breathingRate != null)
        .map(r => ({ timestamp: new Date(r.timestamp), value: r.breathingRate! })),
      'value',
    ),
  [otherSortedRecords])

  // Summary values from smoothed data
  const hrValues = sortedRecords.map(r => r.heartRate).filter((v): v is number => v != null)
  const hrvValues = sortedRecords.map(r => r.hrv).filter((v): v is number => v != null)
  const brValues = sortedRecords.map(r => r.breathingRate).filter((v): v is number => v != null)

  const otherHrValues = otherSortedRecords.map(r => r.heartRate).filter((v): v is number => v != null)
  const otherHrvValues = otherSortedRecords.map(r => r.hrv).filter((v): v is number => v != null)
  const otherBrValues = otherSortedRecords.map(r => r.breathingRate).filter((v): v is number => v != null)

  const trend = useMemo(() => computeTrend(sortedRecords), [sortedRecords])

  const isLoading = vitalsQuery.isLoading && rawRecords.length === 0

  return (
    <div className="space-y-3">
      {/* Week Navigator + Side Toggle */}
      {!hideNav && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              onClick={week.goToPreviousWeek}
              className="p-2 text-zinc-500 active:text-white transition-colors"
              aria-label="Previous week"
            >
              <ChevronLeft size={18} />
            </button>

            <button
              onClick={week.goToCurrentWeek}
              className="flex items-center gap-2 rounded-xl bg-zinc-900 px-3 py-2"
            >
              <Calendar size={13} className="text-sky-400" />
              <span className="text-sm font-medium text-white">{week.label}</span>
            </button>

            <button
              onClick={week.goToNextWeek}
              disabled={week.isCurrentWeek}
              className="p-2 text-zinc-500 active:text-white transition-colors disabled:opacity-30"
              aria-label="Next week"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          {/* Side toggle pill matching iOS sideTogglePill */}
          <button
            onClick={toggleSide}
            className="flex items-center gap-1.5 rounded-full bg-sky-400/10 px-3 py-1.5"
          >
            <span className="text-xs font-semibold text-sky-400 capitalize">
              {side}
            </span>
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-sky-400/50 text-[9px] font-bold text-white">
              {side === 'left' ? 'L' : 'R'}
            </span>
          </button>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="text-zinc-500 text-sm">Loading health data...</div>
        </div>
      )}

      {!isLoading && (
        <>
          {/* Vitals Summary Card — hidden when parent provides its own */}
          {!hideSummary && (
            <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
              {/* Dual-side comparison header */}
              {dualSide && (
                <div className="mb-3 flex items-center justify-center gap-4 text-[10px]">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-4 rounded-sm" style={{ backgroundColor: SIDE_COLORS[primarySide].primary }} />
                    <span className="text-zinc-400">
                      {SIDE_COLORS[primarySide].label}
                      {' '}
                      (solid)
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-4 rounded-sm border border-dashed" style={{ borderColor: SIDE_COLORS[otherSide].primary }} />
                    <span className="text-zinc-400">
                      {SIDE_COLORS[otherSide].label}
                      {' '}
                      (dashed)
                    </span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-around">
                <SummaryItem
                  icon={<Heart size={14} className="text-red-400" />}
                  value={avg(hrValues)}
                  unit="BPM"
                  secondaryValue={dualSide ? avg(otherHrValues) : undefined}
                />
                <SummaryItem
                  icon={<Activity size={14} className="text-sky-400" />}
                  value={avg(hrvValues)}
                  unit="ms"
                  secondaryValue={dualSide ? avg(otherHrvValues) : undefined}
                />
                <SummaryItem
                  icon={<Wind size={14} className="text-green-400" />}
                  value={avg(brValues)}
                  unit="BR"
                  secondaryValue={dualSide ? avg(otherBrValues) : undefined}
                />
              </div>

              {trend && (
                <div className="mt-2.5 flex items-center justify-center gap-1.5">
                  {trend.direction === 'up' && (
                    <span className="text-green-400 text-[10px]">&#x2197;</span>
                  )}
                  {trend.direction === 'down' && (
                    <span className="text-amber-400 text-[10px]">&#x2198;</span>
                  )}
                  {trend.direction === 'stable' && (
                    <span className="text-zinc-500 text-[10px]">=</span>
                  )}
                  <span
                    className={`text-[11px] ${
                      trend.direction === 'up'
                        ? 'text-green-400'
                        : trend.direction === 'down'
                          ? 'text-amber-400'
                          : 'text-zinc-500'
                    }`}
                  >
                    {trend.text}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Heart Rate Chart Card */}
          <VitalsChartCard
            title="Heart Rate"
            icon={<Heart size={12} className="text-red-400" />}
            color="#f87171"
            gradientId="hr-gradient"
            unit="BPM"
            data={hrData}
            zones={HR_ZONES}
            average={summary?.avgHeartRate ?? null}
            values={hrValues}
            label={dualSide ? SIDE_COLORS[primarySide].label : undefined}
            secondary={dualSide
              ? {
                  data: otherHrData,
                  color: SIDE_COLORS[otherSide].primary,
                  gradientId: 'hr-gradient-other',
                  label: SIDE_COLORS[otherSide].label,
                  average: otherSummary?.avgHeartRate ?? null,
                  values: otherHrValues,
                }
              : undefined}
          />

          {/* HRV Chart Card */}
          <VitalsChartCard
            title="Heart Rate Variability"
            icon={<Activity size={12} className="text-sky-400" />}
            color="#38bdf8"
            gradientId="hrv-gradient"
            unit="ms"
            data={hrvData}
            zones={HRV_ZONES}
            average={summary?.avgHRV ?? null}
            values={hrvValues}
            label={dualSide ? SIDE_COLORS[primarySide].label : undefined}
            secondary={dualSide
              ? {
                  data: otherHrvData,
                  color: SIDE_COLORS[otherSide].primary,
                  gradientId: 'hrv-gradient-other',
                  label: SIDE_COLORS[otherSide].label,
                  average: otherSummary?.avgHRV ?? null,
                  values: otherHrvValues,
                }
              : undefined}
          />

          {/* Breathing Rate Chart Card */}
          <VitalsChartCard
            title="Breathing Rate"
            icon={<Wind size={12} className="text-green-400" />}
            color="#22c55e"
            gradientId="br-gradient"
            unit="BPM"
            data={brData}
            zones={BR_ZONES}
            average={summary?.avgBreathingRate ?? null}
            values={brValues}
            label={dualSide ? SIDE_COLORS[primarySide].label : undefined}
            secondary={dualSide
              ? {
                  data: otherBrData,
                  color: SIDE_COLORS[otherSide].primary,
                  gradientId: 'br-gradient-other',
                  label: SIDE_COLORS[otherSide].label,
                  average: otherSummary?.avgBreathingRate ?? null,
                  values: otherBrValues,
                }
              : undefined}
          />
        </>
      )}

      {/* Error state */}
      {vitalsQuery.isError && (
        <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4 text-center">
          <p className="text-red-400 text-[13px] sm:text-sm">Failed to load vitals data</p>
          <button
            onClick={() => vitalsQuery.refetch()}
            className="mt-2 text-sky-400 text-xs font-medium"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ──

function SummaryItem({
  icon,
  value,
  unit,
  secondaryValue,
}: {
  icon: React.ReactNode
  value: string
  unit: string
  secondaryValue?: string
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      {icon}
      <div className="flex items-baseline gap-1">
        <span className="text-lg font-semibold tabular-nums text-white sm:text-xl">{value}</span>
        {secondaryValue && secondaryValue !== '--' && (
          <span className="text-xs tabular-nums text-zinc-500">
            /
            {secondaryValue}
          </span>
        )}
      </div>
      <span className="text-[10px] text-zinc-500">{unit}</span>
    </div>
  )
}

interface SecondarySeriesData {
  data: { timestamp: Date, value: number }[]
  color: string
  gradientId: string
  label: string
  average: number | null
  values: number[]
}

function VitalsChartCard({
  title,
  icon,
  color,
  gradientId,
  unit,
  data,
  zones,
  average,
  values,
  label,
  secondary,
}: {
  title: string
  icon: React.ReactNode
  color: string
  gradientId: string
  unit: string
  data: { timestamp: Date, value: number }[]
  zones: { label: string, min: number, max: number, color: string }[]
  average: number | null
  values: number[]
  /** Side label shown in dual-side mode (e.g. "Left") */
  label?: string
  /** Secondary series data for dual-side overlay */
  secondary?: SecondarySeriesData
}) {
  const minVal = values.length > 0 ? Math.round(Math.min(...values)) : null
  const maxVal = values.length > 0 ? Math.round(Math.max(...values)) : null
  const avgVal = average != null ? Math.round(average) : (values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null)

  const secMinVal = secondary && secondary.values.length > 0 ? Math.round(Math.min(...secondary.values)) : null
  const secMaxVal = secondary && secondary.values.length > 0 ? Math.round(Math.max(...secondary.values)) : null
  const secAvgVal = secondary?.average != null
    ? Math.round(secondary.average)
    : (secondary && secondary.values.length > 0
        ? Math.round(secondary.values.reduce((a, b) => a + b, 0) / secondary.values.length)
        : null)

  return (
    <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-2 sm:mb-3">
        <div className="flex items-center gap-1.5">
          {icon}
          <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {data.length > 0 && (
            <span className="text-xs font-medium" style={{ color }}>
              {label && <span className="text-zinc-500 mr-1">{label}</span>}
              {Math.round(data[data.length - 1]?.value ?? 0)}
              {' '}
              {unit}
            </span>
          )}
          {secondary && secondary.data.length > 0 && (
            <span className="text-xs font-medium" style={{ color: secondary.color }}>
              <span className="text-zinc-500 mr-1">{secondary.label}</span>
              {Math.round(secondary.data[secondary.data.length - 1]?.value ?? 0)}
              {' '}
              {unit}
            </span>
          )}
        </div>
      </div>

      {/* Chart — dual-line overlay when secondary data is provided */}
      <VitalsChart
        data={data}
        color={color}
        gradientId={gradientId}
        zones={zones}
        average={average}
        unit={unit}
        height={180}
        label={label}
        secondary={secondary && secondary.data.length > 0
          ? {
              data: secondary.data,
              color: secondary.color,
              gradientId: secondary.gradientId,
              label: secondary.label,
              average: secondary.average,
            }
          : undefined}
      />

      {/* Legend: min / avg / max + zone labels */}
      {data.length > 0 && (
        <div className="flex flex-wrap items-center mt-2 gap-x-4 gap-y-1">
          {label && (
            <span className="text-[9px] font-semibold text-zinc-500">
              {label}
              :
            </span>
          )}
          <LegendValue label="Min" value={minVal} className="text-zinc-500" />
          <LegendValue label="Avg" value={avgVal} color={color} />
          <LegendValue label="Max" value={maxVal} className="text-zinc-500" />

          {/* Secondary legend */}
          {secondary && secondary.values.length > 0 && (
            <>
              <span className="text-[9px] font-semibold text-zinc-500">
                {secondary.label}
                :
              </span>
              <LegendValue label="Min" value={secMinVal} className="text-zinc-500" />
              <LegendValue label="Avg" value={secAvgVal} color={secondary.color} />
              <LegendValue label="Max" value={secMaxVal} className="text-zinc-500" />
            </>
          )}

          <div className="flex-1" />

          {/* Zone labels */}
          <div className="flex items-center gap-2">
            {zones.map(zone => (
              <div key={zone.label} className="flex items-center gap-1">
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{ backgroundColor: zone.color.replace(/[\d.]+\)$/, '0.6)') }}
                />
                <span className="text-[9px] text-zinc-500">{zone.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function LegendValue({
  label,
  value,
  color,
  className = '',
}: {
  label: string
  value: number | null
  color?: string
  className?: string
}) {
  return (
    <div className="flex flex-col items-center">
      <span
        className={`text-[11px] font-medium tabular-nums ${className}`}
        style={color ? { color } : undefined}
      >
        {value ?? '--'}
      </span>
      <span className="text-[8px] text-zinc-600">{label}</span>
    </div>
  )
}

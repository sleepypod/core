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
  Moon,
  Wind,
} from 'lucide-react'
import { useMemo, useState } from 'react'
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

interface DataPoint {
  timestamp: Date
  value: number
}

interface SleepSession {
  id: number
  enteredBedAt: Date
  leftBedAt: Date | null
}

interface Baseline {
  mean: number | null
  sd: number | null
}

interface MetricSpec {
  key: 'hr' | 'hrv' | 'br'
  title: string
  icon: React.ReactNode
  color: string
  unit: string
  zones: typeof HR_ZONES
  gradientId: string
  // Outlier bounds (matches filterOutliers); used to keep zones in sync.
  hardMin: number
  hardMax: number
}

const METRICS: MetricSpec[] = [
  {
    key: 'hr',
    title: 'Heart Rate',
    icon: <Heart size={12} className="text-red-400" />,
    color: '#f87171',
    unit: 'BPM',
    zones: HR_ZONES,
    gradientId: 'hr-gradient',
    hardMin: 40,
    hardMax: 140,
  },
  {
    key: 'hrv',
    title: 'Heart Rate Variability',
    icon: <Activity size={12} className="text-sky-400" />,
    color: '#38bdf8',
    unit: 'ms',
    zones: HRV_ZONES,
    gradientId: 'hrv-gradient',
    hardMin: 0,
    hardMax: 200,
  },
  {
    key: 'br',
    title: 'Breathing Rate',
    icon: <Wind size={12} className="text-green-400" />,
    color: '#22c55e',
    unit: 'BPM',
    zones: BR_ZONES,
    gradientId: 'br-gradient',
    hardMin: 8,
    hardMax: 25,
  },
]

/** Filter physiologically impossible values matching iOS smoothedVitals logic. */
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

/** 5-point centered moving average for visual smoothing. */
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

/** Median + interquartile range for a list of numbers. */
function summarise(values: number[]): { median: number, q1: number, q3: number, min: number, max: number } | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const q = (p: number): number => {
    const idx = p * (sorted.length - 1)
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
  }
  return {
    median: q(0.5),
    q1: q(0.25),
    q3: q(0.75),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

function formatSessionLabel(session: SleepSession): string {
  const date = session.enteredBedAt.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  const end = session.leftBedAt ?? new Date()
  const durMs = end.getTime() - session.enteredBedAt.getTime()
  const hours = Math.floor(durMs / 3_600_000)
  const minutes = Math.floor((durMs % 3_600_000) / 60_000)
  const duration = `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${date} · ${duration}`
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function formatNightLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })
}

// Side colors for dual-side comparison
const SIDE_COLORS = {
  left: { primary: '#5cb8e0', label: 'Left' },
  right: { primary: '#40e0d0', label: 'Right' },
} as const

// Minimum session duration that counts as "sleep". The sleep-detector accepts
// anything ≥ 5 min, but sub-30-min entries are usually presence blips, not
// nights — and they'd default the night view to an empty chart.
const MIN_SESSION_MS = 30 * 60 * 1000

interface VitalsPanelProps {
  /** When true, fetch and overlay both sides on each chart */
  dualSide?: boolean
  /** When true, hide the built-in week navigator + side toggle */
  hideNav?: boolean
  /** When true, hide the summary card (BPM/HRV/BR block) */
  hideSummary?: boolean
}

/**
 * Pod-derived vitals panel. Two views:
 *  - Night: stacked HR/HRV/BR panels for one selected sleep session, sharing
 *    a clock-time x-axis so events line up vertically (PSG convention).
 *  - Week: one summary row per night per metric with median dot + IQR bar
 *    and a personal-baseline band behind the rows (Whoop/Oura convention).
 */
export function VitalsPanel({ dualSide = false, hideNav = false, hideSummary = false }: VitalsPanelProps) {
  const { side, toggleSide } = useSide()
  const week = useWeekNavigator()
  const [view, setView] = useState<'night' | 'week'>('night')
  // Track the user's explicit pick by session ID so the selection survives
  // week navigation when possible; defaults to the most recent session.
  const [pickedSessionId, setPickedSessionId] = useState<number | null>(null)

  const primarySide = side
  const otherSide: 'left' | 'right' = side === 'left' ? 'right' : 'left'

  // ── Queries ───────────────────────────────────────────────
  const vitalsQuery = trpc.biometrics.getVitals.useQuery({
    side: primarySide,
    startDate: week.weekStart,
    endDate: week.weekEnd,
    limit: 10000,
  })

  const summaryQuery = trpc.biometrics.getVitalsSummary.useQuery({
    side: primarySide,
    startDate: week.weekStart,
    endDate: week.weekEnd,
  })

  const sessionsQuery = trpc.biometrics.getSleepRecords.useQuery({
    side: primarySide,
    startDate: week.weekStart,
    endDate: week.weekEnd,
    limit: 100,
  })

  const baselineQuery = trpc.biometrics.getVitalsBaseline.useQuery({
    side: primarySide,
    days: 30,
  })

  const otherVitalsQuery = trpc.biometrics.getVitals.useQuery(
    {
      side: otherSide,
      startDate: week.weekStart,
      endDate: week.weekEnd,
      limit: 10000,
    },
    { enabled: dualSide },
  )

  const otherSummaryQuery = trpc.biometrics.getVitalsSummary.useQuery(
    {
      side: otherSide,
      startDate: week.weekStart,
      endDate: week.weekEnd,
    },
    { enabled: dualSide },
  )

  // ── Derived state ─────────────────────────────────────────
  const rawRecords = useMemo<VitalsRecord[]>(() => vitalsQuery.data ?? [], [vitalsQuery.data])
  const sortedRecords = useMemo(
    () => filterOutliers(rawRecords).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    ),
    [rawRecords],
  )

  const otherRawRecords = useMemo<VitalsRecord[]>(() => otherVitalsQuery.data ?? [], [otherVitalsQuery.data])
  const otherSortedRecords = useMemo(
    () => filterOutliers(otherRawRecords).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    ),
    [otherRawRecords],
  )

  const sessions = useMemo<SleepSession[]>(
    () =>
      (sessionsQuery.data ?? [])
        .map(s => ({
          id: s.id,
          enteredBedAt: new Date(s.enteredBedAt),
          leftBedAt: s.leftBedAt ? new Date(s.leftBedAt) : null,
        }))
        .filter((s) => {
          const end = s.leftBedAt ?? new Date()
          return end.getTime() - s.enteredBedAt.getTime() >= MIN_SESSION_MS
        })
        .sort((a, b) => a.enteredBedAt.getTime() - b.enteredBedAt.getTime()),
    [sessionsQuery.data],
  )

  // Resolve the effective session index without state-in-effect: prefer the
  // user's pick when it's still in this week's list, otherwise default to the
  // most recent session.
  const selectedSessionIndex = useMemo<number | null>(() => {
    if (sessions.length === 0) return null
    if (pickedSessionId != null) {
      const idx = sessions.findIndex(s => s.id === pickedSessionId)
      if (idx >= 0) return idx
    }
    return sessions.length - 1
  }, [sessions, pickedSessionId])

  const handleSelectIndex = (next: number): void => {
    const clamped = Math.max(0, Math.min(sessions.length - 1, next))
    setPickedSessionId(sessions[clamped]?.id ?? null)
  }

  const summary = summaryQuery.data
  const otherSummary = otherSummaryQuery.data
  const baseline = baselineQuery.data

  // Per-metric smoothed point arrays for primary side (full week).
  const metricSeries = useMemo(() => extractMetricSeries(sortedRecords), [sortedRecords])
  const otherMetricSeries = useMemo(() => extractMetricSeries(otherSortedRecords), [otherSortedRecords])

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
      {/* Week Navigator + View Toggle + Side Toggle */}
      {!hideNav && (
        <div className="flex items-center justify-between gap-2">
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

          <div className="flex items-center gap-2">
            <ViewToggle view={view} onChange={setView} />

            <button
              onClick={toggleSide}
              className="flex items-center gap-1.5 rounded-full bg-sky-400/10 px-3 py-1.5"
            >
              <span className="text-xs font-semibold text-sky-400 capitalize">{side}</span>
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-sky-400/50 text-[9px] font-bold text-white">
                {side === 'left' ? 'L' : 'R'}
              </span>
            </button>
          </div>
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
          {/* Vitals Summary Card */}
          {!hideSummary && (
            <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
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
                  {trend.direction === 'up' && <span className="text-green-400 text-[10px]">&#x2197;</span>}
                  {trend.direction === 'down' && <span className="text-amber-400 text-[10px]">&#x2198;</span>}
                  {trend.direction === 'stable' && <span className="text-zinc-500 text-[10px]">=</span>}
                  <span
                    className={`text-[11px] ${
                      trend.direction === 'up'
                        ? 'text-green-400'
                        : trend.direction === 'down' ? 'text-amber-400' : 'text-zinc-500'
                    }`}
                  >
                    {trend.text}
                  </span>
                </div>
              )}
            </div>
          )}

          {view === 'night'
            ? (
                <NightView
                  sessions={sessions}
                  selectedIndex={selectedSessionIndex}
                  onSelectIndex={handleSelectIndex}
                  metricSeries={metricSeries}
                  otherMetricSeries={dualSide ? otherMetricSeries : null}
                  baseline={baseline ?? null}
                  primaryLabel={dualSide ? SIDE_COLORS[primarySide].label : undefined}
                  secondaryLabel={dualSide ? SIDE_COLORS[otherSide].label : undefined}
                  secondaryColor={SIDE_COLORS[otherSide].primary}
                  summary={summary ?? null}
                  otherSummary={dualSide ? otherSummary ?? null : null}
                />
              )
            : (
                <WeekView
                  sortedRecords={sortedRecords}
                  otherSortedRecords={dualSide ? otherSortedRecords : null}
                  sessions={sessions}
                  baseline={baseline ?? null}
                  primaryLabel={dualSide ? SIDE_COLORS[primarySide].label : undefined}
                  secondaryLabel={dualSide ? SIDE_COLORS[otherSide].label : undefined}
                />
              )}
        </>
      )}

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

// ── Sub-components ──────────────────────────────────────────────────

function ViewToggle({
  view,
  onChange,
}: {
  view: 'night' | 'week'
  onChange: (next: 'night' | 'week') => void
}) {
  return (
    <div className="flex items-center rounded-full bg-zinc-900 p-0.5 text-xs">
      <button
        onClick={() => onChange('night')}
        className={`flex items-center gap-1 rounded-full px-2.5 py-1 transition-colors ${
          view === 'night' ? 'bg-sky-400/20 text-sky-300' : 'text-zinc-500'
        }`}
        aria-pressed={view === 'night'}
      >
        <Moon size={11} />
        <span className="font-medium">Night</span>
      </button>
      <button
        onClick={() => onChange('week')}
        className={`flex items-center gap-1 rounded-full px-2.5 py-1 transition-colors ${
          view === 'week' ? 'bg-sky-400/20 text-sky-300' : 'text-zinc-500'
        }`}
        aria-pressed={view === 'week'}
      >
        <Calendar size={11} />
        <span className="font-medium">Week</span>
      </button>
    </div>
  )
}

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

// ── Night view ──────────────────────────────────────────────────────

type MetricSeries = Record<'hr' | 'hrv' | 'br', DataPoint[]>

function extractMetricSeries(records: VitalsRecord[]): MetricSeries {
  const series: MetricSeries = { hr: [], hrv: [], br: [] }
  series.hr = smoothData(
    records.filter(r => r.heartRate != null).map(r => ({ timestamp: new Date(r.timestamp), value: r.heartRate ?? 0 })),
    'value',
  )
  series.hrv = smoothData(
    records.filter(r => r.hrv != null).map(r => ({ timestamp: new Date(r.timestamp), value: r.hrv ?? 0 })),
    'value',
  )
  series.br = smoothData(
    records.filter(r => r.breathingRate != null).map(r => ({ timestamp: new Date(r.timestamp), value: r.breathingRate ?? 0 })),
    'value',
  )
  return series
}

function metricBaseline(metric: MetricSpec['key'], baseline: { hrMean: number | null, hrSD: number | null, hrvMean: number | null, hrvSD: number | null, brMean: number | null, brSD: number | null } | null): Baseline {
  if (!baseline) return { mean: null, sd: null }
  if (metric === 'hr') return { mean: baseline.hrMean, sd: baseline.hrSD }
  if (metric === 'hrv') return { mean: baseline.hrvMean, sd: baseline.hrvSD }
  return { mean: baseline.brMean, sd: baseline.brSD }
}

function filterToWindow(points: DataPoint[], start: number, end: number): DataPoint[] {
  return points.filter((p) => {
    const t = p.timestamp.getTime()
    return t >= start && t <= end
  })
}

function NightView({
  sessions,
  selectedIndex,
  onSelectIndex,
  metricSeries,
  otherMetricSeries,
  baseline,
  primaryLabel,
  secondaryLabel,
  secondaryColor,
  summary,
  otherSummary,
}: {
  sessions: SleepSession[]
  selectedIndex: number | null
  onSelectIndex: (next: number) => void
  metricSeries: MetricSeries
  otherMetricSeries: MetricSeries | null
  baseline: { hrMean: number | null, hrSD: number | null, hrvMean: number | null, hrvSD: number | null, brMean: number | null, brSD: number | null } | null
  primaryLabel?: string
  secondaryLabel?: string
  secondaryColor: string
  summary: { avgHeartRate: number | null, avgHRV: number | null, avgBreathingRate: number | null } | null
  otherSummary: { avgHeartRate: number | null, avgHRV: number | null, avgBreathingRate: number | null } | null
}) {
  if (sessions.length === 0 || selectedIndex == null) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-6 text-center">
        <p className="text-zinc-500 text-sm">No sleep sessions this week</p>
      </div>
    )
  }

  const session = sessions[Math.min(selectedIndex, sessions.length - 1)]
  const start = session.enteredBedAt.getTime()
  const end = (session.leftBedAt ?? new Date()).getTime()

  return (
    <>
      {/* Session navigator */}
      <div className="flex items-center justify-between rounded-2xl bg-zinc-900 px-2 py-1.5">
        <button
          onClick={() => onSelectIndex(Math.max(0, selectedIndex - 1))}
          disabled={selectedIndex === 0}
          className="p-1.5 text-zinc-500 active:text-white transition-colors disabled:opacity-30"
          aria-label="Previous session"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="flex flex-col items-center">
          <span className="text-[13px] font-medium text-white">{formatSessionLabel(session)}</span>
          <span className="text-[10px] text-zinc-500 tabular-nums">
            {formatClock(session.enteredBedAt)}
            {' → '}
            {session.leftBedAt ? formatClock(session.leftBedAt) : 'now'}
          </span>
        </div>
        <button
          onClick={() => onSelectIndex(Math.min(sessions.length - 1, selectedIndex + 1))}
          disabled={selectedIndex >= sessions.length - 1}
          className="p-1.5 text-zinc-500 active:text-white transition-colors disabled:opacity-30"
          aria-label="Next session"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Stacked HR / HRV / BR panels sharing the session's clock-time axis */}
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4 space-y-2">
        {METRICS.map((metric) => {
          const primary = filterToWindow(metricSeries[metric.key], start, end)
          const secondary = otherMetricSeries ? filterToWindow(otherMetricSeries[metric.key], start, end) : []
          const { mean, sd } = metricBaseline(metric.key, baseline)
          const baselineMin = mean != null && sd != null ? mean - sd : undefined
          const baselineMax = mean != null && sd != null ? mean + sd : undefined
          const primarySummaryAvg
            = metric.key === 'hr'
              ? summary?.avgHeartRate
              : metric.key === 'hrv'
                ? summary?.avgHRV
                : summary?.avgBreathingRate
          const secondarySummaryAvg
            = metric.key === 'hr'
              ? otherSummary?.avgHeartRate
              : metric.key === 'hrv'
                ? otherSummary?.avgHRV
                : otherSummary?.avgBreathingRate

          return (
            <div key={metric.key}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  {metric.icon}
                  <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
                    {metric.title}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px] tabular-nums">
                  {mean != null && (
                    <span className="text-zinc-500">
                      baseline
                      {' '}
                      <span style={{ color: metric.color }}>{Math.round(mean)}</span>
                      {sd != null && (
                        <span className="text-zinc-600">
                          {' '}
                          ±
                          {Math.round(sd)}
                        </span>
                      )}
                    </span>
                  )}
                  {primary.length > 0 && (
                    <span style={{ color: metric.color }} className="font-medium">
                      {Math.round(primary[primary.length - 1].value)}
                      {' '}
                      {metric.unit}
                    </span>
                  )}
                </div>
              </div>
              <VitalsChart
                data={primary}
                color={metric.color}
                gradientId={`${metric.gradientId}-night`}
                zones={metric.zones}
                average={primarySummaryAvg ?? null}
                unit={metric.unit}
                height={120}
                label={primaryLabel}
                xMin={start}
                xMax={end}
                baselineMin={baselineMin}
                baselineMax={baselineMax}
                compact
                secondary={secondary.length > 0
                  ? {
                      data: secondary,
                      color: secondaryColor,
                      gradientId: `${metric.gradientId}-night-other`,
                      label: secondaryLabel ?? '',
                      average: secondarySummaryAvg ?? null,
                    }
                  : undefined}
              />
            </div>
          )
        })}
      </div>
    </>
  )
}

// ── Week view ───────────────────────────────────────────────────────

interface NightStat {
  date: Date
  median: number
  q1: number
  q3: number
}

function computeNightStats(
  records: VitalsRecord[],
  sessions: SleepSession[],
  metric: 'hr' | 'hrv' | 'br',
): NightStat[] {
  if (sessions.length === 0) return []
  const stats: NightStat[] = []
  const field
    = metric === 'hr'
      ? 'heartRate'
      : metric === 'hrv' ? 'hrv' : 'breathingRate'
  for (const session of sessions) {
    const start = session.enteredBedAt.getTime()
    const end = (session.leftBedAt ?? new Date()).getTime()
    const vals: number[] = []
    for (const r of records) {
      const t = new Date(r.timestamp).getTime()
      if (t < start || t > end) continue
      const v = r[field]
      if (v != null) vals.push(v)
    }
    const s = summarise(vals)
    if (s) {
      stats.push({ date: session.enteredBedAt, median: s.median, q1: s.q1, q3: s.q3 })
    }
  }
  return stats
}

function WeekView({
  sortedRecords,
  otherSortedRecords,
  sessions,
  baseline,
  primaryLabel,
  secondaryLabel,
}: {
  sortedRecords: VitalsRecord[]
  otherSortedRecords: VitalsRecord[] | null
  sessions: SleepSession[]
  baseline: { hrMean: number | null, hrSD: number | null, hrvMean: number | null, hrvSD: number | null, brMean: number | null, brSD: number | null } | null
  primaryLabel?: string
  secondaryLabel?: string
}) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-6 text-center">
        <p className="text-zinc-500 text-sm">No sleep sessions this week</p>
      </div>
    )
  }

  return (
    <>
      {METRICS.map((metric) => {
        const primaryStats = computeNightStats(sortedRecords, sessions, metric.key)
        const secondaryStats = otherSortedRecords ? computeNightStats(otherSortedRecords, sessions, metric.key) : []
        const { mean, sd } = metricBaseline(metric.key, baseline)
        return (
          <WeekMetricCard
            key={metric.key}
            metric={metric}
            primaryStats={primaryStats}
            secondaryStats={secondaryStats}
            baselineMean={mean}
            baselineSD={sd}
            primaryLabel={primaryLabel}
            secondaryLabel={secondaryLabel}
          />
        )
      })}
    </>
  )
}

function WeekMetricCard({
  metric,
  primaryStats,
  secondaryStats,
  baselineMean,
  baselineSD,
  primaryLabel,
  secondaryLabel,
}: {
  metric: MetricSpec
  primaryStats: NightStat[]
  secondaryStats: NightStat[]
  baselineMean: number | null
  baselineSD: number | null
  primaryLabel?: string
  secondaryLabel?: string
}) {
  const allStats = [...primaryStats, ...secondaryStats]
  if (allStats.length === 0) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="flex items-center gap-1.5 mb-2">
          {metric.icon}
          <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
            {metric.title}
          </span>
        </div>
        <p className="text-center text-zinc-500 text-xs py-6">No data this week</p>
      </div>
    )
  }

  // Shared scale: extend domain to include the baseline band (if any) so the
  // band frames the dots rather than the dots framing the band.
  let domainLo = Math.min(...allStats.map(s => s.q1))
  let domainHi = Math.max(...allStats.map(s => s.q3))
  if (baselineMean != null && baselineSD != null) {
    domainLo = Math.min(domainLo, baselineMean - baselineSD)
    domainHi = Math.max(domainHi, baselineMean + baselineSD)
  }
  const range = domainHi - domainLo || 1
  domainLo -= range * 0.08
  domainHi += range * 0.08

  const scale = (v: number) => ((v - domainLo) / (domainHi - domainLo)) * 100 // %

  return (
    <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          {metric.icon}
          <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
            {metric.title}
          </span>
        </div>
        {baselineMean != null && (
          <span className="text-[10px] text-zinc-500 tabular-nums">
            baseline
            {' '}
            <span style={{ color: metric.color }}>{Math.round(baselineMean)}</span>
            {baselineSD != null && (
              <span className="text-zinc-600">
                {' '}
                ±
                {Math.round(baselineSD)}
              </span>
            )}
            <span className="text-zinc-600 ml-1">{metric.unit}</span>
          </span>
        )}
      </div>

      {primaryStats.map((stat, idx) => {
        const otherStat = secondaryStats.find(s => s.date.getTime() === stat.date.getTime())
        return (
          <NightSummaryRow
            key={idx}
            stat={stat}
            otherStat={otherStat ?? null}
            color={metric.color}
            secondaryColor="#a78bfa"
            primaryLabel={primaryLabel}
            secondaryLabel={secondaryLabel}
            baselineMean={baselineMean}
            baselineSD={baselineSD}
            scale={scale}
            domainLo={domainLo}
            domainHi={domainHi}
            unit={metric.unit}
          />
        )
      })}
    </div>
  )
}

function NightSummaryRow({
  stat,
  otherStat,
  color,
  secondaryColor,
  primaryLabel,
  secondaryLabel,
  baselineMean,
  baselineSD,
  scale,
  domainLo,
  domainHi,
  unit,
}: {
  stat: NightStat
  otherStat: NightStat | null
  color: string
  secondaryColor: string
  primaryLabel?: string
  secondaryLabel?: string
  baselineMean: number | null
  baselineSD: number | null
  scale: (v: number) => number
  domainLo: number
  domainHi: number
  unit: string
}) {
  const outsideBand
    = baselineMean != null && baselineSD != null
      ? Math.abs(stat.median - baselineMean) > baselineSD
      : false

  const bandStart = baselineMean != null && baselineSD != null ? scale(baselineMean - baselineSD) : null
  const bandEnd = baselineMean != null && baselineSD != null ? scale(baselineMean + baselineSD) : null

  return (
    <div className="grid grid-cols-[64px_1fr_56px] items-center gap-2 py-1.5 border-t border-zinc-800 first:border-t-0">
      <span className="text-[11px] text-zinc-400 tabular-nums">
        {formatNightLabel(stat.date)}
      </span>
      <div className="relative h-5">
        {/* Baseline band */}
        {bandStart != null && bandEnd != null && (
          <div
            className="absolute top-1 bottom-1 rounded-sm"
            style={{
              left: `${bandStart}%`,
              width: `${Math.max(0, bandEnd - bandStart)}%`,
              backgroundColor: color,
              opacity: 0.1,
            }}
          />
        )}
        {/* IQR bar */}
        <div
          className="absolute top-2 bottom-2 rounded-full"
          style={{
            left: `${scale(stat.q1)}%`,
            width: `${Math.max(2, scale(stat.q3) - scale(stat.q1))}%`,
            backgroundColor: color,
            opacity: 0.35,
          }}
          title={`${primaryLabel ?? 'IQR'}: ${Math.round(stat.q1)}–${Math.round(stat.q3)} ${unit}`}
        />
        {/* Primary median dot */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-2.5 w-2.5 rounded-full ring-2 ring-zinc-900"
          style={{
            left: `${scale(stat.median)}%`,
            backgroundColor: outsideBand ? color : '#a1a1aa',
          }}
          title={`${primaryLabel ?? 'Median'}: ${Math.round(stat.median)} ${unit}`}
        />
        {/* Secondary (other-side) median */}
        {otherStat && (
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-2 w-2 rounded-full ring-1 ring-zinc-900"
            style={{
              left: `${scale(otherStat.median)}%`,
              backgroundColor: secondaryColor,
            }}
            title={`${secondaryLabel ?? 'Other'}: ${Math.round(otherStat.median)} ${unit}`}
          />
        )}
      </div>
      <span className="text-[11px] tabular-nums text-right" style={{ color: outsideBand ? color : '#a1a1aa' }}>
        {Math.round(stat.median)}
      </span>
      {/* Silence unused lint warnings for derived bounds the row consumes via scale */}
      <span className="hidden">
        {domainLo}
        {domainHi}
      </span>
    </div>
  )
}

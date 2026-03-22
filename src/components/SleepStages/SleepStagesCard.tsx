'use client'

import { useState, useMemo, useCallback } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Hypnogram } from './Hypnogram'
import { StageDistributionBar } from './StageDistributionBar'
import { QualityScore } from './QualityScore'
import { TimeRangeSelector, type TimeRange } from './TimeRangeSelector'
import { WeeklySleepChart } from './WeeklySleepChart'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  type StageDistribution,
  classifySleepStages,
  mergeIntoBlocks,
  calculateDistribution,
  calculateQualityScore,
} from '@/src/lib/sleep-stages'

interface SleepStagesCardProps {
  side: 'left' | 'right'
  /** Initial time range view. Defaults to 'night'. */
  defaultTimeRange?: TimeRange
  /** When true, hide the night/week/month picker (locks to defaultTimeRange) */
  hideTimeRangeSelector?: boolean
}

/** Get the start of the week (Sunday) for a given date */
function getWeekStart(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - d.getDay())
  return d
}

/** Get start of month */
function getMonthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

/** Format date range for display */
function formatDateRange(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  return `${start.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', opts)}`
}

/** Format single night date */
function formatNightDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Main sleep stages visualization card.
 *
 * Night view: Full hypnogram + quality score + distribution
 * Week view: 7-day stacked bar chart, tap to drill into single night
 * Month view: Sleep records list with duration + quality
 *
 * Wired to tRPC biometrics.getSleepStages and biometrics.getSleepRecords.
 */
export function SleepStagesCard({ side, defaultTimeRange = 'night', hideTimeRangeSelector = false }: SleepStagesCardProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>(defaultTimeRange)
  const [weekOffset, setWeekOffset] = useState(0) // 0 = current week, -1 = last week, etc.
  const [monthOffset, setMonthOffset] = useState(0)
  const [selectedWeekNight, setSelectedWeekNight] = useState<string | null>(null)

  // Calculate date ranges
  const { startDate, endDate } = useMemo(() => {
    const now = new Date()

    if (timeRange === 'night') {
      // Night mode: let the backend find the latest sleep record
      return { startDate: undefined, endDate: undefined }
    }

    if (timeRange === 'week') {
      const weekStart = getWeekStart(now)
      weekStart.setDate(weekStart.getDate() + weekOffset * 7)
      const weekEnd = new Date(weekStart)
      weekEnd.setDate(weekEnd.getDate() + 7)
      return { startDate: weekStart, endDate: weekEnd }
    }

    // Month
    const monthStart = getMonthStart(now)
    monthStart.setMonth(monthStart.getMonth() + monthOffset)
    const monthEnd = new Date(monthStart)
    monthEnd.setMonth(monthEnd.getMonth() + 1)
    return { startDate: monthStart, endDate: monthEnd }
  }, [timeRange, weekOffset, monthOffset])

  // Night view: get sleep stages for the latest/selected night
  const nightStages = trpc.biometrics.getSleepStages.useQuery(
    { side },
    { enabled: timeRange === 'night' },
  )

  // Drill-in from weekly view: get stages for a specific night
  const drillInStages = trpc.biometrics.getSleepStages.useQuery(
    {
      side,
      startDate: selectedWeekNight ? new Date(selectedWeekNight + 'T00:00:00') : undefined,
      endDate: selectedWeekNight
        ? (() => {
            const d = new Date(selectedWeekNight + 'T00:00:00')
            d.setDate(d.getDate() + 1)
            return d
          })()
        : undefined,
    },
    { enabled: timeRange === 'week' && selectedWeekNight !== null },
  )

  // Week/Month view: get sleep records for the date range
  const sleepRecords = trpc.biometrics.getSleepRecords.useQuery(
    {
      side,
      startDate,
      endDate,
      limit: timeRange === 'month' ? 31 : 7,
    },
    { enabled: timeRange !== 'night' && !!startDate },
  )

  // Week/Month: also get vitals + movement for classification
  const vitalsQuery = trpc.biometrics.getVitals.useQuery(
    {
      side,
      startDate,
      endDate,
      limit: 1000,
    },
    { enabled: timeRange !== 'night' && !!startDate },
  )

  const movementQuery = trpc.biometrics.getMovement.useQuery(
    {
      side,
      startDate,
      endDate,
      limit: 1000,
    },
    { enabled: timeRange !== 'night' && !!startDate },
  )

  // Build weekly night summaries
  const weeklyNights = useMemo(() => {
    if (timeRange !== 'week' || !sleepRecords.data || !vitalsQuery.data || !startDate) return []

    const records = sleepRecords.data as Array<{
      id: number
      enteredBedAt: Date
      leftBedAt: Date
      sleepDurationSeconds: number
    }>

    const vitalsData = (vitalsQuery.data ?? []) as Array<{
      timestamp: Date
      heartRate: number | null
      hrv: number | null
      breathingRate: number | null
    }>

    const movData = (movementQuery.data ?? []) as Array<{
      timestamp: Date
      totalMovement: number
    }>

    // Group by night (using entered_bed_at date)
    const nightMap = new Map<string, typeof records>()
    for (const record of records) {
      const bedDate = new Date(record.enteredBedAt)
      // If entered bed after midnight but before 6AM, count as previous day's night
      const adjustedDate = new Date(bedDate)
      if (adjustedDate.getHours() < 6) {
        adjustedDate.setDate(adjustedDate.getDate() - 1)
      }
      const dateKey = adjustedDate.toISOString().split('T')[0]
      if (!nightMap.has(dateKey)) nightMap.set(dateKey, [])
      nightMap.get(dateKey)!.push(record)
    }

    // Build 7 days
    const nights = []
    for (let i = 0; i < 7; i++) {
      const day = new Date(startDate)
      day.setDate(day.getDate() + i)
      const dateKey = day.toISOString().split('T')[0]
      const dayRecords = nightMap.get(dateKey) ?? []

      let totalSleepHours = 0
      let distribution: StageDistribution = { wake: 0, light: 0, deep: 0, rem: 0 }
      let qualityScore = 0

      if (dayRecords.length > 0) {
        totalSleepHours = dayRecords.reduce((sum, r) => sum + r.sleepDurationSeconds, 0) / 3600

        // Filter vitals/movement for this night's window
        const nightStart = dayRecords[0].enteredBedAt
        const nightEnd = dayRecords[dayRecords.length - 1].leftBedAt
        const nightVitals = vitalsData.filter((v) => {
          const t = new Date(v.timestamp).getTime()
          return t >= new Date(nightStart).getTime() && t <= new Date(nightEnd).getTime()
        })
        const nightMovement = movData.filter((m) => {
          const t = new Date(m.timestamp).getTime()
          return t >= new Date(nightStart).getTime() && t <= new Date(nightEnd).getTime()
        })

        if (nightVitals.length > 0) {
          const epochs = classifySleepStages(
            nightVitals.map(v => ({ ...v, timestamp: new Date(v.timestamp) })),
            nightMovement.map(m => ({ ...m, timestamp: new Date(m.timestamp) })),
          )
          distribution = calculateDistribution(epochs)
          qualityScore = calculateQualityScore(distribution)
        }
      }

      nights.push({
        date: dateKey,
        dayLabel: DAY_NAMES[day.getDay()],
        totalSleepHours,
        distribution,
        qualityScore,
      })
    }

    return nights
  }, [timeRange, sleepRecords.data, vitalsQuery.data, movementQuery.data, startDate])

  // Monthly summaries
  const monthlySummaries = useMemo(() => {
    if (timeRange !== 'month' || !sleepRecords.data) return []

    const records = sleepRecords.data as Array<{
      id: number
      enteredBedAt: Date
      leftBedAt: Date
      sleepDurationSeconds: number
      timesExitedBed: number
    }>

    return records.map((record) => {
      const bedDate = new Date(record.enteredBedAt)
      return {
        id: record.id,
        date: bedDate,
        sleepHours: record.sleepDurationSeconds / 3600,
        timesExited: record.timesExitedBed,
      }
    })
  }, [timeRange, sleepRecords.data])

  // Navigation handlers
  const canGoForward = useMemo(() => {
    if (timeRange === 'week') return weekOffset < 0
    if (timeRange === 'month') return monthOffset < 0
    return false
  }, [timeRange, weekOffset, monthOffset])

  const handlePrev = useCallback(() => {
    if (timeRange === 'week') setWeekOffset(o => o - 1)
    if (timeRange === 'month') setMonthOffset(o => o - 1)
  }, [timeRange])

  const handleNext = useCallback(() => {
    if (timeRange === 'week' && weekOffset < 0) setWeekOffset(o => o + 1)
    if (timeRange === 'month' && monthOffset < 0) setMonthOffset(o => o + 1)
  }, [timeRange, weekOffset, monthOffset])

  const handleWeekNightSelect = useCallback((date: string) => {
    setSelectedWeekNight(prev => (prev === date ? null : date))
  }, [])

  // Loading state
  const isLoading
    = (timeRange === 'night' && nightStages.isLoading)
      || (timeRange !== 'night' && sleepRecords.isLoading)

  // Error state
  const error = nightStages.error || sleepRecords.error

  // Current stages data (night view or drill-in)
  const stagesData = timeRange === 'night'
    ? nightStages.data
    : (selectedWeekNight ? drillInStages.data : null)

  return (
    <div className="space-y-3 rounded-2xl bg-zinc-900/50 p-3 sm:space-y-4 sm:p-4">
      {/* Header with title and time range */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">
          {timeRange === 'week' ? 'Sleep Timeline' : 'Sleep Stages'}
        </h2>
        {!hideTimeRangeSelector && (
          <TimeRangeSelector
            value={timeRange}
            onChange={(r) => {
              setTimeRange(r)
              setSelectedWeekNight(null)
            }}
          />
        )}
      </div>

      {/* Navigation for week/month */}
      {timeRange !== 'night' && startDate && endDate && (
        <div className="flex items-center justify-between">
          <button
            onClick={handlePrev}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white active:bg-zinc-700"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="text-sm text-zinc-300">
            {formatDateRange(startDate, endDate)}
          </span>
          <button
            onClick={handleNext}
            disabled={!canGoForward}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white active:bg-zinc-700 disabled:opacity-30"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex h-40 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-sky-400" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-900/30 p-3 text-center text-sm text-red-400">
          Failed to load sleep data
        </div>
      )}

      {/* Night view */}
      {!isLoading && !error && timeRange === 'night' && stagesData && (
        <>
          {stagesData.epochs.length > 0 ? (
            <>
              {/* Quality score + distribution row */}
              <div className="flex items-start gap-4">
                <QualityScore score={stagesData.qualityScore} />
                <div className="flex-1 space-y-3">
                  <StageDistributionBar distribution={stagesData.distribution} />
                </div>
              </div>

              {/* Night date label */}
              {stagesData.enteredBedAt && (
                <p className="text-center text-xs text-zinc-500">
                  {formatNightDate(new Date(stagesData.enteredBedAt))}
                </p>
              )}
            </>
          ) : (
            <div className="flex h-32 items-center justify-center text-sm text-zinc-500">
              No sleep data recorded yet
            </div>
          )}
        </>
      )}

      {/* Week view */}
      {!isLoading && !error && timeRange === 'week' && (
        <>
          <WeeklySleepChart
            nights={weeklyNights}
            onSelectNight={handleWeekNightSelect}
            selectedDate={selectedWeekNight}
          />

          {/* Drill-in: show hypnogram for selected night */}
          {selectedWeekNight && drillInStages.data && drillInStages.data.epochs.length > 0 && (
            <div className="mt-3 space-y-3 border-t border-zinc-800 pt-3">
              <p className="text-center text-xs text-zinc-400">
                {formatNightDate(new Date(selectedWeekNight + 'T12:00:00'))}
              </p>
              <div className="flex items-start gap-4">
                <QualityScore score={drillInStages.data.qualityScore} />
                <div className="flex-1">
                  <StageDistributionBar distribution={drillInStages.data.distribution} />
                </div>
              </div>
              <Hypnogram
                blocks={drillInStages.data.blocks}
                epochs={drillInStages.data.epochs}
                startTime={drillInStages.data.enteredBedAt ?? drillInStages.data.epochs[0].start}
                endTime={drillInStages.data.leftBedAt ?? drillInStages.data.epochs[drillInStages.data.epochs.length - 1].start + drillInStages.data.epochs[drillInStages.data.epochs.length - 1].duration}
              />
            </div>
          )}

          {selectedWeekNight && drillInStages.isLoading && (
            <div className="flex h-20 items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-sky-400" />
            </div>
          )}
        </>
      )}

      {/* Month view */}
      {!isLoading && !error && timeRange === 'month' && (
        <div className="space-y-2">
          {monthlySummaries.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-zinc-500">
              No sleep data this month
            </div>
          ) : (
            <>
              {/* Summary stats */}
              <div className="grid grid-cols-3 gap-2 rounded-lg bg-zinc-800/50 p-3">
                <div className="text-center">
                  <div className="text-lg font-semibold text-white">
                    {monthlySummaries.length}
                  </div>
                  <div className="text-[10px] text-zinc-500">Nights</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-semibold text-white">
                    {(monthlySummaries.reduce((s, n) => s + n.sleepHours, 0) / monthlySummaries.length).toFixed(1)}
                    h
                  </div>
                  <div className="text-[10px] text-zinc-500">Avg Sleep</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-semibold text-white">
                    {(monthlySummaries.reduce((s, n) => s + n.timesExited, 0) / monthlySummaries.length).toFixed(1)}
                  </div>
                  <div className="text-[10px] text-zinc-500">Avg Exits</div>
                </div>
              </div>

              {/* Nightly list */}
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {monthlySummaries.map(night => (
                  <div
                    key={night.id}
                    className="flex items-center justify-between rounded-lg bg-zinc-800/30 px-3 py-2"
                  >
                    <span className="text-xs text-zinc-300">
                      {night.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    </span>
                    <span className="text-xs tabular-nums text-zinc-400">
                      {(night.sleepHours ?? 0).toFixed(1)}
                      h
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      {night.timesExited}
                      {' '}
                      exits
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

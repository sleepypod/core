'use client'

import type { StageDistribution, SleepStage } from '@/src/lib/sleep-stages'
import { STAGE_COLORS } from '@/src/lib/sleep-stages'

interface NightSummary {
  date: string // ISO date string (YYYY-MM-DD)
  dayLabel: string // "Mon", "Tue", etc.
  totalSleepHours: number
  distribution: StageDistribution
  qualityScore: number
}

interface WeeklySleepChartProps {
  nights: NightSummary[]
  onSelectNight?: (date: string) => void
  selectedDate?: string | null
}

const STAGES: SleepStage[] = ['deep', 'light', 'rem', 'wake']
const MAX_HOURS = 12

/**
 * Weekly bar chart showing sleep duration per night with stage color breakdown.
 * Each bar is a stacked bar showing the distribution of stages.
 * Tap a bar to drill into that night's hypnogram.
 */
export function WeeklySleepChart({ nights, onSelectNight, selectedDate }: WeeklySleepChartProps) {
  if (nights.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-zinc-500 text-sm">
        No sleep data this week
      </div>
    )
  }

  // Bar heights are computed in pixels relative to a fixed track height
  // so the % cascade isn't relative to a flex parent's auto height
  // (which collapses to 0 in column-flex without an explicit height).
  const TRACK_HEIGHT = 96
  const HOURS_LABEL_HEIGHT = 16

  return (
    <div className="w-full">
      {/* Bars */}
      <div className="flex items-end gap-2" style={{ height: TRACK_HEIGHT + HOURS_LABEL_HEIGHT }}>
        {nights.map((night) => {
          const cappedHours = Math.min(night.totalSleepHours, MAX_HOURS)
          const barHeightPx = Math.max(Math.round((cappedHours / MAX_HOURS) * TRACK_HEIGHT), 4)
          const isSelected = selectedDate === night.date

          // When stage classification has no data (vitals scarce or absent
          // in the night's window) the distribution is all zeros and would
          // render an invisible bar. Fall back to a neutral grey fill so
          // the user still sees that there was sleep duration.
          const distributionTotal = STAGES.reduce((sum, s) => sum + night.distribution[s], 0)
          const hasStageData = distributionTotal > 0

          return (
            <button
              key={night.date}
              onClick={() => onSelectNight?.(night.date)}
              className="flex flex-1 flex-col items-center justify-end gap-1"
              style={{ height: '100%' }}
            >
              {/* Hours label */}
              <span
                className="text-[10px] text-zinc-500 tabular-nums"
                style={{ height: HOURS_LABEL_HEIGHT, lineHeight: `${HOURS_LABEL_HEIGHT}px` }}
              >
                {(night.totalSleepHours ?? 0).toFixed(1)}
                h
              </span>

              {/* Stacked bar */}
              <div
                className="relative w-full overflow-hidden rounded-t-md transition-all"
                style={{
                  height: barHeightPx,
                  outline: isSelected ? '2px solid white' : 'none',
                  outlineOffset: 1,
                  backgroundColor: hasStageData ? undefined : '#3f3f46',
                }}
              >
                {hasStageData && STAGES.map((stage) => {
                  const pct = night.distribution[stage]
                  if (pct === 0) return null
                  return (
                    <div
                      key={stage}
                      className="w-full"
                      style={{
                        height: `${pct}%`,
                        backgroundColor: STAGE_COLORS[stage],
                      }}
                    />
                  )
                })}
              </div>
            </button>
          )
        })}
      </div>

      {/* Day labels */}
      <div className="mt-1 flex gap-2">
        {nights.map(night => (
          <div key={night.date} className="flex-1 text-center text-[10px] text-zinc-500">
            {night.dayLabel}
          </div>
        ))}
      </div>
    </div>
  )
}

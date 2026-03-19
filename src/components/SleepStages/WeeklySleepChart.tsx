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

  return (
    <div className="w-full">
      {/* Bars */}
      <div className="flex items-end gap-2" style={{ height: 120 }}>
        {nights.map(night => {
          const barHeight = Math.max((night.totalSleepHours / MAX_HOURS) * 100, 4)
          const isSelected = selectedDate === night.date

          return (
            <button
              key={night.date}
              onClick={() => onSelectNight?.(night.date)}
              className="flex flex-1 flex-col items-center gap-1"
            >
              {/* Hours label */}
              <span className="text-[10px] text-zinc-500 tabular-nums">
                {night.totalSleepHours.toFixed(1)}h
              </span>

              {/* Stacked bar */}
              <div
                className="relative w-full overflow-hidden rounded-t-md transition-all"
                style={{
                  height: `${barHeight}%`,
                  minHeight: 4,
                  outline: isSelected ? '2px solid white' : 'none',
                  outlineOffset: 1,
                }}
              >
                {STAGES.map(stage => {
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

'use client'

import type { SleepStage, SleepEpoch } from '@/src/lib/sleep-stages'
import { STAGE_COLORS, formatDurationHM } from '@/src/lib/sleep-stages'

interface StageDurationLegendProps {
  epochs: SleepEpoch[]
  totalSleepMs: number
}

const STAGES: { key: SleepStage; label: string }[] = [
  { key: 'deep', label: 'Deep' },
  { key: 'light', label: 'Light' },
  { key: 'rem', label: 'REM' },
  { key: 'wake', label: 'Wake' },
]

/**
 * Shows total time spent in each stage (e.g., "2h 15m").
 * Matches iOS SleepStagesTimelineView duration legend.
 */
export function StageDurationLegend({ epochs, totalSleepMs }: StageDurationLegendProps) {
  const totals: Record<SleepStage, number> = { wake: 0, light: 0, deep: 0, rem: 0 }
  for (const e of epochs) {
    totals[e.stage] += e.duration
  }

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {STAGES.map(({ key, label }) => (
        <div key={key} className="flex items-center gap-1">
          <div
            className="h-2 w-2 rounded-sm"
            style={{ backgroundColor: STAGE_COLORS[key] }}
          />
          <span className="text-[10px] text-zinc-500">
            {label}
          </span>
          <span className="text-[10px] font-medium text-zinc-300">
            {formatDurationHM(totals[key])}
          </span>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-zinc-500">Total</span>
        <span className="text-[10px] font-medium text-white">
          {formatDurationHM(totalSleepMs)}
        </span>
      </div>
    </div>
  )
}

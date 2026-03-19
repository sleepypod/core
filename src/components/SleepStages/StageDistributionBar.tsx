'use client'

import type { StageDistribution, SleepStage } from '@/src/lib/sleep-stages'
import { STAGE_COLORS } from '@/src/lib/sleep-stages'

interface StageDistributionBarProps {
  distribution: StageDistribution
}

const STAGES: { key: SleepStage; label: string }[] = [
  { key: 'deep', label: 'Deep' },
  { key: 'light', label: 'Light' },
  { key: 'rem', label: 'REM' },
  { key: 'wake', label: 'Wake' },
]

/**
 * Horizontal stacked bar showing percentage breakdown of each sleep stage.
 * Matches iOS SleepStagesTimelineView stage distribution bar.
 */
export function StageDistributionBar({ distribution }: StageDistributionBarProps) {
  const total = distribution.wake + distribution.light + distribution.deep + distribution.rem
  if (total === 0) return null

  return (
    <div className="space-y-2">
      {/* Stacked bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {STAGES.map(({ key }) => {
          const pct = distribution[key]
          if (pct === 0) return null
          return (
            <div
              key={key}
              className="h-full transition-all duration-300"
              style={{
                width: `${pct}%`,
                backgroundColor: STAGE_COLORS[key],
              }}
            />
          )
        })}
      </div>

      {/* Legend with percentages */}
      <div className="flex justify-between">
        {STAGES.map(({ key, label }) => (
          <div key={key} className="flex items-center gap-1.5">
            <div
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: STAGE_COLORS[key] }}
            />
            <span className="text-[11px] text-zinc-400">
              {label}
              {' '}
              <span className="text-zinc-300 font-medium">{distribution[key]}%</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

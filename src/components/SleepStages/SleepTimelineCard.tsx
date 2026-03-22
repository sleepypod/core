'use client'

import { trpc } from '@/src/utils/trpc'
import { Hypnogram } from './Hypnogram'

interface SleepTimelineCardProps {
  side: 'left' | 'right'
}

function formatNightDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Sleep timeline — the hypnogram visualization showing sleep stage
 * progression through the night (Wake/REM/Light/Deep as colored blocks).
 * Placed between vitals/breathing and movement on the biometrics page.
 */
export function SleepTimelineCard({ side }: SleepTimelineCardProps) {
  const { data: stagesData, isLoading } = trpc.biometrics.getSleepStages.useQuery(
    { side },
    { staleTime: 60_000 },
  )

  if (isLoading) {
    return (
      <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
        <div className="flex h-40 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-sky-400" />
        </div>
      </div>
    )
  }

  if (!stagesData || stagesData.epochs.length === 0) {
    return (
      <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
        <h3 className="mb-2 text-sm font-semibold text-white">Sleep Timeline</h3>
        <div className="flex h-32 items-center justify-center text-sm text-zinc-500">
          No sleep data recorded yet
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Sleep Timeline</h3>
        {stagesData.enteredBedAt && (
          <span className="text-xs text-zinc-500">
            {formatNightDate(new Date(stagesData.enteredBedAt))}
          </span>
        )}
      </div>

      <Hypnogram
        blocks={stagesData.blocks}
        epochs={stagesData.epochs}
        startTime={stagesData.enteredBedAt ?? stagesData.epochs[0].start}
        endTime={stagesData.leftBedAt ?? stagesData.epochs[stagesData.epochs.length - 1].start + stagesData.epochs[stagesData.epochs.length - 1].duration}
      />
    </div>
  )
}

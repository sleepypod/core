'use client'

import { Moon } from 'lucide-react'
import type { SleepRecord } from './types'
import { SleepRecordActions } from './SleepRecordActions'

interface SleepSummaryCardProps {
  records: SleepRecord[]
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Sleep summary card matching iOS SleepSummaryCardView.
 * Shows bedtime, wake time, duration, and bed exits for the most recent record.
 */
export function SleepSummaryCard({ records }: SleepSummaryCardProps) {
  if (!records || records.length === 0) {
    return (
      <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
        <div className="flex items-center gap-2 text-zinc-500">
          <Moon size={16} />
          <span className="text-xs font-medium uppercase tracking-wider">Sleep Summary</span>
        </div>
        <p className="mt-3 text-sm text-zinc-600">No sleep data for this week</p>
      </div>
    )
  }

  // Show most recent record (first since ordered DESC)
  const record = records[0]
  const avgDuration
    = records.reduce((sum, r) => sum + r.sleepDurationSeconds, 0) / records.length

  return (
    <div className="rounded-2xl bg-zinc-900/80 p-3 sm:p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Moon size={16} className="text-sky-400" />
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            Sleep Summary
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">{formatDate(record.enteredBedAt)}</span>
          {/* Edit / Delete actions for the most recent record */}
          <SleepRecordActions
            recordId={record.id}
            enteredBedAt={record.enteredBedAt}
            leftBedAt={record.leftBedAt}
          />
        </div>
      </div>

      {/* 2x2 grid of metrics */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] text-zinc-500">Bedtime</p>
          <p className="text-sm font-medium text-zinc-200">{formatTime(record.enteredBedAt)}</p>
        </div>
        <div>
          <p className="text-[11px] text-zinc-500">Wake Time</p>
          <p className="text-sm font-medium text-zinc-200">{formatTime(record.leftBedAt)}</p>
        </div>
        <div>
          <p className="text-[11px] text-zinc-500">Duration</p>
          <p className="text-sm font-medium text-zinc-200">
            {formatDuration(record.sleepDurationSeconds)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-zinc-500">Exits</p>
          <p className="text-sm font-medium text-zinc-200">{record.timesExitedBed}</p>
        </div>
      </div>

      {/* Weekly average */}
      {records.length > 1 && (
        <div className="mt-3 border-t border-zinc-800 pt-3">
          <p className="text-[11px] text-zinc-500">
            Weekly Avg (
            {records.length}
            {' '}
            nights) ·
            {' '}
            <span className="text-zinc-300">{formatDuration(Math.round(avgDuration))}</span>
          </p>
        </div>
      )}
    </div>
  )
}

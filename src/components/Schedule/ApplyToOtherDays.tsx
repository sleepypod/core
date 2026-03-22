'use client'

import { cn } from '@/lib/utils'
import { ChevronDown, Copy } from 'lucide-react'
import { useState } from 'react'
import { DAY_GROUPS, DAYS, type DayOfWeek } from './DaySelector'

interface ApplyToOtherDaysProps {
  /** The source day whose schedule will be copied */
  sourceDay: DayOfWeek
  /** Currently selected target days (excluding source) */
  selectedDays: Set<DayOfWeek>
  /** Called when user confirms apply */
  onApply: (targetDays: DayOfWeek[]) => void
  /** Whether the apply operation is in-flight */
  isLoading?: boolean
  /** Whether there's a schedule to copy from */
  hasSchedule: boolean
}

/**
 * "Apply to Other Days" expandable panel.
 * Lets the user copy the current day's schedule to other days of the week.
 * Uses a delete-then-recreate pattern matching the iOS SleepypodCoreClient.
 */
export function ApplyToOtherDays({
  sourceDay,
  selectedDays,
  onApply,
  isLoading = false,
  hasSchedule,
}: ApplyToOtherDaysProps) {
  const [expanded, setExpanded] = useState(false)
  const [targetDays, setTargetDays] = useState<Set<DayOfWeek>>(new Set())
  const [showConfirm, setShowConfirm] = useState(false)

  // All days except the source day are available targets
  const availableDays = DAYS.filter(d => d.key !== sourceDay)

  const toggleTarget = (day: DayOfWeek) => {
    setTargetDays(prev => {
      const next = new Set(prev)
      if (next.has(day)) {
        next.delete(day)
      } else {
        next.add(day)
      }
      return next
    })
    setShowConfirm(false)
  }

  const selectGroup = (group: Set<DayOfWeek>) => {
    // Toggle: if all group days are selected, deselect them; otherwise select all
    const groupDays = new Set([...group].filter(d => d !== sourceDay))
    const allSelected = [...groupDays].every(d => targetDays.has(d))
    if (allSelected) {
      setTargetDays(prev => {
        const next = new Set(prev)
        for (const d of groupDays) next.delete(d)
        return next
      })
    } else {
      setTargetDays(prev => {
        const next = new Set(prev)
        for (const d of groupDays) next.add(d)
        return next
      })
    }
    setShowConfirm(false)
  }

  const handleApply = () => {
    if (!showConfirm) {
      setShowConfirm(true)
      return
    }
    const days = Array.from(targetDays)
    onApply(days)
    setShowConfirm(false)
    setTargetDays(new Set())
    setExpanded(false)
  }

  if (!hasSchedule) return null

  return (
    <div className="rounded-xl bg-zinc-900">
      {/* Header toggle */}
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="flex w-full min-h-[44px] items-center justify-between px-4 py-3"
      >
        <div className="flex items-center gap-2">
          <Copy size={16} className="text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">
            Apply to Other Days
          </span>
        </div>
        <ChevronDown
          size={16}
          className={cn(
            'text-zinc-500 transition-transform duration-200',
            expanded && 'rotate-180'
          )}
        />
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-zinc-800 px-4 pb-4 pt-3">
          {/* Source day label */}
          <p className="text-xs text-zinc-500">
            Copy{' '}
            <span className="text-zinc-300">
              {DAYS.find(d => d.key === sourceDay)?.label}
            </span>
            &apos;s schedule to:
          </p>

          {/* Quick-select buttons */}
          <div className="flex gap-2">
            <button
              onClick={() => selectGroup(DAY_GROUPS.weekdays)}
              className="rounded-lg bg-zinc-800 px-3 min-h-[44px] text-xs font-medium text-zinc-400 transition-colors active:bg-zinc-700"
            >
              Weekdays
            </button>
            <button
              onClick={() => selectGroup(DAY_GROUPS.weekends)}
              className="rounded-lg bg-zinc-800 px-3 min-h-[44px] text-xs font-medium text-zinc-400 transition-colors active:bg-zinc-700"
            >
              Weekends
            </button>
            <button
              onClick={() => selectGroup(DAY_GROUPS.allDays)}
              className="rounded-lg bg-zinc-800 px-3 min-h-[44px] text-xs font-medium text-zinc-400 transition-colors active:bg-zinc-700"
            >
              All Days
            </button>
          </div>

          {/* Day checkboxes */}
          <div className="grid grid-cols-3 gap-2">
            {availableDays.map(day => {
              const isTarget = targetDays.has(day.key)
              return (
                <button
                  key={day.key}
                  onClick={() => toggleTarget(day.key)}
                  className={cn(
                    'rounded-lg px-3 min-h-[44px] text-sm font-medium transition-colors',
                    isTarget
                      ? 'bg-sky-500/20 text-sky-400 ring-1 ring-sky-500/30'
                      : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'
                  )}
                >
                  {day.label}
                </button>
              )
            })}
          </div>

          {/* Apply button */}
          <button
            onClick={handleApply}
            disabled={targetDays.size === 0 || isLoading}
            className={cn(
              'w-full rounded-lg min-h-[44px] py-2.5 text-sm font-medium transition-colors',
              targetDays.size === 0 || isLoading
                ? 'bg-zinc-800 text-zinc-600'
                : showConfirm
                  ? 'bg-amber-500 text-black active:bg-amber-400'
                  : 'bg-sky-500 text-white active:bg-sky-400'
            )}
          >
            {isLoading
              ? 'Applying...'
              : showConfirm
                ? `Confirm: Replace ${targetDays.size} day${targetDays.size > 1 ? 's' : ''}?`
                : `Apply to ${targetDays.size} day${targetDays.size > 1 ? 's' : ''}`}
          </button>

          {showConfirm && (
            <p className="text-center text-xs text-amber-400/70">
              This will overwrite existing schedules for the selected days
            </p>
          )}
        </div>
      )}
    </div>
  )
}

'use client'

import { Bell, BellOff, Clock } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/providers/SideProvider'

interface AlarmBannerProps {
  /** Which side(s) have active alarms */
  leftAlarmActive: boolean
  rightAlarmActive: boolean
  /** Snooze status per side (from snoozeManager.getSnoozeStatus) */
  snooze?: {
    left?: { active: boolean; snoozeUntil: number | null } | null
    right?: { active: boolean; snoozeUntil: number | null } | null
  }
  /** Called after alarm action to refresh status */
  onActionComplete?: () => void
}

/**
 * Alarm banner shown on Temp screen when vibration alarm is active.
 * Matches iOS AlarmBanner — yellow/tan color scheme with Snooze and Stop buttons.
 */
export const AlarmBanner = ({
  leftAlarmActive,
  rightAlarmActive,
  snooze,
  onActionComplete,
}: AlarmBannerProps) => {
  const { activeSides } = useSide()

  const clearAlarmMutation = trpc.device.clearAlarm.useMutation()
  const snoozeAlarmMutation = trpc.device.snoozeAlarm.useMutation()

  const isAnyAlarmActive = leftAlarmActive || rightAlarmActive
  const leftSnoozed = snooze?.left?.active === true && snooze.left.snoozeUntil != null
  const rightSnoozed = snooze?.right?.active === true && snooze.right.snoozeUntil != null
  const isAnySnoozed = leftSnoozed || rightSnoozed

  if (!isAnyAlarmActive && !isAnySnoozed) return null

  const alarmSides = [
    leftAlarmActive && 'Left',
    rightAlarmActive && 'Right',
  ].filter(Boolean)

  const snoozeSides = [
    leftSnoozed && 'Left',
    rightSnoozed && 'Right',
  ].filter(Boolean)

  const handleStop = () => {
    const sidesToClear = activeSides.filter(
      (s) => (s === 'left' && leftAlarmActive) || (s === 'right' && rightAlarmActive),
    )
    // If no active sides match, clear all active alarms
    const targets = sidesToClear.length > 0
      ? sidesToClear
      : [leftAlarmActive && 'left', rightAlarmActive && 'right'].filter(Boolean) as ('left' | 'right')[]

    for (const side of targets) {
      clearAlarmMutation.mutate(
        { side },
        { onSettled: onActionComplete },
      )
    }
  }

  const handleSnooze = () => {
    const sidesToSnooze = activeSides.filter(
      (s) => (s === 'left' && leftAlarmActive) || (s === 'right' && rightAlarmActive),
    )
    const targets = sidesToSnooze.length > 0
      ? sidesToSnooze
      : [leftAlarmActive && 'left', rightAlarmActive && 'right'].filter(Boolean) as ('left' | 'right')[]

    for (const side of targets) {
      snoozeAlarmMutation.mutate(
        { side, duration: 300 },
        { onSettled: onActionComplete },
      )
    }
  }

  const formatSnoozeRemaining = (snoozeUntilSec: number): string => {
    const remaining = Math.max(0, snoozeUntilSec - Math.floor(Date.now() / 1000))
    const mins = Math.ceil(remaining / 60)
    return `${mins}m`
  }

  const isPending = clearAlarmMutation.isPending || snoozeAlarmMutation.isPending

  return (
    <div className="rounded-2xl border border-amber-500/20 bg-amber-950/30 p-3 sm:p-4">
      {/* Active alarm */}
      {isAnyAlarmActive && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Bell size={18} className="shrink-0 text-amber-400" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-200">Alarm Active</p>
              <p className="text-xs text-amber-400/70">
                {alarmSides.join(' & ')} side vibrating
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSnooze}
              disabled={isPending}
              className="flex flex-1 min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-amber-900/40 px-3 py-2.5 text-sm font-medium text-amber-200 transition-all active:scale-95 disabled:opacity-50"
            >
              <Clock size={14} />
              Snooze 5m
            </button>
            <button
              onClick={handleStop}
              disabled={isPending}
              className="flex flex-1 min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-amber-900/40 px-3 py-2.5 text-sm font-medium text-amber-200 transition-all active:scale-95 disabled:opacity-50"
            >
              <BellOff size={14} />
              Stop
            </button>
          </div>
        </div>
      )}

      {/* Snoozed alarm (when not actively vibrating) */}
      {!isAnyAlarmActive && isAnySnoozed && (
        <div className="flex items-center gap-2">
          <Clock size={16} className="shrink-0 text-amber-400/60" />
          <p className="flex-1 text-sm text-amber-300/70">
            Snoozed — {snoozeSides.join(' & ')} resumes in{' '}
            {snooze?.left?.snoozeUntil
              ? formatSnoozeRemaining(snooze.left.snoozeUntil)
              : snooze?.right?.snoozeUntil
                ? formatSnoozeRemaining(snooze.right.snoozeUntil)
                : ''}
          </p>
          <button
            onClick={handleStop}
            disabled={isPending}
            className="rounded-lg bg-amber-900/40 px-3 min-h-[44px] text-xs font-medium text-amber-200 transition-all active:scale-95 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

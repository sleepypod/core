'use client'

import { Bell, BellOff, Clock } from 'lucide-react'
import { Button } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/providers/SideProvider'

interface AlarmBannerProps {
  /** Which side(s) have active alarms */
  leftAlarmActive: boolean
  rightAlarmActive: boolean
  /** Snooze status per side (from snoozeManager.getSnoozeStatus) */
  snooze?: {
    left?: { active: boolean, snoozeUntil: number | null } | null
    right?: { active: boolean, snoozeUntil: number | null } | null
  }
  /** Called after alarm action to refresh status */
  onActionComplete?: () => void
}

/**
 * Alarm banner shown on Temp screen when vibration alarm is active.
 * Warn-toned banner with Snooze and Stop buttons (or Cancel while snoozed).
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
    // During snooze nothing is vibrating, so the stop targets are the
    // snoozed sides — building them from leftAlarmActive/rightAlarmActive
    // (both false) made the Cancel button a no-op and the alarm resumed.
    const stoppable = isAnyAlarmActive
      ? { left: leftAlarmActive, right: rightAlarmActive }
      : { left: leftSnoozed, right: rightSnoozed }

    const sidesToClear = activeSides.filter(s => stoppable[s])
    // If no active sides match, clear all stoppable alarms
    const targets = sidesToClear.length > 0
      ? sidesToClear
      : (['left', 'right'] as const).filter(s => stoppable[s])

    for (const side of targets) {
      clearAlarmMutation.mutate(
        { side },
        { onSettled: onActionComplete },
      )
    }
  }

  const handleSnooze = () => {
    const sidesToSnooze = activeSides.filter(
      s => (s === 'left' && leftAlarmActive) || (s === 'right' && rightAlarmActive),
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
    // eslint-disable-next-line react-hooks/purity
    const remaining = Math.max(0, snoozeUntilSec - Math.floor(Date.now() / 1000))
    const mins = Math.ceil(remaining / 60)
    return `${mins}m`
  }

  const isPending = clearAlarmMutation.isPending || snoozeAlarmMutation.isPending

  return (
    <div role="status" className="rounded-card border border-warn-line bg-warn-bg px-[18px] py-3.5">
      {/* Active alarm */}
      {isAnyAlarmActive && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <Bell size={16} className="shrink-0 text-warn" />
            <div className="flex-1">
              <p className="text-[15px] font-medium text-fg">Alarm active</p>
              <p className="text-[13px] text-fg-2">
                {alarmSides.join(' & ')}
                {' '}
                side vibrating
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button icon={Clock} onClick={handleSnooze} disabled={isPending}>
              Snooze 5m
            </Button>
            <Button icon={BellOff} variant="primary" onClick={handleStop} disabled={isPending}>
              Stop
            </Button>
          </div>
        </div>
      )}

      {/* Snoozed alarm (when not actively vibrating) */}
      {!isAnyAlarmActive && isAnySnoozed && (
        <div className="flex items-center gap-2.5">
          <Clock size={14} className="shrink-0 text-warn" />
          <p className="flex-1 text-[13px] text-fg-2">
            Snoozed —
            {' '}
            {snoozeSides.join(' & ')}
            {' '}
            resumes in
            {' '}
            <span className="font-mono text-fg">
              {snooze?.left?.snoozeUntil
                ? formatSnoozeRemaining(snooze.left.snoozeUntil)
                : snooze?.right?.snoozeUntil
                  ? formatSnoozeRemaining(snooze.right.snoozeUntil)
                  : ''}
            </span>
          </p>
          <Button size="sm" onClick={handleStop} disabled={isPending}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}

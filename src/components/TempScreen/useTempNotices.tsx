'use client'

import { AlertTriangle, Bell, BellOff, CircleCheck, Clock, Droplets } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, useToast, type Notice } from '@/src/components/ds'
import type { useDeviceStatus } from '@/src/hooks/useDeviceStatus'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import { useSide, type Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'

type DeviceStatus = ReturnType<typeof useDeviceStatus>['status']

const SIDES: Side[] = ['left', 'right']
/** A prime completion older than this is stale: dismissed without a toast. */
export const PRIME_TOAST_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Completions already toasted (or dismissed as stale), keyed by their timestamp.
 * Module-wide so the cards and the stage, or a remount while the dismiss call is
 * still in flight, never toast the same completion twice.
 */
const handledPrimeCompletions = new Set<number>()

/**
 * The server stamps completion in unix seconds; the WebSocket path wraps that
 * number in a Date as if it were milliseconds. Either way, read it back as ms.
 */
export function primeCompletedAtMs(timestamp: unknown): number | null {
  const raw = timestamp instanceof Date ? timestamp.getTime() : typeof timestamp === 'number' ? timestamp : typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN
  if (!Number.isFinite(raw)) return null
  return raw < 1e12 ? raw * 1000 : raw
}

/** Sides any notice blocks. */
export function blockedSides(notices: Notice[]): Record<Side, boolean> {
  const blocked = { left: false, right: false }
  for (const n of notices) for (const s of n.blocksSides ?? []) blocked[s] = true
  return blocked
}

const sideWord = (side: Side) => (side === 'left' ? 'Left' : 'Right')

/**
 * The pod's own notices for the Temperature screen and the stage, derived from
 * device status: pump stalls (danger), the alarm (warn) and priming (cool) as
 * banners, plus a one-off toast when priming completes. `enabled: false` keeps
 * the banners but skips the toast and its dismiss (a screen that is hidden).
 */
export function useTempNotices(status: DeviceStatus, onRefetch: () => void, { enabled = true }: { enabled?: boolean } = {}) {
  const { formatClock } = useTimeFormatter()
  const { activeSides } = useSide()
  const toast = useToast()

  const acknowledge = trpc.pumpAlerts.acknowledgeAndRestore.useMutation()
  const dismissStall = trpc.pumpAlerts.dismissNotification.useMutation()
  const clearAlarm = trpc.device.clearAlarm.useMutation()
  const snoozeAlarm = trpc.device.snoozeAlarm.useMutation()
  const dismissPrime = trpc.device.dismissPrimeNotification.useMutation()

  const isPriming = status?.isPriming ?? false
  const leftAlarmActive = status?.leftSide?.isAlarmVibrating ?? false
  const rightAlarmActive = status?.rightSide?.isAlarmVibrating ?? false
  const snooze = status?.snooze
  const leftSnoozed = snooze?.left?.active === true && snooze.left.snoozeUntil != null
  const rightSnoozed = snooze?.right?.active === true && snooze.right.snoozeUntil != null
  const isAnyAlarmActive = leftAlarmActive || rightAlarmActive
  const isAnySnoozed = leftSnoozed || rightSnoozed

  // The snooze countdown ticks while a snooze is showing.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!isAnySnoozed || isAnyAlarmActive) return
    const t = setInterval(() => setNowMs(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [isAnySnoozed, isAnyAlarmActive])

  // Priming complete: the server flag means "not yet seen"; the toast is how it
  // gets seen, so dismiss right after. Stale completions are dismissed silently.
  const completedAt = status?.primeCompletedNotification ? primeCompletedAtMs(status.primeCompletedNotification.timestamp) : null
  const hasPrimeFlag = status?.primeCompletedNotification != null
  const { show } = toast
  const { mutate: dismissPrimeMutate } = dismissPrime
  useEffect(() => {
    if (!enabled || !hasPrimeFlag || isPriming) return
    const key = completedAt ?? 0
    if (handledPrimeCompletions.has(key)) return
    handledPrimeCompletions.add(key)
    const stale = completedAt != null && Date.now() - completedAt > PRIME_TOAST_MAX_AGE_MS
    if (!stale) {
      show({ id: 'prime-complete', kind: 'success', tone: 'ok', icon: CircleCheck, title: 'Priming complete. Your pod is ready.' })
    }
    dismissPrimeMutate({}, { onSettled: onRefetch })
  }, [enabled, hasPrimeFlag, isPriming, completedAt, show, dismissPrimeMutate, onRefetch])

  const notices: Notice[] = []

  // Pump stall: highest priority, per side.
  for (const side of SIDES) {
    const notice = status?.pumpStallNotifications?.[side]
    if (!notice) continue
    // Correlate the mutation with the incident shown here; the server then
    // stamps exactly this row even across a restart. 0 means "no row".
    const alertId = notice.alertId || undefined
    // Re-enable and dismiss race for the same guard state and alert row, so
    // both stay disabled while either is in flight for this side.
    const pendingFor = (m: { isPending: boolean, variables?: { side: Side } }) => m.isPending && (m.variables?.side ?? side) === side
    const busy = pendingFor(acknowledge) || pendingFor(dismissStall)
    notices.push({
      id: `pump-stall:${side}`,
      kind: 'action',
      tone: 'danger',
      icon: AlertTriangle,
      title: `${sideWord(side)} side powered off. Pump stall detected.`,
      detail: (
        <>
          {'Pump RPM dropped to '}
          <span className="font-mono">{notice.rpm}</span>
          {' at '}
          <span className="font-mono">{formatClock(notice.trippedAt * 1000)}</span>
          . The side is off for safety. Re-enable to retry.
        </>
      ),
      actions: (
        <Button size="sm" variant="danger" disabled={busy} onClick={() => acknowledge.mutate({ side, alertId }, { onSettled: onRefetch })}>
          Re-enable
        </Button>
      ),
      onDismiss: () => dismissStall.mutate({ side, alertId }, { onSettled: onRefetch }),
      dismissLabel: 'Dismiss pump stall notification',
      dismissDisabled: busy,
      blocksSides: [side],
    })
  }

  if (isPriming) {
    // The device reports only isPriming: no progress or ETA, so no bar or meta.
    notices.push({
      id: 'priming',
      kind: 'progress',
      tone: 'cool',
      icon: Droplets,
      title: 'Priming',
      detail: 'Temperature controls resume when it finishes',
      blocksSides: ['left', 'right'],
    })
  }
  // TODO: "Priming didn't finish" (action, warn, Retry → device.startPriming) once
  // the device reports a priming failure; status has no failure state today.

  const alarmPending = clearAlarm.isPending || snoozeAlarm.isPending
  const handleStop = () => {
    // During snooze nothing is vibrating, so the stop targets are the
    // snoozed sides — building them from leftAlarmActive/rightAlarmActive
    // (both false) made the Cancel button a no-op and the alarm resumed.
    const stoppable = isAnyAlarmActive
      ? { left: leftAlarmActive, right: rightAlarmActive }
      : { left: leftSnoozed, right: rightSnoozed }
    const sidesToClear = activeSides.filter(s => stoppable[s])
    // If no active sides match, clear all stoppable alarms
    const targets = sidesToClear.length > 0 ? sidesToClear : SIDES.filter(s => stoppable[s])
    for (const side of targets) clearAlarm.mutate({ side }, { onSettled: onRefetch })
  }
  const handleSnooze = () => {
    const sidesToSnooze = activeSides.filter(s => (s === 'left' && leftAlarmActive) || (s === 'right' && rightAlarmActive))
    const targets = sidesToSnooze.length > 0
      ? sidesToSnooze
      : SIDES.filter(s => (s === 'left' ? leftAlarmActive : rightAlarmActive))
    for (const side of targets) snoozeAlarm.mutate({ side, duration: 300 }, { onSettled: onRefetch })
  }

  if (isAnyAlarmActive) {
    const sides = [leftAlarmActive && 'Left', rightAlarmActive && 'Right'].filter(Boolean).join(' & ')
    notices.push({
      id: 'alarm',
      kind: 'action',
      tone: 'warn',
      icon: Bell,
      title: 'Alarm active',
      detail: `${sides} side vibrating`,
      actions: (
        <>
          <Button size="sm" icon={Clock} onClick={handleSnooze} disabled={alarmPending}>Snooze 5m</Button>
          <Button size="sm" icon={BellOff} variant="primary" onClick={handleStop} disabled={alarmPending}>Stop</Button>
        </>
      ),
    })
  }
  else if (isAnySnoozed) {
    const sides = [leftSnoozed && 'Left', rightSnoozed && 'Right'].filter(Boolean).join(' & ')
    const until = snooze?.left?.snoozeUntil ?? snooze?.right?.snoozeUntil ?? null
    const minutes = until == null ? null : Math.ceil(Math.max(0, until - Math.floor(nowMs / 1000)) / 60)
    notices.push({
      id: 'alarm-snoozed',
      kind: 'progress',
      tone: 'warn',
      icon: Clock,
      title: 'Alarm snoozed',
      detail: `${sides} resumes when the snooze ends`,
      meta: minutes == null ? undefined : `${minutes}M`,
      actions: <Button size="sm" onClick={handleStop} disabled={alarmPending}>Cancel</Button>,
    })
  }

  return { notices, blocked: blockedSides(notices) }
}

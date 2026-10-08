'use client'

import type { useDeviceStatus } from '@/src/hooks/useDeviceStatus'
import type { Side } from '@/src/providers/SideProvider'
import { AlarmBanner } from './AlarmBanner'
import { PrimeCompleteNotification } from './PrimeCompleteNotification'
import { PrimingIndicator } from './PrimingIndicator'
import { PumpStallNotification } from './PumpStallNotification'

const SIDES: Side[] = ['left', 'right']

/**
 * The pod's own notices, in priority order: pump stalls, priming, prime complete,
 * then the alarm banner. Shared by the Temperature cards and the stage so neither
 * view hides an alarm that needs stopping.
 */
export function DeviceAlerts({ status, onRefetch }: { status: ReturnType<typeof useDeviceStatus>['status'], onRefetch: () => void }) {
  const stallNotices = status?.pumpStallNotifications
  const isPriming = status?.isPriming ?? false
  return (
    <>
      {/* Pump stall — highest priority, dismissible per-side */}
      {SIDES.map((side) => {
        const notice = stallNotices?.[side]
        return notice && (
          <PumpStallNotification
            key={side}
            side={side}
            rpm={notice.rpm}
            trippedAt={notice.trippedAt}
            alertId={notice.alertId}
            onAction={onRefetch}
          />
        )
      })}

      {isPriming && <PrimingIndicator />}

      {status?.primeCompletedNotification != null && !isPriming && (
        <PrimeCompleteNotification onDismiss={onRefetch} />
      )}

      {/* Alarm banner — active vibration with snooze/stop, or snoozed countdown */}
      <AlarmBanner
        leftAlarmActive={status?.leftSide?.isAlarmVibrating ?? false}
        rightAlarmActive={status?.rightSide?.isAlarmVibrating ?? false}
        snooze={status?.snooze}
        onActionComplete={onRefetch}
      />
    </>
  )
}

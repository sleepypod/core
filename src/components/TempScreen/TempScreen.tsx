'use client'

import { useCallback, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/providers/SideProvider'
import { useDeviceStatus } from '@/src/hooks/useDeviceStatus'
import { SideSelector } from '@/src/components/SideSelector/SideSelector'
import { UserSelector } from '@/src/components/UserSelector/UserSelector'
import { EnvironmentInfoPanel } from '@/src/components/EnvironmentInfo/EnvironmentInfoPanel'
import { TemperatureDial } from '@/src/components/TemperatureDial/TemperatureDial'
import { AlarmBanner } from '@/src/components/TempScreen/AlarmBanner'
import { PrimingIndicator } from '@/src/components/TempScreen/PrimingIndicator'
import { PrimeCompleteNotification } from '@/src/components/TempScreen/PrimeCompleteNotification'
import { AmbientLightChip } from '@/src/components/TempScreen/AmbientLightChip'
import { type TempUnit } from '@/src/lib/tempUtils'
import { TEMP } from '@/src/lib/tempColors'
import { Minus, Plus, Power } from 'lucide-react'
import clsx from 'clsx'

/**
 * Main temperature screen — mirrors iOS TempScreen.swift composition.
 *
 * Layout:
 * 1. PrimingIndicator (when pod is priming water system)
 * 2. PrimeCompleteNotification (dismissible, after priming finishes)
 * 3. AlarmBanner (when vibration alarm is active, with snooze/stop)
 * 4. TemperatureDial (270° circular dial with draggable thumb — matches iOS TemperatureDialView)
 * 5. Temp controls (+/- buttons, power toggle)
 * 6. EnvironmentInfoPanel (ambient temp, humidity, bed temp)
 * 7. UserSelector (at bottom for easy thumb reach)
 * SideSelector is rendered here (Temp screen only, not in the global layout).
 *
 * Device router wiring:
 * - device.getStatus (query, 7s poll) → current/target temp, power, alarm, priming, snooze
 * - device.setTemperature (mutation) → dial drag + ±1 buttons
 * - device.setPower (mutation) → power toggle
 * - device.clearAlarm (mutation) → alarm banner stop button
 * - device.snoozeAlarm (mutation) → alarm banner snooze button
 * - device.dismissPrimeNotification (mutation) → prime complete dismiss
 * - settings.getAll (query) → temperature unit preference
 * - environment.getLatestBedTemp (query) → EnvironmentInfoPanel
 * - environment.getLatestFreezerTemp (query) → EnvironmentInfoPanel
 * - environment.getLatestAmbientLight (query) → AmbientLightChip
 * - biometrics.getLatestSleep (query) → LatestSleepChip
 *
 * Polls device.getStatus every 7 seconds for real-time updates.
 * Uses optimistic local target temp during dial drag for smooth interaction.
 */
export const TempScreen = () => {
  const { primarySide, activeSides } = useSide()

  // Device status via WebSocket (2s push) with HTTP fallback
  const { status, isLoading: statusLoading, refetch } = useDeviceStatus()

  const { data: settings } = trpc.settings.getAll.useQuery({})
  const unit: TempUnit = (settings?.device?.temperatureUnit as TempUnit) ?? 'F'

  const setTempMutation = trpc.device.setTemperature.useMutation()
  const setPowerMutation = trpc.device.setPower.useMutation()

  // Optimistic local target temp while dragging
  const [localTarget, setLocalTarget] = useState<number | null>(null)

  // Get current side's status
  const currentSideStatus = primarySide === 'left' ? status?.leftSide : status?.rightSide
  const currentTemp = currentSideStatus?.currentTemperature ?? 80
  const serverTarget = currentSideStatus?.targetTemperature ?? 80
  const targetLevel = currentSideStatus?.targetLevel ?? 0
  const isOn = targetLevel !== 0

  // Use local target while dragging, server target otherwise
  const targetTemp = localTarget ?? serverTarget

  // Alarm & priming status from device
  const leftAlarmActive = status?.leftSide?.isAlarmVibrating ?? false
  const rightAlarmActive = status?.rightSide?.isAlarmVibrating ?? false
  const isPriming = status?.isPriming ?? false
  const hasPrimeNotification = status?.primeCompletedNotification != null
  const snoozeStatus = status?.snooze

  /** Handle continuous drag updates — visual only, no hardware calls. */
  const handleDialChange = useCallback((tempF: number) => {
    setLocalTarget(tempF)
  }, [])

  /** Handle drag end — send final value to hardware. */
  const handleDialCommit = useCallback((tempF: number) => {
    for (const side of activeSides) {
      setTempMutation.mutate(
        { side, temperature: tempF },
        { onSettled: () => { setLocalTarget(null); refetch() } },
      )
    }
  }, [activeSides, setTempMutation, refetch])

  const handleTempAdjust = (delta: number) => {
    const newTemp = Math.max(TEMP.MIN_F, Math.min(TEMP.MAX_F, targetTemp + delta))
    setLocalTarget(null)
    for (const side of activeSides) {
      setTempMutation.mutate(
        { side, temperature: newTemp },
        { onSettled: () => refetch() },
      )
    }
  }

  const handlePowerToggle = () => {
    for (const side of activeSides) {
      setPowerMutation.mutate(
        { side, powered: !isOn },
        { onSettled: () => refetch() },
      )
    }
  }

  if (statusLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <span className="text-sm text-zinc-500">Connecting…</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      {/* Side selector — only on the Temp screen */}
      <SideSelector />

      {/* Priming indicator — shown when pod water system is actively priming */}
      {isPriming && (
        <div className="flex justify-center">
          <PrimingIndicator />
        </div>
      )}

      {/* Prime completion notification — dismissible */}
      {hasPrimeNotification && !isPriming && (
        <PrimeCompleteNotification onDismiss={() => refetch()} />
      )}

      {/* Alarm banner — active vibration with snooze/stop, or snoozed countdown */}
      <AlarmBanner
        leftAlarmActive={leftAlarmActive}
        rightAlarmActive={rightAlarmActive}
        snooze={snoozeStatus}
        onActionComplete={refetch}
      />

      {/* Circular temperature dial — matches iOS TemperatureDialView */}
      <TemperatureDial
        currentTempF={currentTemp}
        targetTempF={targetTemp}
        isOn={isOn}
        onTemperatureChange={handleDialChange}
        onTemperatureCommit={handleDialCommit}
      />

      {/* Temperature controls: −/power/+ (tight gap to dial to avoid mobile scroll) */}
      <div className="-mt-2 flex items-center justify-center gap-4 sm:mt-0 sm:gap-6">
        {/* Minus button */}
        <button
          onClick={() => handleTempAdjust(-1)}
          disabled={!isOn || setTempMutation.isPending}
          className={clsx(
            'flex h-12 w-12 cursor-pointer items-center justify-center rounded-full transition-all duration-200 sm:h-14 sm:w-14',
            'bg-zinc-900 text-zinc-400 active:bg-zinc-800 active:scale-95',
            'disabled:cursor-default disabled:opacity-30 disabled:active:scale-100',
          )}
        >
          <Minus size={22} />
        </button>

        {/* Power button */}
        <button
          onClick={handlePowerToggle}
          disabled={setPowerMutation.isPending}
          className={clsx(
            'flex h-14 w-14 cursor-pointer items-center justify-center rounded-full transition-all duration-200 sm:h-16 sm:w-16',
            'active:scale-95',
            isOn
              ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
              : 'bg-zinc-900 text-zinc-600 border border-transparent',
          )}
        >
          <Power size={26} />
        </button>

        {/* Plus button */}
        <button
          onClick={() => handleTempAdjust(1)}
          disabled={!isOn || setTempMutation.isPending}
          className={clsx(
            'flex h-12 w-12 cursor-pointer items-center justify-center rounded-full transition-all duration-200 sm:h-14 sm:w-14',
            'bg-zinc-900 text-zinc-400 active:bg-zinc-800 active:scale-95',
            'disabled:cursor-default disabled:opacity-30 disabled:active:scale-100',
          )}
        >
          <Plus size={22} />
        </button>
      </div>

      {/* Environment info: home temp + lux (matching iOS) */}
      <EnvironmentInfoPanel unit={unit} />
      <div className="flex items-center justify-center">
        <AmbientLightChip />
      </div>

    </div>
  )
}

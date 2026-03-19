'use client'

import { useCallback, useRef, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/providers/SideProvider'
import { SideSelector } from '@/src/components/SideSelector/SideSelector'
import { UserSelector } from '@/src/components/UserSelector/UserSelector'
import { EnvironmentInfoPanel } from '@/src/components/EnvironmentInfo/EnvironmentInfoPanel'
import { TemperatureDial } from '@/src/components/TemperatureDial/TemperatureDial'
import { AlarmBanner } from '@/src/components/TempScreen/AlarmBanner'
import { PrimingIndicator } from '@/src/components/TempScreen/PrimingIndicator'
import { PrimeCompleteNotification } from '@/src/components/TempScreen/PrimeCompleteNotification'
import { AmbientLightChip } from '@/src/components/TempScreen/AmbientLightChip'
import { LatestSleepChip } from '@/src/components/TempScreen/LatestSleepChip'
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
 * 4. SideSelector (left/right buttons with temp display)
 * 5. TemperatureDial (270° circular dial with draggable thumb — matches iOS TemperatureDialView)
 * 6. Temp controls (+/- buttons, power toggle)
 * 7. EnvironmentInfoPanel (ambient temp, humidity, bed temp)
 * 8. UserSelector (at bottom for easy thumb reach)
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

  // Primary polling query — 7s interval (within 5-10s spec)
  const { data: status, isLoading: statusLoading, refetch } = trpc.device.getStatus.useQuery(
    {},
    { refetchInterval: 7_000, staleTime: 3_000 },
  )

  const { data: settings } = trpc.settings.getAll.useQuery({})
  const unit: TempUnit = (settings?.device?.temperatureUnit as TempUnit) ?? 'F'

  const setTempMutation = trpc.device.setTemperature.useMutation()
  const setPowerMutation = trpc.device.setPower.useMutation()

  // Optimistic local target temp while dragging
  const [localTarget, setLocalTarget] = useState<number | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  /** Handle continuous drag updates — debounce hardware calls during drag. */
  const handleDialChange = useCallback((tempF: number) => {
    setLocalTarget(tempF)

    // Debounce mutation during drag to avoid flooding hardware
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      for (const side of activeSides) {
        setTempMutation.mutate({ side, temperature: tempF })
      }
    }, 300)
  }, [activeSides, setTempMutation])

  /** Handle drag end — send final value immediately. */
  const handleDialCommit = useCallback((tempF: number) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

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
      {/* Priming indicator — shown when pod water system is actively priming */}
      {isPriming && (
        <div className="flex justify-center">
          <PrimingIndicator />
        </div>
      )}

      {/* Prime completion notification — dismissible */}
      {hasPrimeNotification && !isPriming && (
        <PrimeCompleteNotification onDismiss={refetch} />
      )}

      {/* Alarm banner — active vibration with snooze/stop, or snoozed countdown */}
      <AlarmBanner
        leftAlarmActive={leftAlarmActive}
        rightAlarmActive={rightAlarmActive}
        snooze={snoozeStatus}
        onActionComplete={refetch}
      />

      {/* Side selector with live temp display */}
      <SideSelector />

      {/* Circular temperature dial — matches iOS TemperatureDialView */}
      <TemperatureDial
        currentTempF={currentTemp}
        targetTempF={targetTemp}
        isOn={isOn}
        onTemperatureChange={handleDialChange}
        onTemperatureCommit={handleDialCommit}
      />

      {/* Temperature controls: −/power/+ */}
      <div className="flex items-center justify-center gap-4 sm:gap-6">
        {/* Minus button */}
        <button
          onClick={() => handleTempAdjust(-1)}
          disabled={!isOn || setTempMutation.isPending}
          className={clsx(
            'flex h-12 w-12 items-center justify-center rounded-full transition-all duration-200 sm:h-14 sm:w-14',
            'bg-zinc-900 text-zinc-400 active:bg-zinc-800 active:scale-95',
            'disabled:opacity-30 disabled:active:scale-100',
          )}
        >
          <Minus size={22} />
        </button>

        {/* Power button */}
        <button
          onClick={handlePowerToggle}
          disabled={setPowerMutation.isPending}
          className={clsx(
            'flex h-14 w-14 items-center justify-center rounded-full transition-all duration-200 sm:h-16 sm:w-16',
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
            'flex h-12 w-12 items-center justify-center rounded-full transition-all duration-200 sm:h-14 sm:w-14',
            'bg-zinc-900 text-zinc-400 active:bg-zinc-800 active:scale-95',
            'disabled:opacity-30 disabled:active:scale-100',
          )}
        >
          <Plus size={22} />
        </button>
      </div>

      {/* Environment info panel + ambient light + last night sleep */}
      <EnvironmentInfoPanel unit={unit} />
      <div className="flex items-center justify-center gap-4">
        <AmbientLightChip />
        <LatestSleepChip />
      </div>

      {/* User selector — at bottom for easy thumb reach */}
      <UserSelector />
    </div>
  )
}

'use client'

import { useCallback, useMemo, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useSchedule } from '@/src/hooks/useSchedule'
import { DaySelector } from './DaySelector'
import { CurvePresets } from './CurvePresets'
import { CurveChart } from './CurveChart'
import { PhaseLegend } from './PhaseLegend'
import { TimePicker } from './TimePicker'
import { ScheduleWeekOverview } from './ScheduleWeekOverview'
import { ScheduleToggle } from './ScheduleToggle'
import { SchedulerConfirmation } from './SchedulerConfirmation'
import { ManualControlsSheet } from './ManualControlsSheet'
import { trpc } from '@/src/utils/trpc'
import {
  generateSleepCurve,
  timeStringToMinutes,
} from '@/src/lib/sleepCurve/generate'
import type { CoolingIntensity, CurvePoint } from '@/src/lib/sleepCurve/types'

/**
 * Redesigned Schedule page layout:
 * 1. Day selector (multi-select for bulk ops)
 * 2. Curve presets (horizontal scroll: Hot Sleeper, Balanced, Cold Sleeper)
 * 3. Bedtime/wake time pickers + visual temperature curve chart
 * 4. Schedule enable/disable toggle
 * 5. Manual Controls button → opens bottom sheet
 * 6. Week overview summary
 */
export function SchedulePage() {
  const {
    side,
    selectedDay,
    selectedDays,
    setSelectedDay,
    setSelectedDays,
    confirmMessage,
    isPowerEnabled,
    hasScheduleData,
    isApplying,
    isMutating,
    toggleAllSchedules,
    applyToOtherDays,
    isLoading: hookLoading,
  } = useSchedule()

  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side })

  // Curve state — updated when presets are applied or times change
  const [bedtime, setBedtime] = useState('22:00')
  const [wakeTime, setWakeTime] = useState('07:00')
  const [intensity, setIntensity] = useState<CoolingIntensity>('balanced')
  const [minTempF, setMinTempF] = useState(68)
  const [maxTempF, setMaxTempF] = useState(86)

  const bedtimeMinutes = useMemo(() => timeStringToMinutes(bedtime), [bedtime])
  const wakeMinutes = useMemo(() => timeStringToMinutes(wakeTime), [wakeTime])

  const curvePoints: CurvePoint[] = useMemo(
    () =>
      generateSleepCurve({
        bedtimeMinutes,
        wakeMinutes,
        intensity,
        minTempF,
        maxTempF,
      }),
    [bedtimeMinutes, wakeMinutes, intensity, minTempF, maxTempF],
  )

  // When a preset is applied, sync curve display state
  const handlePresetApplied = useCallback(
    (config: {
      points: CurvePoint[]
      bedtimeMinutes: number
      minTempF: number
      maxTempF: number
      intensity: CoolingIntensity
      bedtime: string
      wakeTime: string
    }) => {
      setBedtime(config.bedtime)
      setWakeTime(config.wakeTime)
      setMinTempF(config.minTempF)
      setMaxTempF(config.maxTempF)
      setIntensity(config.intensity)
    },
    [],
  )

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* 1. Day Selector */}
      <DaySelector
        activeDay={selectedDay}
        onActiveDayChange={setSelectedDay}
        selectedDays={selectedDays}
        onSelectedDaysChange={setSelectedDays}
      />

      {/* Multi-day info banner */}
      {selectedDays.size > 1 && (
        <div className="rounded-lg bg-sky-500/10 px-3 py-2 text-xs text-sky-400">
          {selectedDays.size} days selected — changes affect all selected days
        </div>
      )}

      {/* 2. Curve Presets */}
      <CurvePresets
        side={side}
        selectedDay={selectedDay}
        selectedDays={selectedDays}
        onApplied={handlePresetApplied}
      />

      {/* 3. Time Pickers + Curve Chart */}
      <div className="space-y-3">
        <div className="flex gap-4">
          <TimePicker
            label="Bedtime"
            icon={<Moon size={14} />}
            accentClass="text-purple-400"
            value={bedtime}
            onChange={setBedtime}
          />
          <TimePicker
            label="Wake Up"
            icon={<Sun size={14} />}
            accentClass="text-amber-400"
            value={wakeTime}
            onChange={setWakeTime}
          />
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <CurveChart
            points={curvePoints}
            bedtimeMinutes={bedtimeMinutes}
            minTempF={minTempF}
            maxTempF={maxTempF}
          />
          <div className="mt-2">
            <PhaseLegend />
          </div>
        </div>
      </div>

      {/* 4. Schedule Toggle */}
      <ScheduleToggle
        enabled={isPowerEnabled}
        onToggle={() => void toggleAllSchedules()}
        affectedDayCount={selectedDays.size}
        isLoading={isMutating || hookLoading}
      />

      {/* Confirmation banner */}
      <SchedulerConfirmation
        message={confirmMessage}
        isLoading={isApplying}
        variant={confirmMessage?.includes('Failed') ? 'error' : 'success'}
      />

      {/* Error state */}
      {error && (
        <div className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">
          Failed to load schedules: {error.message}
        </div>
      )}

      {/* 5. Manual Controls → Bottom Sheet */}
      <ManualControlsSheet
        selectedDay={selectedDay}
        selectedDays={selectedDays}
        powerSchedules={data?.power ?? []}
        alarmSchedules={data?.alarm ?? []}
        isLoading={isLoading}
        hasScheduleData={hasScheduleData}
        isApplying={isApplying}
        onApplyToOtherDays={(targetDays) => void applyToOtherDays(targetDays)}
      />

      {/* 6. Week Overview */}
      <ScheduleWeekOverview
        selectedDay={selectedDay}
        onDayChange={(day) => {
          setSelectedDay(day)
          setSelectedDays(new Set([day]))
        }}
      />
    </div>
  )
}

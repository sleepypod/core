'use client'

import { useCallback, useMemo, useState } from 'react'
import { Moon, Sun, X } from 'lucide-react'
import { useSchedule } from '@/src/hooks/useSchedule'
import { DaySelector, DAYS } from './DaySelector'
import type { DayOfWeek } from './DaySelector'
import { CurvePresets } from './CurvePresets'
import { CurveChart } from './CurveChart'
import { PhaseLegend } from './PhaseLegend'
import { TimePicker } from './TimePicker'
import { ScheduleToggle } from './ScheduleToggle'
import { SchedulerConfirmation } from './SchedulerConfirmation'
import { ManualControlsSheet } from './ManualControlsSheet'
import { ScheduleWeekOverview } from './ScheduleWeekOverview'
import { TemperatureSetPoints } from './TemperatureSetPoints'
import { trpc } from '@/src/utils/trpc'
import {
  generateSleepCurve,
  timeStringToMinutes,
} from '@/src/lib/sleepCurve/generate'
import type { CoolingIntensity, CurvePoint } from '@/src/lib/sleepCurve/types'
import type { SetPoint } from '@/src/lib/scheduleGrouping'
import { useScheduleActive } from '@/src/hooks/useScheduleActive'

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

  const { nextTime: nextScheduleTime } = useScheduleActive()
  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side })

  // Curve state — updated when presets are applied or times change
  const [bedtime, setBedtime] = useState('22:00')
  const [wakeTime, setWakeTime] = useState('07:00')
  const [intensity, setIntensity] = useState<CoolingIntensity>('balanced')
  const [minTempF, setMinTempF] = useState(68)
  const [maxTempF, setMaxTempF] = useState(86)

  // Custom AI curve points override the generated curve
  const [customPoints, setCustomPoints] = useState<CurvePoint[] | null>(null)

  // Week overview / group editing state
  const [overviewExpanded, setOverviewExpanded] = useState(true)
  const [editingGroup, setEditingGroup] = useState<{ days: DayOfWeek[], setPoints: SetPoint[] } | null>(null)

  const bedtimeMinutes = useMemo(() => timeStringToMinutes(bedtime), [bedtime])
  const wakeMinutes = useMemo(() => timeStringToMinutes(wakeTime), [wakeTime])

  const generatedPoints: CurvePoint[] = useMemo(
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

  // Convert editing group's set points to CurvePoints for chart display
  const groupCurve = useMemo<{ points: CurvePoint[], bedtimeMinutes: number, minTempF: number, maxTempF: number } | null>(() => {
    if (!editingGroup || editingGroup.setPoints.length === 0) return null

    const sp = editingGroup.setPoints
    const temps = sp.map(p => p.temperature)
    const min = Math.min(...temps)
    const max = Math.max(...temps)

    // Derive bedtime from first set point
    const firstTime = sp[0].time
    const btMin = timeStringToMinutes(firstTime)

    const withRelative = sp.map((p) => {
      let tMin = timeStringToMinutes(p.time) - btMin
      if (tMin < -120) tMin += 24 * 60
      return { ...p, minutesFromBedtime: tMin }
    }).sort((a, b) => a.minutesFromBedtime - b.minutesFromBedtime)

    const total = withRelative.length
    const points: CurvePoint[] = withRelative.map((p, i) => {
      const frac = total > 1 ? i / (total - 1) : 0
      const phase = frac < 0.1
        ? 'warmUp' as const
        : frac < 0.25
          ? 'coolDown' as const
          : frac < 0.55
            ? 'deepSleep' as const
            : frac < 0.75
              ? 'maintain' as const
              : frac < 0.9
                ? 'preWake' as const
                : 'wake' as const

      return {
        minutesFromBedtime: p.minutesFromBedtime,
        tempOffset: p.temperature - 80,
        phase,
      }
    })

    return { points, bedtimeMinutes: btMin, minTempF: min, maxTempF: max }
  }, [editingGroup])

  // Use group curve when editing, otherwise custom AI or generated
  const curvePoints = groupCurve?.points ?? customPoints ?? generatedPoints

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
      setCustomPoints(null) // Clear AI curve, back to generated
    },
    [],
  )

  // When AI curve is applied, convert set points to CurvePoints for chart
  const handleAICurveApplied = useCallback(
    (config: {
      setPoints: Array<{ time: string, tempF: number }>
      bedtime: string
      wakeTime: string
    }) => {
      const btMin = timeStringToMinutes(config.bedtime)
      const temps = config.setPoints.map(p => p.tempF)
      const min = Math.min(...temps)
      const max = Math.max(...temps)

      setBedtime(config.bedtime)
      setWakeTime(config.wakeTime)
      setMinTempF(min)
      setMaxTempF(max)

      // Compute minutesFromBedtime, then sort by that (not by time string — overnight wraps)
      const withRelative = config.setPoints.map((p) => {
        let tMin = timeStringToMinutes(p.time) - btMin
        if (tMin < -120) tMin += 24 * 60
        return { ...p, minutesFromBedtime: tMin }
      }).sort((a, b) => a.minutesFromBedtime - b.minutesFromBedtime)

      const totalMin = withRelative.length
      const points: CurvePoint[] = withRelative.map((p, i) => {
        const frac = i / (totalMin - 1)
        const phase = frac < 0.1
          ? 'warmUp' as const
          : frac < 0.25
            ? 'coolDown' as const
            : frac < 0.55
              ? 'deepSleep' as const
              : frac < 0.75
                ? 'maintain' as const
                : frac < 0.9
                  ? 'preWake' as const
                  : 'wake' as const

        return {
          minutesFromBedtime: p.minutesFromBedtime,
          tempOffset: p.tempF - 80,
          phase,
        }
      })

      setCustomPoints(points)
    },
    [],
  )

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* 1. Day Selector */}
      <DaySelector
        activeDay={selectedDay}
        onActiveDayChange={(day) => {
          setSelectedDay(day)
          if (editingGroup) {
            setEditingGroup(null)
            setSelectedDays(new Set([day]))
            setOverviewExpanded(true)
          }
        }}
        selectedDays={selectedDays}
        onSelectedDaysChange={setSelectedDays}
      />

      {/* Editing group banner */}
      {editingGroup && (
        <div className="flex items-center gap-2 rounded-lg bg-sky-500/10 px-3 py-2">
          <span className="text-xs text-sky-400">
            Editing
            {' '}
            {editingGroup.days.map(d => DAYS.find(x => x.key === d)?.label).join(', ')}
            {' '}
            schedule
          </span>
          <button
            onClick={() => {
              setEditingGroup(null)
              setOverviewExpanded(true)
            }}
            className="ml-auto rounded p-0.5 text-sky-400 transition-colors hover:bg-sky-500/20"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Week Overview — groups days by shared temperature curve */}
      <ScheduleWeekOverview
        expanded={overviewExpanded}
        onExpandedChange={setOverviewExpanded}
        onSelectGroup={(group) => {
          const daySet = new Set(group.days)
          setSelectedDays(daySet)
          setSelectedDay(group.days[0])
          setEditingGroup({ days: group.days, setPoints: group.setPoints })
          setOverviewExpanded(false)
        }}
      />

      {/* Curve Presets — hidden when editing a group */}
      {!editingGroup && (
        <CurvePresets
          side={side}
          selectedDay={selectedDay}
          selectedDays={selectedDays}
          onApplied={handlePresetApplied}
          onAICurveApplied={handleAICurveApplied}
        />
      )}

      {/* Time Pickers — always visible */}
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

      {/* Curve Chart */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <CurveChart
          points={curvePoints}
          bedtimeMinutes={groupCurve?.bedtimeMinutes ?? bedtimeMinutes}
          minTempF={groupCurve?.minTempF ?? minTempF}
          maxTempF={groupCurve?.maxTempF ?? maxTempF}
        />
        <div className="mt-2">
          <PhaseLegend />
        </div>
      </div>

      {/* 4. Temperature Set Points — inline editing */}
      <TemperatureSetPoints selectedDay={selectedDay} selectedDays={selectedDays} />

      {/* Confirmation banner */}
      <SchedulerConfirmation
        message={confirmMessage}
        isLoading={isApplying}
        variant={confirmMessage?.includes('Failed') ? 'error' : 'success'}
      />

      {/* Error state */}
      {error && (
        <div className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">
          Failed to load schedules:
          {' '}
          {error.message}
        </div>
      )}

      {/* Schedule Toggle */}
      <ScheduleToggle
        enabled={isPowerEnabled}
        onToggle={() => void toggleAllSchedules()}
        affectedDayCount={selectedDays.size}
        isLoading={isMutating || hookLoading}
        nextScheduleTime={nextScheduleTime}
      />

      {/* Manual Controls → Bottom Sheet */}
      <ManualControlsSheet
        selectedDay={selectedDay}
        selectedDays={selectedDays}
        alarmSchedules={data?.alarm ?? []}
        isLoading={isLoading}
        hasScheduleData={hasScheduleData}
        isApplying={isApplying}
        onApplyToOtherDays={targetDays => void applyToOtherDays(targetDays)}
      />

    </div>
  )
}

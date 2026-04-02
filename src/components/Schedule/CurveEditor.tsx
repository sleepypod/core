'use client'

import { useCallback, useMemo, useState } from 'react'
import { Moon, Sun, Snowflake, Flame, Check, Loader2 } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import {
  generateSleepCurve,
  curveToScheduleTemperatures,
  timeStringToMinutes,
} from '@/src/lib/sleepCurve/generate'
import type { CoolingIntensity, CurvePoint } from '@/src/lib/sleepCurve/types'
import { CurveChart } from './CurveChart'
import { TimePicker } from './TimePicker'
import { IntensitySelector } from './IntensitySelector'
import { TempStepper } from './TempStepper'
import { PhaseLegend } from './PhaseLegend'
import { ApplyDaySelector } from './ApplyDaySelector'
import type { DayOfWeek } from './DaySelector'

interface CurveEditorProps {
  side: 'left' | 'right'
}

const TODAY_INDEX = new Date().getDay()
const DAY_KEYS: DayOfWeek[] = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]

/**
 * Temperature curve editor with interactive chart, time pickers,
 * cooling profile presets, and schedule persistence via tRPC.
 *
 * Ports iOS SmartCurveView functionality to the browser.
 */
export function CurveEditor({ side }: CurveEditorProps) {
  // ── State ──
  const [bedtime, setBedtime] = useState('22:00')
  const [wakeTime, setWakeTime] = useState('07:00')
  const [intensity, setIntensity] = useState<CoolingIntensity>('balanced')
  const [minTempF, setMinTempF] = useState(68)
  const [maxTempF, setMaxTempF] = useState(86)
  const [activeDay, setActiveDay] = useState<DayOfWeek>(DAY_KEYS[TODAY_INDEX])
  const [selectedDays, setSelectedDays] = useState<Set<DayOfWeek>>(
    () => new Set([DAY_KEYS[TODAY_INDEX]]),
  )
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  // ── Generate curve ──
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

  // ── Sleep duration display ──
  const sleepDuration = useMemo(() => {
    let dur = wakeMinutes - bedtimeMinutes
    if (dur <= 0) dur += 24 * 60
    const h = Math.floor(dur / 60)
    const m = dur % 60
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }, [bedtimeMinutes, wakeMinutes])

  // ── tRPC mutations ──
  const utils = trpc.useUtils()

  const createTempSchedule = trpc.schedules.createTemperatureSchedule.useMutation()
  const deleteTempSchedule = trpc.schedules.deleteTemperatureSchedule.useMutation()
  const createPowerSchedule = trpc.schedules.createPowerSchedule.useMutation()
  const deletePowerSchedule = trpc.schedules.deletePowerSchedule.useMutation()

  // ── Day toggle ──
  const handleDayToggle = useCallback((day: DayOfWeek) => {
    setSelectedDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) {
        // Don't allow deselecting the last day
        if (next.size > 1) next.delete(day)
      }
      else {
        next.add(day)
      }
      return next
    })
  }, [])

  // ── Save curve to selected days ──
  const handleApply = useCallback(async () => {
    setSaveStatus('saving')

    try {
      const scheduleTemps = curveToScheduleTemperatures(curvePoints, bedtimeMinutes)
      const daysArray = Array.from(selectedDays)

      for (const day of daysArray) {
        // Fetch existing schedules for this day to clear them
        const existing = await utils.schedules.getByDay.fetch({ side, dayOfWeek: day })

        // Delete existing temperature schedules for this day
        const deletePromises = [
          ...existing.temperature.map((s: { id: number }) =>
            deleteTempSchedule.mutateAsync({ id: s.id }),
          ),
          ...existing.power.map((s: { id: number }) =>
            deletePowerSchedule.mutateAsync({ id: s.id }),
          ),
        ]
        await Promise.all(deletePromises)

        // Create new temperature schedule entries
        const createPromises = Object.entries(scheduleTemps).map(([time, temperature]) =>
          createTempSchedule.mutateAsync({
            side,
            dayOfWeek: day,
            time,
            temperature: Math.max(55, Math.min(110, temperature)),
            enabled: true,
          }),
        )

        // Create power schedule
        createPromises.push(
          createPowerSchedule.mutateAsync({
            side,
            dayOfWeek: day,
            onTime: bedtime,
            offTime: wakeTime,
            onTemperature: Math.max(55, Math.min(110, 80 + curvePoints[0].tempOffset)),
            enabled: true,
          }) as Promise<unknown> as Promise<{ id: number }>,
        )

        await Promise.all(createPromises)
      }

      // Invalidate queries
      await utils.schedules.invalidate()

      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    }
    catch (err) {
      console.error('Failed to apply curve:', err)
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    }
  }, [
    curvePoints,
    bedtimeMinutes,
    bedtime,
    wakeTime,
    selectedDays,
    side,
    utils,
    createTempSchedule,
    deleteTempSchedule,
    createPowerSchedule,
    deletePowerSchedule,
  ])

  // ── Temp constraints ──
  const handleMinTempChange = useCallback(
    (v: number) => setMinTempF(Math.min(v, maxTempF - 4)),
    [maxTempF],
  )
  const handleMaxTempChange = useCallback(
    (v: number) => setMaxTempF(Math.max(v, minTempF + 4)),
    [minTempF],
  )

  return (
    <div className="space-y-5">
      {/* ── Time Pickers ── */}
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

      {/* Sleep duration badge */}
      <div className="flex justify-center">
        <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-400">
          {sleepDuration}
          {' '}
          sleep window
        </span>
      </div>

      {/* ── Cooling Intensity ── */}
      <IntensitySelector value={intensity} onChange={setIntensity} />

      {/* ── Temperature Range ── */}
      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Temperature Range
        </div>
        <div className="space-y-2">
          <TempStepper
            label="Coolest"
            icon={<Snowflake size={14} />}
            value={minTempF}
            onChange={handleMinTempChange}
            min={55}
            max={85}
            accentClass="text-blue-400"
          />
          <TempStepper
            label="Warmest"
            icon={<Flame size={14} />}
            value={maxTempF}
            onChange={handleMaxTempChange}
            min={70}
            max={110}
            accentClass="text-orange-400"
          />
        </div>
      </div>

      {/* ── Curve Chart ── */}
      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
          Temperature Curve Preview
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

      {/* ── Day Selector ── */}
      <ApplyDaySelector
        selectedDays={selectedDays}
        onToggle={handleDayToggle}
        activeDay={activeDay}
        onActiveDayChange={setActiveDay}
      />

      {/* ── Apply Button ── */}
      <button
        type="button"
        onClick={handleApply}
        disabled={saveStatus === 'saving'}
        className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-sm font-semibold transition-all duration-200 ${
          saveStatus === 'saved'
            ? 'bg-emerald-500/20 text-emerald-400'
            : saveStatus === 'error'
              ? 'bg-red-500/20 text-red-400'
              : 'bg-sky-500 text-white hover:bg-sky-600 active:scale-[0.98]'
        } disabled:opacity-60`}
      >
        {saveStatus === 'saving'
          ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Applying...
              </>
            )
          : saveStatus === 'saved'
            ? (
                <>
                  <Check size={16} />
                  Applied!
                </>
              )
            : saveStatus === 'error'
              ? (
                  'Failed — tap to retry'
                )
              : (
                  `Apply to ${selectedDays.size} ${selectedDays.size === 1 ? 'day' : 'days'}`
                )}
      </button>
    </div>
  )
}

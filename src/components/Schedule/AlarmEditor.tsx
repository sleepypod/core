'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, Loader2, Play, Square, Trash2 } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, DayPicker, InlineError, Modal, Pill, SegmentedControl, Slider, Stepper } from '@/src/components/ds'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import type { SideSelection } from '@/src/providers/SideProvider'
import type { DayOfWeek } from '@/src/lib/scheduleTime'
import { formatTime12h } from '@/src/lib/scheduleTime'
import { displayToSetpointF, setpointFToDisplay } from '@/src/lib/tempUtils'
import { FIXED_INTENSITY, FIXED_PATTERN } from '@/src/lib/vibrationPatterns'
import type { AlarmGroup } from './AlarmCard'
import { DAY_ORDER, DAY_PICKER_LABELS, WEEKDAYS, WEEKENDS, daysToIndexes, indexesToDays, sameDays } from './scheduleFormat'

type Side = 'left' | 'right'
type Pattern = 'rise' | 'double'

interface AlarmEditorProps {
  open: boolean
  onClose: () => void
  /** Side whose alarms are listed (an existing group belongs to it). */
  side: Side
  /** Side selection a new alarm starts with. */
  defaultSide?: SideSelection
  /** When provided, editor opens in edit mode for this group. */
  existingGroup?: AlarmGroup | null
  /** Called after a successful save so the parent can refetch. */
  onSaved?: () => void
  /** Delete goes through the parent's confirmation dialog. */
  onRequestDelete?: (group: AlarmGroup) => void
}

const DEFAULT_TIME = '07:00'
const DEFAULT_DURATION = 30
const DEFAULT_TEMP = 75
const MIN_DURATION = 10
const MAX_DURATION = 180

const MIN_TEMP = 55
const MAX_TEMP = 110

const WAKE_WINDOW_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '10', label: '10' },
  { value: '15', label: '15' },
  { value: '20', label: '20' },
  { value: '30', label: '30 min' },
] as const
type WakeWindowOption = typeof WAKE_WINDOW_OPTIONS[number]['value']

const QUICK_PICKS: Array<{ label: string, days: DayOfWeek[] }> = [
  { label: 'Weekdays', days: WEEKDAYS },
  { label: 'Weekends', days: WEEKENDS },
  { label: 'Every day', days: DAY_ORDER },
]

/** `HH:mm` moved by `minutes`, wrapping around midnight. */
function shiftTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const t = (((h * 60 + m + minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/**
 * Alarm editor (Dialog on desktop, Sheet on phones).
 * - Each saved alarm produces one row per selected day × side (same time/pattern/intensity/duration/temp).
 * - "Test" fires `device.setAlarm` immediately so the user can feel it; "Stop" clears it.
 * - On save, delete-then-create: removes existing rows for this group then writes new ones.
 */
export function AlarmEditor({
  open,
  onClose,
  side,
  defaultSide = side,
  existingGroup = null,
  onSaved,
  onRequestDelete,
}: AlarmEditorProps) {
  const isEdit = existingGroup !== null
  const { unit } = useTemperatureUnit()
  const { leftName, rightName } = useSideNames()
  const minDisplayTemp = Math.round(setpointFToDisplay(MIN_TEMP, unit) ?? MIN_TEMP)
  const maxDisplayTemp = Math.round(setpointFToDisplay(MAX_TEMP, unit) ?? MAX_TEMP)
  const defaultDisplayTemp = Math.round(setpointFToDisplay(DEFAULT_TEMP, unit) ?? DEFAULT_TEMP)

  const [days, setDays] = useState<Set<DayOfWeek>>(new Set())
  const [time, setTime] = useState(DEFAULT_TIME)
  const [targetSide, setTargetSide] = useState<SideSelection>(defaultSide)
  const [pattern, setPattern] = useState<Pattern>(FIXED_PATTERN)
  const [intensity, setIntensity] = useState(FIXED_INTENSITY)
  const [duration, setDuration] = useState(DEFAULT_DURATION)
  const [displayTemperature, setDisplayTemperature] = useState(defaultDisplayTemp)
  const [wakeWindow, setWakeWindow] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  // Reset local state when opening
  useEffect(() => {
    if (!open) return
    /* eslint-disable react-hooks/set-state-in-effect */
    if (existingGroup) {
      setDays(new Set(existingGroup.days))
      setTime(existingGroup.time)
      setTargetSide(side)
      setPattern(existingGroup.vibrationPattern)
      setIntensity(existingGroup.vibrationIntensity)
      setDuration(existingGroup.duration)
      setDisplayTemperature(Math.round(setpointFToDisplay(existingGroup.alarmTemperature, unit) ?? existingGroup.alarmTemperature))
      setWakeWindow(existingGroup.wakeWindow)
    }
    else {
      setDays(new Set())
      setTime(DEFAULT_TIME)
      setTargetSide(defaultSide)
      setPattern(FIXED_PATTERN)
      setIntensity(FIXED_INTENSITY)
      setDuration(DEFAULT_DURATION)
      setDisplayTemperature(defaultDisplayTemp)
      setWakeWindow(0)
    }
    setSaveError(null)
    setTesting(false)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, existingGroup, side, defaultSide, unit, defaultDisplayTemp])

  const batchUpdate = trpc.schedules.batchUpdate.useMutation()
  const testAlarm = trpc.device.setAlarm.useMutation()
  const clearAlarm = trpc.device.clearAlarm.useMutation()
  const utils = trpc.useUtils()

  const isMutating = batchUpdate.isPending
  const sides = useMemo<Side[]>(() => (targetSide === 'both' ? ['left', 'right'] : [targetSide]), [targetSide])

  const handleTest = useCallback(async () => {
    try {
      await Promise.all(sides.map(s => testAlarm.mutateAsync({ side: s, vibrationIntensity: intensity, vibrationPattern: pattern, duration })))
      setTesting(true)
    }
    catch {
      // testAlarm.error renders below
    }
  }, [testAlarm, sides, intensity, pattern, duration])

  const handleStopTest = useCallback(() => {
    for (const s of sides) clearAlarm.mutate({ side: s })
    setTesting(false)
  }, [clearAlarm, sides])

  const handleSave = useCallback(async () => {
    if (days.size === 0) {
      setSaveError('Pick at least one day')
      return
    }
    setSaveError(null)

    const targetDays = Array.from(days)
    const temperatureF = Math.round(displayToSetpointF(displayTemperature, unit) ?? DEFAULT_TEMP)
    // Preserve enabled state when editing a paused alarm; new alarms default to enabled.
    const enabled = existingGroup?.enabled ?? true
    const creates = sides.flatMap(s => targetDays.map(dayOfWeek => ({
      side: s,
      dayOfWeek,
      time,
      vibrationIntensity: intensity,
      vibrationPattern: pattern,
      duration,
      alarmTemperature: temperatureF,
      wakeWindow,
      enabled,
    })))

    try {
      await batchUpdate.mutateAsync({
        deletes: { alarm: existingGroup?.ids ?? [] },
        creates: { alarm: creates },
      })
      void utils.schedules.getAll.invalidate()
      void utils.schedules.getByDay.invalidate()
      onSaved?.()
      onClose()
    }
    catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save alarm')
    }
  }, [days, sides, time, intensity, pattern, duration, displayTemperature, wakeWindow, unit, existingGroup, batchUpdate, utils, onSaved, onClose])

  const clock = formatTime12h(time)
  const [clockDigits, clockPeriod] = clock.split(' ')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit alarm' : 'New alarm'}
      icon={Bell}
      iconClassName="text-warn"
      width={520}
      footer={(
        <>
          {testing
            ? (
                <Button icon={Square} onClick={handleStopTest} disabled={clearAlarm.isPending}>Stop</Button>
              )
            : (
                <Button icon={Play} onClick={() => void handleTest()} disabled={testAlarm.isPending}>Test</Button>
              )}
          {isEdit && existingGroup && onRequestDelete && (
            <Button variant="danger" icon={Trash2} onClick={() => onRequestDelete(existingGroup)} disabled={isMutating}>
              Delete
            </Button>
          )}
          <div className="ml-auto flex gap-2.5">
            <Button onClick={onClose} disabled={isMutating}>Cancel</Button>
            <Button variant="primary" onClick={() => void handleSave()} disabled={isMutating || days.size === 0}>
              {isMutating && <Loader2 size={14} className="animate-spin" />}
              Save alarm
            </Button>
          </div>
        </>
      )}
    >
      <div className="flex flex-wrap items-end gap-3.5">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-fg-2">Wake at</span>
          {/* Big mono readout; an invisible native time input on top opens the OS picker. */}
          <span className="relative rounded-ctl focus-within:outline focus-within:outline-1 focus-within:outline-offset-4 focus-within:outline-fg-3">
            <span className="font-mono text-[44px] font-light leading-none" aria-hidden>
              {clockDigits}
              <span className="text-xl text-fg-2">{` ${clockPeriod ?? ''}`}</span>
            </span>
            <input
              type="time"
              aria-label="Wake at"
              value={time}
              onChange={e => e.target.value && setTime(e.target.value)}
              disabled={isMutating}
              className="absolute inset-0 m-0 w-full min-w-0 cursor-pointer appearance-none opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:m-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:p-0"
            />
          </span>
        </label>
        <SegmentedControl
          className="ml-auto"
          ariaLabel="Alarm side"
          value={targetSide}
          onChange={setTargetSide}
          options={[
            { value: 'left', label: leftName },
            { value: 'right', label: rightName },
            { value: 'both', label: 'Both' },
          ]}
        />
      </div>

      <div className="flex flex-col gap-2.5">
        <span className="text-xs text-fg-2">Repeat</span>
        <DayPicker
          value={daysToIndexes(days)}
          onChange={v => setDays(new Set(indexesToDays(v)))}
          labels={DAY_PICKER_LABELS}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-fg-2">Quick pick</span>
          {QUICK_PICKS.map(q => (
            <Pill key={q.label} selected={sameDays(days, q.days)} onClick={() => setDays(new Set(q.days))}>
              {q.label}
            </Pill>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-line pt-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex-1 text-sm">Wake window</span>
          <SegmentedControl<WakeWindowOption>
            size="sm"
            ariaLabel="Wake window"
            value={String(wakeWindow) as WakeWindowOption}
            onChange={v => setWakeWindow(Number(v))}
            options={WAKE_WINDOW_OPTIONS}
          />
        </div>
        <span className="text-xs leading-[1.4] text-fg-3">
          {wakeWindow > 0
            ? `Wakes you up to ${wakeWindow} min early, the first time you move after ${formatTime12h(shiftTime(time, -wakeWindow))}. Otherwise it goes off at ${clock}.`
            : 'Goes off at the set time.'}
        </span>
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <span className="text-xs text-fg-2">Vibration</span>
        <div className="flex items-center gap-3">
          <span className="w-[76px] shrink-0 text-sm">Pattern</span>
          <SegmentedControl
            ariaLabel="Vibration pattern"
            value={pattern}
            onChange={setPattern}
            options={[{ value: 'rise', label: 'Rise' }, { value: 'double', label: 'Double' }]}
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="w-[76px] shrink-0 text-sm">Intensity</span>
          <Slider value={intensity} onChange={setIntensity} min={1} max={100} label="Vibration intensity" />
          <span className="w-9 text-right font-mono text-xs">{`${intensity}%`}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-[76px] shrink-0 text-sm">Duration</span>
          <Slider value={duration} onChange={setDuration} min={MIN_DURATION} max={MAX_DURATION} label="Vibration duration" />
          <span className="w-9 text-right font-mono text-xs">{`${duration} s`}</span>
        </div>
        <span className="text-xs leading-[1.4] text-fg-3">
          Pod 5 covers ignore pattern and intensity — duration is what you feel.
        </span>
      </div>

      <div className="flex items-center gap-3 border-t border-line pt-3.5">
        <span className="flex-1 text-sm">Bed temperature at wake</span>
        <Stepper
          value={displayTemperature}
          onChange={setDisplayTemperature}
          min={minDisplayTemp}
          max={maxDisplayTemp}
          label="bed temperature at wake"
        />
      </div>

      {testAlarm.error && <InlineError>{testAlarm.error.message}</InlineError>}
      {saveError && <InlineError>{saveError}</InlineError>}
    </Modal>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import { X, Vibrate, Bell, Loader2, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { trpc } from '@/src/utils/trpc'
import { FIXED_INTENSITY, FIXED_PATTERN, VIBRATION_PRESETS } from '@/src/lib/vibrationPatterns'
import { DAYS, type DayOfWeek } from './DaySelector'
import { TimeInput } from './TimeInput'
import type { AlarmGroup } from './AlarmCard'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { displayToSetpointF, setpointFToDisplay } from '@/src/lib/tempUtils'

type Side = 'left' | 'right'

interface AlarmEditorProps {
  open: boolean
  onClose: () => void
  side: Side
  /** When provided, editor opens in edit mode for this group. */
  existingGroup?: AlarmGroup | null
  /** Called after a successful save so the parent can refetch. */
  onSaved?: () => void
}

const DEFAULT_TIME = '07:00'
const DEFAULT_DURATION = 30
const DEFAULT_TEMP = 75

const MIN_TEMP = 55
const MAX_TEMP = 110

/**
 * Full-screen editor for creating or editing an alarm.
 * - Each saved alarm produces one row per selected day (same time/pattern/intensity/duration/temp).
 * - "Test" fires `device.setAlarm` immediately so the user can feel the pattern.
 * - On save, delete-then-create: removes existing rows for this group then writes new ones.
 */
export function AlarmEditor({
  open,
  onClose,
  side,
  existingGroup = null,
  onSaved,
}: AlarmEditorProps) {
  const isEdit = existingGroup !== null
  const { unit } = useTemperatureUnit()
  const minDisplayTemp = Math.round(setpointFToDisplay(MIN_TEMP, unit) ?? MIN_TEMP)
  const maxDisplayTemp = Math.round(setpointFToDisplay(MAX_TEMP, unit) ?? MAX_TEMP)
  const defaultDisplayTemp = Math.round(setpointFToDisplay(DEFAULT_TEMP, unit) ?? DEFAULT_TEMP)

  const [days, setDays] = useState<Set<DayOfWeek>>(new Set())
  const [time, setTime] = useState(DEFAULT_TIME)
  const [duration, setDuration] = useState(DEFAULT_DURATION)
  const [displayTemperature, setDisplayTemperature] = useState(defaultDisplayTemp)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Reset local state when opening
  useEffect(() => {
    if (!open) return
    /* eslint-disable react-hooks/set-state-in-effect */
    if (existingGroup) {
      setDays(new Set(existingGroup.days))
      setTime(existingGroup.time)
      setDuration(existingGroup.duration)
      setDisplayTemperature(Math.round(setpointFToDisplay(existingGroup.alarmTemperature, unit) ?? existingGroup.alarmTemperature))
    }
    else {
      setDays(new Set())
      setTime(DEFAULT_TIME)
      setDuration(DEFAULT_DURATION)
      setDisplayTemperature(defaultDisplayTemp)
    }
    setSaveError(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, existingGroup, unit, defaultDisplayTemp])

  // Lock body scroll
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const batchUpdate = trpc.schedules.batchUpdate.useMutation()
  const testAlarm = trpc.device.setAlarm.useMutation()
  const clearAlarm = trpc.device.clearAlarm.useMutation()
  const utils = trpc.useUtils()

  const isMutating = batchUpdate.isPending

  const toggleDay = useCallback((day: DayOfWeek) => {
    setDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })
  }, [])

  const applyPreset = useCallback((preset: typeof VIBRATION_PRESETS[number]) => {
    setDuration(preset.duration)
  }, [])

  const handleTest = useCallback(() => {
    testAlarm.mutate({ side, vibrationIntensity: FIXED_INTENSITY, vibrationPattern: FIXED_PATTERN, duration })
  }, [testAlarm, side, duration])

  const handleStopTest = useCallback(() => {
    clearAlarm.mutate({ side })
  }, [clearAlarm, side])

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
    const creates = targetDays.map(dayOfWeek => ({
      side,
      dayOfWeek,
      time,
      vibrationIntensity: FIXED_INTENSITY,
      vibrationPattern: FIXED_PATTERN,
      duration,
      alarmTemperature: temperatureF,
      enabled,
    }))

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
  }, [days, side, time, duration, displayTemperature, unit, existingGroup, batchUpdate, utils, onSaved, onClose])

  const handleDelete = useCallback(async () => {
    if (!existingGroup) return
    setSaveError(null)
    try {
      await batchUpdate.mutateAsync({
        deletes: { alarm: existingGroup.ids },
      })
      void utils.schedules.getAll.invalidate()
      void utils.schedules.getByDay.invalidate()
      onSaved?.()
      onClose()
    }
    catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to delete alarm')
    }
  }, [existingGroup, batchUpdate, utils, onSaved, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <button
          onClick={onClose}
          disabled={isMutating}
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 active:bg-zinc-800 disabled:opacity-50"
          aria-label="Close"
        >
          <X size={18} />
        </button>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Bell size={14} className="text-amber-400" />
          {isEdit ? 'Edit Alarm' : 'New Alarm'}
        </h2>
        <button
          onClick={() => void handleSave()}
          disabled={isMutating || days.size === 0}
          className="flex h-9 items-center gap-1.5 rounded-full bg-sky-500 px-4 text-xs font-semibold text-white active:bg-sky-600 disabled:opacity-50"
        >
          {isMutating ? <Loader2 size={12} className="animate-spin" /> : null}
          Save
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Time */}
        <div>
          <TimeInput label="Wake at" value={time} onChange={setTime} disabled={isMutating} />
        </div>

        {/* Days */}
        <div>
          <span className="mb-2 block text-xs font-medium text-zinc-400">Repeat</span>
          <div className="flex items-center justify-between gap-0.5 sm:gap-1">
            {DAYS.map(({ key, short, label }) => {
              const selected = days.has(key)
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleDay(key)}
                  aria-label={label}
                  aria-pressed={selected}
                  className={clsx(
                    'flex h-11 w-11 items-center justify-center rounded-full text-[13px] font-semibold transition-all',
                    selected
                      ? 'bg-sky-500 text-white'
                      : 'bg-zinc-900 text-zinc-500 active:bg-zinc-800',
                  )}
                >
                  {short}
                </button>
              )
            })}
          </div>
        </div>

        {/* Presets */}
        <div>
          <span className="mb-2 block text-xs font-medium text-zinc-400">Quick pick</span>
          <div className="flex flex-wrap gap-1.5">
            {VIBRATION_PRESETS.map(p => (
              <button
                key={p.name}
                onClick={() => applyPreset(p)}
                className={clsx(
                  'rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors',
                  duration === p.duration
                    ? 'border-sky-500/60 bg-sky-500/15 text-sky-300'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-400 active:bg-zinc-800',
                )}
              >
                {p.name}
                {' '}
                <span className="text-[9px] opacity-60">
                  {p.duration}
                  s
                </span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-zinc-600">
            Intensity and pattern are firmware-clamped on Pod 5 — only duration affects the buzz.
          </p>
        </div>

        {/* Duration */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Duration</span>
            <span className="text-xs font-medium text-white">
              {duration}
              s
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={180}
            step={1}
            value={duration}
            onChange={e => setDuration(parseInt(e.target.value, 10))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-sky-500 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500"
          />
          <div className="flex justify-between text-[10px] text-zinc-600">
            <span>1s</span>
            <span>180s</span>
          </div>
        </div>

        {/* Temperature */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Bed temperature at wake</span>
            <span className="text-xs font-medium text-white">
              {displayTemperature}
              °
              {unit}
            </span>
          </div>
          <input
            type="range"
            min={minDisplayTemp}
            max={maxDisplayTemp}
            step={1}
            value={displayTemperature}
            onChange={e => setDisplayTemperature(parseInt(e.target.value, 10))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-sky-500 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500"
          />
          <div className="flex justify-between text-[10px] text-zinc-600">
            <span>
              {minDisplayTemp}
              °
              {unit}
            </span>
            <span>
              {maxDisplayTemp}
              °
              {unit}
            </span>
          </div>
        </div>

        {/* Test row */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-3">
          <div className="flex items-center gap-2">
            <Vibrate size={14} className="text-amber-400" />
            <p className="flex-1 text-xs text-zinc-300">
              Test this pattern on the
              {' '}
              {side}
              {' '}
              side
            </p>
            {testAlarm.isPending && (
              <Loader2 size={12} className="animate-spin text-zinc-400" />
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              onClick={handleTest}
              disabled={testAlarm.isPending}
              className="flex flex-1 min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-sky-500/20 text-xs font-medium text-sky-400 transition-colors active:bg-sky-500/30 disabled:opacity-50"
            >
              <Vibrate size={12} />
              Test
            </button>
            <button
              onClick={handleStopTest}
              disabled={clearAlarm.isPending}
              className="flex flex-1 min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-zinc-800 text-xs font-medium text-zinc-300 transition-colors active:bg-zinc-700 disabled:opacity-50"
            >
              Stop
            </button>
          </div>
          {testAlarm.error && (
            <p className="mt-1.5 text-[11px] text-red-400">{testAlarm.error.message}</p>
          )}
        </div>

        {/* Delete (edit mode) */}
        {isEdit && (
          <button
            onClick={() => void handleDelete()}
            disabled={isMutating}
            className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl border border-red-500/20 bg-red-500/5 text-sm font-medium text-red-400 active:bg-red-500/10 disabled:opacity-50"
          >
            <Trash2 size={14} />
            Delete alarm
          </button>
        )}

        {saveError && (
          <p className="text-xs text-red-400">{saveError}</p>
        )}
      </div>
    </div>
  )
}

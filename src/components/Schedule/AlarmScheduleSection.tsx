'use client'

import { useEffect, useRef, useState } from 'react'
import { Bell, BellOff, Vibrate, Timer, Waves } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { TimeInput, formatTime12h } from './TimeInput'
import type { DayOfWeek } from './DaySelector'
import clsx from 'clsx'

interface AlarmSchedule {
  id: number
  side: string
  dayOfWeek: string
  time: string
  vibrationIntensity: number
  vibrationPattern: string
  duration: number
  alarmTemperature: number
  enabled: boolean
}

interface AlarmScheduleSectionProps {
  schedules: AlarmSchedule[]
  selectedDay: DayOfWeek
  isLoading: boolean
}

const TEMP_MIN = 55
const TEMP_MAX = 110
const INTENSITY_MIN = 1
const INTENSITY_MAX = 100
const DURATION_OPTIONS = [10, 20, 30, 60, 90, 120, 150, 180]
const PATTERN_OPTIONS = [
  { value: 'rise', label: 'Rise', description: 'Gradually increases' },
  { value: 'double', label: 'Double', description: 'Pulsing pattern' },
] as const

import { VIBRATION_PRESETS } from '@/src/lib/vibrationPatterns'

/**
 * Alarm schedule section with time, vibration intensity slider,
 * pattern selector, duration, temperature, and enable/disable toggle.
 * Matches iOS alarm configuration and free-sleep AlarmAccordion features.
 */
export function AlarmScheduleSection({ schedules, selectedDay, isLoading }: AlarmScheduleSectionProps) {
  const { side } = useSide()
  const utils = trpc.useUtils()

  const schedule = schedules.find(s => s.side === side && s.dayOfWeek === selectedDay)
  const hasSchedule = !!schedule

  // Local state for new alarm creation
  const [newTime, setNewTime] = useState('07:00')
  const [newIntensity, setNewIntensity] = useState(50)
  const [newPattern, setNewPattern] = useState<'rise' | 'double'>('rise')
  const [newDuration, setNewDuration] = useState(30)
  const [newAlarmTemp, setNewAlarmTemp] = useState(80)
  const [expanded, setExpanded] = useState(false)

  // Local slider state for existing alarm (avoids mutation per drag tick)
  const [localIntensity, setLocalIntensity] = useState(schedule?.vibrationIntensity ?? 50)
  const [localAlarmTemp, setLocalAlarmTemp] = useState(schedule?.alarmTemperature ?? 80)
  const intensityCommitRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const alarmTempCommitRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Sync local slider state when the schedule identity or values change.
  // Keying on schedule?.id ensures state resets when switching sides/days.
  useEffect(() => {
    if (schedule) {
      setLocalIntensity(schedule.vibrationIntensity)
      setLocalAlarmTemp(schedule.alarmTemperature)
    }
  }, [schedule?.id, schedule?.vibrationIntensity, schedule?.alarmTemperature])

  // Clean up debounce timers on unmount
  useEffect(() => {
    return () => {
      clearTimeout(intensityCommitRef.current)
      clearTimeout(alarmTempCommitRef.current)
    }
  }, [])

  const createMutation = trpc.schedules.createAlarmSchedule.useMutation({
    onSuccess: () => utils.schedules.getAll.invalidate(),
  })

  const updateMutation = trpc.schedules.updateAlarmSchedule.useMutation({
    onSuccess: () => utils.schedules.getAll.invalidate(),
  })

  const deleteMutation = trpc.schedules.deleteAlarmSchedule.useMutation({
    onSuccess: () => utils.schedules.getAll.invalidate(),
  })

  const isMutating = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending

  function handleCreate() {
    createMutation.mutate({
      side,
      dayOfWeek: selectedDay,
      time: newTime,
      vibrationIntensity: newIntensity,
      vibrationPattern: newPattern,
      duration: newDuration,
      alarmTemperature: newAlarmTemp,
      enabled: true,
    })
  }

  function handleToggleEnabled() {
    if (!schedule) return
    updateMutation.mutate({
      id: schedule.id,
      enabled: !schedule.enabled,
    })
  }

  function handleUpdateTime(time: string) {
    if (!schedule) return
    updateMutation.mutate({ id: schedule.id, time })
  }

  function handleUpdateIntensity(intensity: number) {
    if (!schedule) return
    updateMutation.mutate({ id: schedule.id, vibrationIntensity: intensity })
  }

  function handleUpdatePattern(pattern: 'rise' | 'double') {
    if (!schedule) return
    updateMutation.mutate({ id: schedule.id, vibrationPattern: pattern })
  }

  function handleUpdateDuration(duration: number) {
    if (!schedule) return
    updateMutation.mutate({ id: schedule.id, duration })
  }

  function handleUpdateAlarmTemp(temp: number) {
    if (!schedule) return
    updateMutation.mutate({ id: schedule.id, alarmTemperature: temp })
  }

  function handleDelete() {
    if (!schedule) return
    deleteMutation.mutate({ id: schedule.id })
  }

  if (isLoading) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="flex items-center gap-2 text-zinc-500">
          <Bell size={16} />
          <span className="text-sm font-medium">Vibration Alarm</span>
        </div>
        <div className="mt-3 h-20 animate-pulse rounded-lg bg-zinc-800" />
      </div>
    )
  }

  // No alarm — show create form
  if (!hasSchedule) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center gap-2">
          <Bell size={16} className="text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">Vibration Alarm</span>
        </div>

        <div className="space-y-3">
          <TimeInput label="Alarm Time" value={newTime} onChange={setNewTime} />

          {/* Preset quick-select */}
          <div>
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Presets</span>
            <div className="flex flex-wrap gap-1.5">
              {VIBRATION_PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  onClick={() => {
                    setNewIntensity(preset.intensity)
                    setNewPattern(preset.pattern)
                    setNewDuration(preset.duration)
                  }}
                  className={clsx(
                    'rounded-lg px-2.5 min-h-[44px] text-[11px] font-medium transition-colors sm:px-3 sm:text-xs',
                    newIntensity === preset.intensity && newPattern === preset.pattern && newDuration === preset.duration
                      ? 'bg-sky-500/20 text-sky-400 ring-1 ring-sky-500/40'
                      : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'
                  )}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>

          {/* Vibration Intensity */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-400">Vibration Intensity</span>
              <span className="text-xs font-medium text-white">{newIntensity}%</span>
            </div>
            <input
              type="range"
              min={INTENSITY_MIN}
              max={INTENSITY_MAX}
              step={1}
              value={newIntensity}
              onChange={(e) => setNewIntensity(parseInt(e.target.value, 10))}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-sky-500 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600">
              <span>{INTENSITY_MIN}%</span>
              <span>{INTENSITY_MAX}%</span>
            </div>
          </div>

          {/* Pattern selector */}
          <div>
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Pattern</span>
            <div className="grid grid-cols-2 gap-2">
              {PATTERN_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setNewPattern(opt.value)}
                  className={clsx(
                    'flex flex-col items-center gap-0.5 rounded-lg border min-h-[44px] py-2.5 text-xs font-medium transition-colors',
                    newPattern === opt.value
                      ? 'border-sky-500/50 bg-sky-500/10 text-sky-400'
                      : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 active:bg-zinc-700'
                  )}
                >
                  <Waves size={14} />
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Duration selector */}
          <div>
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Duration</span>
            <div className="flex flex-wrap gap-1.5">
              {DURATION_OPTIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => setNewDuration(d)}
                  className={clsx(
                    'rounded-lg px-2.5 min-h-[44px] text-[11px] font-medium transition-colors sm:px-3 sm:text-xs',
                    newDuration === d
                      ? 'bg-sky-500/20 text-sky-400 ring-1 ring-sky-500/40'
                      : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'
                  )}
                >
                  {d}s
                </button>
              ))}
            </div>
          </div>

          {/* Alarm Temperature */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-400">Alarm Temperature</span>
              <span className="text-xs font-medium text-white">{newAlarmTemp}°F</span>
            </div>
            <input
              type="range"
              min={TEMP_MIN}
              max={TEMP_MAX}
              step={1}
              value={newAlarmTemp}
              onChange={(e) => setNewAlarmTemp(parseInt(e.target.value, 10))}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-sky-500 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600">
              <span>{TEMP_MIN}°F</span>
              <span>{TEMP_MAX}°F</span>
            </div>
          </div>

          <button
            onClick={handleCreate}
            disabled={isMutating}
            className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-lg bg-sky-500/20 py-2.5 text-sm font-medium text-sky-400 transition-colors active:bg-sky-500/30 disabled:opacity-50"
          >
            <Bell size={14} />
            {isMutating ? 'Creating...' : 'Create Alarm'}
          </button>
        </div>

        {createMutation.error && (
          <p className="mt-2 text-xs text-red-400">{createMutation.error.message}</p>
        )}
      </div>
    )
  }

  // Alarm exists — show summary + expandable controls
  return (
    <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
      {/* Header with toggle */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {schedule.enabled
            ? <Bell size={16} className="text-sky-400" />
            : <BellOff size={16} className="text-zinc-500" />
          }
          <span className="text-sm font-medium text-zinc-300">Vibration Alarm</span>
        </div>
        <button
          onClick={handleToggleEnabled}
          disabled={isMutating}
          className="flex min-h-[44px] min-w-[48px] items-center justify-center disabled:opacity-50"
          aria-label={schedule.enabled ? 'Disable alarm' : 'Enable alarm'}
        >
          <span className={`relative h-7 w-12 rounded-full transition-colors ${schedule.enabled ? 'bg-sky-500' : 'bg-zinc-700'}`}>
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${schedule.enabled ? 'translate-x-5' : 'translate-x-0.5'}`}
            />
          </span>
        </button>
      </div>

      {/* Alarm summary */}
      <div className="mb-3 flex items-center gap-2 rounded-xl bg-zinc-800/60 px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3">
        <div className="min-w-0 flex-1">
          <span className="text-base font-semibold text-white sm:text-lg">{formatTime12h(schedule.time)}</span>
          <span className="block truncate text-[9px] text-zinc-500 sm:text-[10px]">
            {schedule.vibrationPattern === 'rise' ? 'Rise' : 'Double'} · {schedule.duration}s · {schedule.vibrationIntensity}%
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <span className="text-[13px] font-medium text-white sm:text-sm">{schedule.alarmTemperature}°F</span>
          <span className="text-[9px] text-zinc-500 sm:text-[10px]">Alarm temp</span>
        </div>
      </div>

      {/* Expand/collapse for editing */}
      {schedule.enabled && (
        <>
          <button
            onClick={() => setExpanded(!expanded)}
            className="mb-2 flex w-full min-h-[44px] items-center justify-between py-1 text-xs font-medium text-zinc-400"
          >
            <span>Edit Alarm Settings</span>
            <svg
              className={clsx('h-3 w-3 transition-transform', expanded && 'rotate-90')}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>

          {expanded && (
            <div className="space-y-3">
              {/* Time */}
              <TimeInput
                label="Alarm Time"
                value={schedule.time}
                onChange={handleUpdateTime}
                disabled={isMutating}
              />

              {/* Preset quick-select */}
              <div>
                <span className="mb-1.5 block text-xs font-medium text-zinc-400">Presets</span>
                <div className="flex flex-wrap gap-1.5">
                  {VIBRATION_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => {
                        setLocalIntensity(preset.intensity)
                        handleUpdateIntensity(preset.intensity)
                        handleUpdatePattern(preset.pattern)
                        handleUpdateDuration(preset.duration)
                      }}
                      disabled={isMutating}
                      className={clsx(
                        'rounded-lg px-2.5 min-h-[44px] text-[11px] font-medium transition-colors sm:px-3 sm:text-xs disabled:opacity-50',
                        schedule.vibrationIntensity === preset.intensity
                          && schedule.vibrationPattern === preset.pattern
                          && schedule.duration === preset.duration
                          ? 'bg-sky-500/20 text-sky-400 ring-1 ring-sky-500/40'
                          : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'
                      )}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Vibration Intensity — local state with debounced commit */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Vibrate size={12} className="text-zinc-500" />
                    <span className="text-xs font-medium text-zinc-400">Vibration Intensity</span>
                  </div>
                  <span className="text-xs font-medium text-white">{localIntensity}%</span>
                </div>
                <input
                  type="range"
                  min={INTENSITY_MIN}
                  max={INTENSITY_MAX}
                  step={1}
                  value={localIntensity}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    setLocalIntensity(val)
                    clearTimeout(intensityCommitRef.current)
                    intensityCommitRef.current = setTimeout(() => handleUpdateIntensity(val), 400)
                  }}
                  onPointerUp={() => {
                    clearTimeout(intensityCommitRef.current)
                    handleUpdateIntensity(localIntensity)
                  }}
                  disabled={isMutating}
                  aria-label={`Vibration intensity for ${selectedDay} alarm`}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500"
                />
                <div className="flex justify-between text-[10px] text-zinc-600">
                  <span>{INTENSITY_MIN}%</span>
                  <span>{INTENSITY_MAX}%</span>
                </div>
              </div>

              {/* Pattern selector */}
              <div>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Waves size={12} className="text-zinc-500" />
                  <span className="text-xs font-medium text-zinc-400">Pattern</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {PATTERN_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => handleUpdatePattern(opt.value)}
                      disabled={isMutating}
                      className={clsx(
                        'flex flex-col items-center gap-0.5 rounded-lg border py-2.5 text-xs font-medium transition-colors disabled:opacity-50',
                        schedule.vibrationPattern === opt.value
                          ? 'border-sky-500/50 bg-sky-500/10 text-sky-400'
                          : 'border-zinc-700 bg-zinc-800/50 text-zinc-400 active:bg-zinc-700'
                      )}
                    >
                      <Waves size={14} />
                      <span>{opt.label}</span>
                      <span className="text-[10px] text-zinc-500">{opt.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Duration selector */}
              <div>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Timer size={12} className="text-zinc-500" />
                  <span className="text-xs font-medium text-zinc-400">Duration</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {DURATION_OPTIONS.map((d) => (
                    <button
                      key={d}
                      onClick={() => handleUpdateDuration(d)}
                      disabled={isMutating}
                      className={clsx(
                        'rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors sm:px-3 sm:text-xs disabled:opacity-50',
                        schedule.duration === d
                          ? 'bg-sky-500/20 text-sky-400 ring-1 ring-sky-500/40'
                          : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700'
                      )}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
              </div>

              {/* Alarm Temperature — local state with debounced commit */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-400">Alarm Temperature</span>
                  <span className="text-xs font-medium text-white">{localAlarmTemp}°F</span>
                </div>
                <input
                  type="range"
                  min={TEMP_MIN}
                  max={TEMP_MAX}
                  step={1}
                  value={localAlarmTemp}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    setLocalAlarmTemp(val)
                    clearTimeout(alarmTempCommitRef.current)
                    alarmTempCommitRef.current = setTimeout(() => handleUpdateAlarmTemp(val), 400)
                  }}
                  onPointerUp={() => {
                    clearTimeout(alarmTempCommitRef.current)
                    handleUpdateAlarmTemp(localAlarmTemp)
                  }}
                  disabled={isMutating}
                  aria-label={`Alarm temperature for ${selectedDay} alarm`}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500"
                />
                <div className="flex justify-between text-[10px] text-zinc-600">
                  <span>{TEMP_MIN}°F</span>
                  <span>{TEMP_MAX}°F</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Delete button */}
      <button
        onClick={handleDelete}
        disabled={isMutating}
        className="mt-3 flex w-full min-h-[44px] items-center justify-center gap-1 rounded-lg py-2 text-xs font-medium text-red-400/70 transition-colors active:bg-red-500/10 disabled:opacity-50"
      >
        Remove Alarm
      </button>

      {(updateMutation.error || deleteMutation.error) && (
        <p className="mt-2 text-xs text-red-400">
          {updateMutation.error?.message || deleteMutation.error?.message}
        </p>
      )}
    </div>
  )
}

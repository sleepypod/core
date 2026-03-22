'use client'

import { useEffect, useRef, useState } from 'react'
import { Moon, Sun, Clock, Power } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { TimeInput, formatTime12h, calcDuration } from './TimeInput'
import type { DayOfWeek } from './DaySelector'

interface PowerSchedule {
  id: number
  side: string
  dayOfWeek: string
  onTime: string
  offTime: string
  onTemperature: number
  enabled: boolean
}

interface PowerScheduleSectionProps {
  schedules: PowerSchedule[]
  selectedDay: DayOfWeek
  isLoading: boolean
}

const TEMP_MIN = 55
const TEMP_MAX = 110

/**
 * Power schedule section with on/off time controls, temperature slider,
 * and enable/disable toggle. Matches iOS SleepTimeCardView + schedule toggle.
 */
export function PowerScheduleSection({ schedules, selectedDay, isLoading }: PowerScheduleSectionProps) {
  const { side } = useSide()
  const utils = trpc.useUtils()

  const schedule = schedules.find(s => s.side === side && s.dayOfWeek === selectedDay)
  const hasSchedule = !!schedule

  // Local state for new schedule creation
  const [newOnTime, setNewOnTime] = useState('22:00')
  const [newOffTime, setNewOffTime] = useState('07:00')
  const [newOnTemp, setNewOnTemp] = useState(78)

  // Local slider state for existing schedule (avoids mutation per drag tick)
  const [localTemp, setLocalTemp] = useState(schedule?.onTemperature ?? 78)
  const tempCommitRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Sync local slider state when the schedule identity or values change.
  // Keying on schedule?.id ensures state resets when switching sides/days.
  useEffect(() => {
    if (schedule) setLocalTemp(schedule.onTemperature)
  }, [schedule?.id, schedule?.onTemperature])

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => { clearTimeout(tempCommitRef.current) }
  }, [])

  const createMutation = trpc.schedules.createPowerSchedule.useMutation({
    onSuccess: () => utils.schedules.getAll.invalidate(),
  })

  const updateMutation = trpc.schedules.updatePowerSchedule.useMutation({
    onSuccess: () => utils.schedules.getAll.invalidate(),
  })

  const deleteMutation = trpc.schedules.deletePowerSchedule.useMutation({
    onSuccess: () => utils.schedules.getAll.invalidate(),
  })

  const isMutating = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending

  function handleCreate() {
    createMutation.mutate({
      side,
      dayOfWeek: selectedDay,
      onTime: newOnTime,
      offTime: newOffTime,
      onTemperature: newOnTemp,
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

  function handleUpdateOnTime(time: string) {
    if (!schedule) return
    updateMutation.mutate({ id: schedule.id, onTime: time })
  }

  function handleUpdateOffTime(time: string) {
    if (!schedule) return
    updateMutation.mutate({ id: schedule.id, offTime: time })
  }

  function handleUpdateTemperature(temp: number) {
    if (!schedule) return
    updateMutation.mutate({ id: schedule.id, onTemperature: temp })
  }

  function handleDelete() {
    if (!schedule) return
    deleteMutation.mutate({ id: schedule.id })
  }

  if (isLoading) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="flex items-center gap-2 text-zinc-500">
          <Power size={16} />
          <span className="text-sm font-medium">Power Schedule</span>
        </div>
        <div className="mt-3 h-20 animate-pulse rounded-lg bg-zinc-800" />
      </div>
    )
  }

  // No schedule exists — show create prompt
  if (!hasSchedule) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        <div className="mb-3 flex items-center gap-2">
          <Power size={16} className="text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">Power Schedule</span>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <TimeInput label="Bedtime" value={newOnTime} onChange={setNewOnTime} />
            <TimeInput label="Wake" value={newOffTime} onChange={setNewOffTime} />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-400">Start Temp</span>
              <span className="text-xs font-medium text-white">
                {newOnTemp}
                °F
              </span>
            </div>
            <input
              type="range"
              min={TEMP_MIN}
              max={TEMP_MAX}
              step={1}
              value={newOnTemp}
              onChange={e => setNewOnTemp(parseInt(e.target.value, 10))}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-sky-500 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600">
              <span>
                {TEMP_MIN}
                °F
              </span>
              <span>
                {TEMP_MAX}
                °F
              </span>
            </div>
          </div>

          <button
            onClick={handleCreate}
            disabled={isMutating}
            className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-lg bg-sky-500/20 py-2.5 text-sm font-medium text-sky-400 transition-colors active:bg-sky-500/30 disabled:opacity-50"
          >
            <Power size={14} />
            {isMutating ? 'Creating...' : 'Create Power Schedule'}
          </button>
        </div>

        {createMutation.error && (
          <p className="mt-2 text-xs text-red-400">{createMutation.error.message}</p>
        )}
      </div>
    )
  }

  // Schedule exists — show summary card + controls
  return (
    <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
      {/* Header with toggle */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Power size={16} className={schedule.enabled ? 'text-sky-400' : 'text-zinc-500'} />
          <span className="text-sm font-medium text-zinc-300">Power Schedule</span>
        </div>
        <button
          onClick={handleToggleEnabled}
          disabled={isMutating}
          className="flex min-h-[44px] min-w-[48px] items-center justify-center disabled:opacity-50"
          aria-label={schedule.enabled ? 'Disable power schedule' : 'Enable power schedule'}
        >
          <span className={`relative h-7 w-12 rounded-full transition-colors ${schedule.enabled ? 'bg-sky-500' : 'bg-zinc-700'}`}>
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${schedule.enabled ? 'translate-x-5' : 'translate-x-0.5'}`}
            />
          </span>
        </button>
      </div>

      {/* Sleep time summary (Bedtime · Wake · Duration) — matches iOS SleepTimeCardView */}
      <div className="mb-3 flex items-center divide-x divide-zinc-700 rounded-xl bg-zinc-800/60 py-2.5 sm:mb-4 sm:py-3">
        <div className="flex flex-1 flex-col items-center gap-0.5 sm:gap-1">
          <Moon size={13} className="text-purple-400" />
          <span className="text-[13px] font-medium text-white sm:text-sm">{formatTime12h(schedule.onTime)}</span>
          <span className="text-[9px] text-zinc-500 sm:text-[10px]">Bedtime</span>
        </div>
        <div className="flex flex-1 flex-col items-center gap-0.5 sm:gap-1">
          <Sun size={13} className="text-amber-400" />
          <span className="text-[13px] font-medium text-white sm:text-sm">{formatTime12h(schedule.offTime)}</span>
          <span className="text-[9px] text-zinc-500 sm:text-[10px]">Wake</span>
        </div>
        <div className="flex flex-1 flex-col items-center gap-0.5 sm:gap-1">
          <Clock size={13} className="text-zinc-400" />
          <span className="text-[13px] font-medium text-white sm:text-sm">{calcDuration(schedule.onTime, schedule.offTime)}</span>
          <span className="text-[9px] text-zinc-500 sm:text-[10px]">Duration</span>
        </div>
      </div>

      {/* Editable controls (only when enabled) */}
      {schedule.enabled && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <TimeInput
              label="Bedtime"
              value={schedule.onTime}
              onChange={handleUpdateOnTime}
              disabled={isMutating}
            />
            <TimeInput
              label="Wake"
              value={schedule.offTime}
              onChange={handleUpdateOffTime}
              disabled={isMutating}
            />
          </div>

          {/* Temperature slider — local state with debounced commit */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-400">Start Temperature</span>
              <span className="text-xs font-medium text-white">
                {localTemp}
                °F
              </span>
            </div>
            <input
              type="range"
              min={TEMP_MIN}
              max={TEMP_MAX}
              step={1}
              value={localTemp}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10)
                setLocalTemp(val)
                // Debounce: commit after user stops dragging for 400ms
                clearTimeout(tempCommitRef.current)
                tempCommitRef.current = setTimeout(() => handleUpdateTemperature(val), 400)
              }}
              onPointerUp={() => {
                // Commit immediately on pointer up
                clearTimeout(tempCommitRef.current)
                handleUpdateTemperature(localTemp)
              }}
              disabled={isMutating}
              aria-label={`Start temperature for ${selectedDay} power schedule`}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sky-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600">
              <span>
                {TEMP_MIN}
                °F
              </span>
              <span>
                {TEMP_MAX}
                °F
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Delete button */}
      <button
        onClick={handleDelete}
        disabled={isMutating}
        className="mt-3 flex w-full min-h-[44px] items-center justify-center gap-1 rounded-lg py-2 text-xs font-medium text-red-400/70 transition-colors active:bg-red-500/10 disabled:opacity-50"
      >
        Remove Schedule
      </button>

      {(updateMutation.error || deleteMutation.error) && (
        <p className="mt-2 text-xs text-red-400">
          {updateMutation.error?.message || deleteMutation.error?.message}
        </p>
      )}
    </div>
  )
}

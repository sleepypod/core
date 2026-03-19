'use client'

import type { DayOfWeek } from '@/src/components/Schedule/DaySelector'
import { getCurrentDay } from '@/src/components/Schedule/DaySelector'
import { trpc } from '@/src/utils/trpc'
import { useCallback, useMemo, useState } from 'react'
import { useSide } from './useSide'

type Side = 'left' | 'right'

export interface TemperatureSchedule {
  id: number
  side: Side
  dayOfWeek: DayOfWeek
  time: string
  temperature: number
  enabled: boolean
}

export interface PowerSchedule {
  id: number
  side: Side
  dayOfWeek: DayOfWeek
  onTime: string
  offTime: string
  onTemperature: number
  enabled: boolean
}

export interface AlarmSchedule {
  id: number
  side: Side
  dayOfWeek: DayOfWeek
  time: string
  vibrationIntensity: number
  vibrationPattern: 'double' | 'rise'
  duration: number
  alarmTemperature: number
  enabled: boolean
}

export interface DayScheduleData {
  temperature: TemperatureSchedule[]
  power: PowerSchedule[]
  alarm: AlarmSchedule[]
}

/**
 * Hook that manages schedule state and tRPC operations.
 * Handles multi-day selection, bulk operations, and scheduler reload.
 */
export function useSchedule() {
  const { side } = useSide()
  const [selectedDay, setSelectedDay] = useState<DayOfWeek>(getCurrentDay())
  const [selectedDays, setSelectedDays] = useState<Set<DayOfWeek>>(() => new Set([getCurrentDay()]))
  const [isApplying, setIsApplying] = useState(false)
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null)

  const utils = trpc.useUtils()

  // Fetch all schedules for current side
  const allSchedulesQuery = trpc.schedules.getAll.useQuery({ side })

  // Fetch schedules for the selected day specifically
  const dayScheduleQuery = trpc.schedules.getByDay.useQuery({
    side,
    dayOfWeek: selectedDay,
  })

  // Mutations
  const createTempSchedule = trpc.schedules.createTemperatureSchedule.useMutation({
    onSuccess: () => invalidateAll(),
  })
  const updateTempSchedule = trpc.schedules.updateTemperatureSchedule.useMutation({
    onSuccess: () => invalidateAll(),
  })
  const deleteTempSchedule = trpc.schedules.deleteTemperatureSchedule.useMutation({
    onSuccess: () => invalidateAll(),
  })

  const createPowerSchedule = trpc.schedules.createPowerSchedule.useMutation({
    onSuccess: () => invalidateAll(),
  })
  const updatePowerSchedule = trpc.schedules.updatePowerSchedule.useMutation({
    onSuccess: () => invalidateAll(),
  })
  const deletePowerSchedule = trpc.schedules.deletePowerSchedule.useMutation({
    onSuccess: () => invalidateAll(),
  })

  const createAlarmSchedule = trpc.schedules.createAlarmSchedule.useMutation({
    onSuccess: () => invalidateAll(),
  })
  const updateAlarmSchedule = trpc.schedules.updateAlarmSchedule.useMutation({
    onSuccess: () => invalidateAll(),
  })
  const deleteAlarmSchedule = trpc.schedules.deleteAlarmSchedule.useMutation({
    onSuccess: () => invalidateAll(),
  })

  function invalidateAll() {
    void utils.schedules.getAll.invalidate()
    void utils.schedules.getByDay.invalidate()
  }

  // Get current day's schedule from the query
  const daySchedule = dayScheduleQuery.data as DayScheduleData | undefined

  // Derive power schedule enabled state for current day
  const isPowerEnabled = useMemo(() => {
    if (!daySchedule?.power?.length) return false
    return daySchedule.power.some((p: PowerSchedule) => p.enabled)
  }, [daySchedule])

  // Check if this day has any schedule data
  const hasScheduleData = useMemo(() => {
    if (!daySchedule) return false
    return (
      (daySchedule.temperature?.length ?? 0) > 0
      || (daySchedule.power?.length ?? 0) > 0
      || (daySchedule.alarm?.length ?? 0) > 0
    )
  }, [daySchedule])

  /**
   * Toggle power schedule enable/disable for all selected days.
   * This is a bulk operation — toggles the power schedule on each selected day.
   * Reloads scheduler after all changes are committed.
   */
  const togglePowerSchedule = useCallback(async () => {
    if (!allSchedulesQuery.data) return

    const allData = allSchedulesQuery.data as {
      power: PowerSchedule[]
    }
    const newEnabled = !isPowerEnabled

    setConfirmMessage(null)

    // Process each selected day
    for (const day of selectedDays) {
      const dayPowerSchedules = allData.power.filter(
        (p: PowerSchedule) => p.dayOfWeek === day
      )

      if (dayPowerSchedules.length > 0) {
        // Update existing power schedules
        for (const ps of dayPowerSchedules) {
          await updatePowerSchedule.mutateAsync({
            id: ps.id,
            enabled: newEnabled,
          })
        }
      }
      // If no power schedule exists for this day and we're enabling,
      // we can't create one without on/off times — skip silently
    }

    setConfirmMessage(
      `Schedule ${newEnabled ? 'enabled' : 'disabled'} for ${selectedDays.size} day${selectedDays.size > 1 ? 's' : ''}`
    )
    setTimeout(() => setConfirmMessage(null), 3000)
  }, [allSchedulesQuery.data, isPowerEnabled, selectedDays, updatePowerSchedule])

  /**
   * Toggle ALL schedule types (temperature + power + alarm) enable/disable
   * for all selected days. Provides unified enable/disable.
   */
  const toggleAllSchedules = useCallback(async () => {
    if (!allSchedulesQuery.data) return

    const allData = allSchedulesQuery.data as {
      temperature: TemperatureSchedule[]
      power: PowerSchedule[]
      alarm: AlarmSchedule[]
    }
    const newEnabled = !isPowerEnabled

    // Process each selected day
    for (const day of selectedDays) {
      // Toggle temperature schedules
      const dayTempSchedules = allData.temperature.filter(
        (t: TemperatureSchedule) => t.dayOfWeek === day
      )
      for (const ts of dayTempSchedules) {
        await updateTempSchedule.mutateAsync({
          id: ts.id,
          enabled: newEnabled,
        })
      }

      // Toggle power schedules
      const dayPowerSchedules = allData.power.filter(
        (p: PowerSchedule) => p.dayOfWeek === day
      )
      for (const ps of dayPowerSchedules) {
        await updatePowerSchedule.mutateAsync({
          id: ps.id,
          enabled: newEnabled,
        })
      }

      // Toggle alarm schedules
      const dayAlarmSchedules = allData.alarm.filter(
        (a: AlarmSchedule) => a.dayOfWeek === day
      )
      for (const as_ of dayAlarmSchedules) {
        await updateAlarmSchedule.mutateAsync({
          id: as_.id,
          enabled: newEnabled,
        })
      }
    }

    setConfirmMessage(
      `All schedules ${newEnabled ? 'enabled' : 'disabled'} for ${selectedDays.size} day${selectedDays.size > 1 ? 's' : ''}`
    )
    setTimeout(() => setConfirmMessage(null), 3000)
  }, [
    allSchedulesQuery.data,
    isPowerEnabled,
    selectedDays,
    updateTempSchedule,
    updatePowerSchedule,
    updateAlarmSchedule,
  ])

  /**
   * Apply the source day's schedule to target days.
   * Uses the iOS pattern: delete all existing schedules for target days,
   * then recreate from source day's data.
   *
   * Each mutation triggers reloadScheduler() on the backend,
   * so the scheduler is updated after each change.
   */
  const applyToOtherDays = useCallback(
    async (targetDays: DayOfWeek[]) => {
      if (!daySchedule || targetDays.length === 0) return

      setIsApplying(true)
      setConfirmMessage(null)

      try {
        // Get the full schedule data for current side
        const allData = allSchedulesQuery.data as {
          temperature: TemperatureSchedule[]
          power: PowerSchedule[]
          alarm: AlarmSchedule[]
        }

        if (!allData) return

        for (const targetDay of targetDays) {
          // 1. Delete all existing schedules for target day
          const existingTemp = allData.temperature.filter(
            (t: TemperatureSchedule) => t.dayOfWeek === targetDay
          )
          const existingPower = allData.power.filter(
            (p: PowerSchedule) => p.dayOfWeek === targetDay
          )
          const existingAlarm = allData.alarm.filter(
            (a: AlarmSchedule) => a.dayOfWeek === targetDay
          )

          // Delete existing
          for (const t of existingTemp) {
            await deleteTempSchedule.mutateAsync({ id: t.id })
          }
          for (const p of existingPower) {
            await deletePowerSchedule.mutateAsync({ id: p.id })
          }
          for (const a of existingAlarm) {
            await deleteAlarmSchedule.mutateAsync({ id: a.id })
          }

          // 2. Recreate from source day's schedule
          const sourceTemp = daySchedule.temperature || []
          const sourcePower = daySchedule.power || []
          const sourceAlarm = daySchedule.alarm || []

          for (const t of sourceTemp) {
            await createTempSchedule.mutateAsync({
              side,
              dayOfWeek: targetDay,
              time: t.time,
              temperature: Math.round(t.temperature),
              enabled: t.enabled,
            })
          }

          for (const p of sourcePower) {
            await createPowerSchedule.mutateAsync({
              side,
              dayOfWeek: targetDay,
              onTime: p.onTime,
              offTime: p.offTime,
              onTemperature: Math.round(p.onTemperature),
              enabled: p.enabled,
            })
          }

          for (const a of sourceAlarm) {
            await createAlarmSchedule.mutateAsync({
              side,
              dayOfWeek: targetDay,
              time: a.time,
              vibrationIntensity: a.vibrationIntensity,
              vibrationPattern: a.vibrationPattern,
              duration: a.duration,
              alarmTemperature: Math.round(a.alarmTemperature),
              enabled: a.enabled,
            })
          }
        }

        setConfirmMessage(
          `Schedule applied to ${targetDays.length} day${targetDays.length > 1 ? 's' : ''}. Scheduler reloaded.`
        )
        setTimeout(() => setConfirmMessage(null), 4000)
      } catch (error) {
        console.error('Failed to apply schedule to other days:', error)
        setConfirmMessage('Failed to apply schedule. Please try again.')
        setTimeout(() => setConfirmMessage(null), 4000)
      } finally {
        setIsApplying(false)
      }
    },
    [
      daySchedule,
      allSchedulesQuery.data,
      side,
      createTempSchedule,
      createPowerSchedule,
      createAlarmSchedule,
      deleteTempSchedule,
      deletePowerSchedule,
      deleteAlarmSchedule,
    ]
  )

  return {
    // State
    side,
    selectedDay,
    selectedDays,
    setSelectedDay,
    setSelectedDays,
    confirmMessage,

    // Schedule data
    daySchedule,
    allSchedules: allSchedulesQuery.data as
      | { temperature: TemperatureSchedule[]; power: PowerSchedule[]; alarm: AlarmSchedule[] }
      | undefined,
    isPowerEnabled,
    hasScheduleData,

    // Loading states
    isLoading: allSchedulesQuery.isLoading || dayScheduleQuery.isLoading,
    isApplying,
    isMutating:
      createTempSchedule.isPending
      || updateTempSchedule.isPending
      || deleteTempSchedule.isPending
      || createPowerSchedule.isPending
      || updatePowerSchedule.isPending
      || deletePowerSchedule.isPending
      || createAlarmSchedule.isPending
      || updateAlarmSchedule.isPending
      || deleteAlarmSchedule.isPending,

    // Actions
    togglePowerSchedule,
    toggleAllSchedules,
    applyToOtherDays,

    // Refetch
    refetch: () => {
      void allSchedulesQuery.refetch()
      void dayScheduleQuery.refetch()
    },
  }
}

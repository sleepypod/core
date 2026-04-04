'use client'

import type { DayOfWeek } from '@/src/components/Schedule/DaySelector'
import { getCurrentDay } from '@/src/components/Schedule/DaySelector'
import { trpc } from '@/src/utils/trpc'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clean up confirm message timer on unmount
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

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

  const batchUpdate = trpc.schedules.batchUpdate.useMutation({
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

    const powerUpdates: Array<{ id: number, enabled: boolean }> = []
    const powerCreates: Array<{ side: Side, dayOfWeek: DayOfWeek, onTime: string, offTime: string, onTemperature: number, enabled: boolean }> = []

    for (const day of selectedDays) {
      const dayPowerSchedules = allData.power.filter(
        (p: PowerSchedule) => p.dayOfWeek === day
      )

      if (dayPowerSchedules.length > 0) {
        for (const ps of dayPowerSchedules) {
          powerUpdates.push({ id: ps.id, enabled: newEnabled })
        }
      }
      else if (newEnabled) {
        powerCreates.push({
          side,
          dayOfWeek: day,
          onTime: '22:00',
          offTime: '07:00',
          onTemperature: 75,
          enabled: true,
        })
      }
    }

    await batchUpdate.mutateAsync({
      updates: { power: powerUpdates },
      creates: { power: powerCreates },
    })

    setConfirmMessage(
      `Schedule ${newEnabled ? 'enabled' : 'disabled'} for ${selectedDays.size} day${selectedDays.size > 1 ? 's' : ''}`
    )
    confirmTimerRef.current = setTimeout(() => setConfirmMessage(null), 3000)
  }, [allSchedulesQuery.data, isPowerEnabled, selectedDays, side, batchUpdate])

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

    const tempUpdates: Array<{ id: number, enabled: boolean }> = []
    const powerUpdates: Array<{ id: number, enabled: boolean }> = []
    const alarmUpdates: Array<{ id: number, enabled: boolean }> = []
    const powerCreates: Array<{ side: Side, dayOfWeek: DayOfWeek, onTime: string, offTime: string, onTemperature: number, enabled: boolean }> = []

    for (const day of selectedDays) {
      // Temperature schedules
      for (const ts of allData.temperature.filter((t: TemperatureSchedule) => t.dayOfWeek === day)) {
        tempUpdates.push({ id: ts.id, enabled: newEnabled })
      }

      // Power schedules
      const dayPowerSchedules = allData.power.filter((p: PowerSchedule) => p.dayOfWeek === day)
      if (dayPowerSchedules.length > 0) {
        for (const ps of dayPowerSchedules) {
          powerUpdates.push({ id: ps.id, enabled: newEnabled })
        }
      }
      else if (newEnabled) {
        powerCreates.push({
          side,
          dayOfWeek: day,
          onTime: '22:00',
          offTime: '07:00',
          onTemperature: 75,
          enabled: true,
        })
      }

      // Alarm schedules
      for (const as_ of allData.alarm.filter((a: AlarmSchedule) => a.dayOfWeek === day)) {
        alarmUpdates.push({ id: as_.id, enabled: newEnabled })
      }
    }

    await batchUpdate.mutateAsync({
      updates: { temperature: tempUpdates, power: powerUpdates, alarm: alarmUpdates },
      creates: { power: powerCreates },
    })

    setConfirmMessage(
      `All schedules ${newEnabled ? 'enabled' : 'disabled'} for ${selectedDays.size} day${selectedDays.size > 1 ? 's' : ''}`
    )
    confirmTimerRef.current = setTimeout(() => setConfirmMessage(null), 3000)
  }, [allSchedulesQuery.data, isPowerEnabled, selectedDays, side, batchUpdate])

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
        const allData = allSchedulesQuery.data as {
          temperature: TemperatureSchedule[]
          power: PowerSchedule[]
          alarm: AlarmSchedule[]
        }

        if (!allData) return

        const tempDeletes: number[] = []
        const powerDeletes: number[] = []
        const alarmDeletes: number[] = []
        const tempCreates: Array<{ side: Side, dayOfWeek: DayOfWeek, time: string, temperature: number, enabled: boolean }> = []
        const powerCreates: Array<{ side: Side, dayOfWeek: DayOfWeek, onTime: string, offTime: string, onTemperature: number, enabled: boolean }> = []
        const alarmCreates: Array<{ side: Side, dayOfWeek: DayOfWeek, time: string, vibrationIntensity: number, vibrationPattern: 'double' | 'rise', duration: number, alarmTemperature: number, enabled: boolean }> = []

        const sourceTemp = daySchedule.temperature || []
        const sourcePower = daySchedule.power || []
        const sourceAlarm = daySchedule.alarm || []

        for (const targetDay of targetDays) {
          // Collect IDs to delete
          for (const t of allData.temperature.filter((t: TemperatureSchedule) => t.dayOfWeek === targetDay)) {
            tempDeletes.push(t.id)
          }
          for (const p of allData.power.filter((p: PowerSchedule) => p.dayOfWeek === targetDay)) {
            powerDeletes.push(p.id)
          }
          for (const a of allData.alarm.filter((a: AlarmSchedule) => a.dayOfWeek === targetDay)) {
            alarmDeletes.push(a.id)
          }

          // Collect creates from source day
          for (const t of sourceTemp) {
            tempCreates.push({
              side,
              dayOfWeek: targetDay,
              time: t.time,
              temperature: Math.round(t.temperature),
              enabled: t.enabled,
            })
          }
          for (const p of sourcePower) {
            powerCreates.push({
              side,
              dayOfWeek: targetDay,
              onTime: p.onTime,
              offTime: p.offTime,
              onTemperature: Math.round(p.onTemperature),
              enabled: p.enabled,
            })
          }
          for (const a of sourceAlarm) {
            alarmCreates.push({
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

        await batchUpdate.mutateAsync({
          deletes: { temperature: tempDeletes, power: powerDeletes, alarm: alarmDeletes },
          creates: { temperature: tempCreates, power: powerCreates, alarm: alarmCreates },
        })

        setConfirmMessage(
          `Schedule applied to ${targetDays.length} day${targetDays.length > 1 ? 's' : ''}. Scheduler reloaded.`
        )
        confirmTimerRef.current = setTimeout(() => setConfirmMessage(null), 4000)
      }
      catch (error) {
        console.error('Failed to apply schedule to other days:', error)
        setConfirmMessage('Failed to apply schedule. Please try again.')
        confirmTimerRef.current = setTimeout(() => setConfirmMessage(null), 4000)
      }
      finally {
        setIsApplying(false)
      }
    },
    [daySchedule, allSchedulesQuery.data, side, batchUpdate]
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
    | { temperature: TemperatureSchedule[], power: PowerSchedule[], alarm: AlarmSchedule[] }
    | undefined,
    isPowerEnabled,
    hasScheduleData,

    // Loading states
    isLoading: allSchedulesQuery.isLoading || dayScheduleQuery.isLoading,
    isApplying,
    isMutating:
      batchUpdate.isPending
      || createTempSchedule.isPending
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

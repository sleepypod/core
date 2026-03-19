'use client'

import { useCallback, useMemo } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import type { DayOfWeek } from '@/src/components/Schedule/DaySelector'

export interface TemperatureSchedule {
  id: number
  side: 'left' | 'right'
  dayOfWeek: DayOfWeek
  time: string
  temperature: number
  enabled: boolean
  createdAt: string | Date
  updatedAt: string | Date
}

export interface ScheduleData {
  temperature: TemperatureSchedule[]
  power: any[]
  alarm: any[]
}

const PHASE_NAMES = ['Bedtime', 'Deep Sleep', 'Pre-Wake', 'Wake Up']
const PHASE_ICONS = ['moon', 'moon', 'sunrise', 'sun'] as const

export type PhaseIcon = typeof PHASE_ICONS[number]

export interface SchedulePhase {
  id: number
  name: string
  icon: PhaseIcon
  time: string
  temperature: number
  enabled: boolean
}

/**
 * Hook for managing temperature schedules with optimistic updates.
 * Fetches schedule data for the current side and selected day,
 * and provides CRUD mutations with optimistic UI rollback on error.
 */
export function useSchedules(selectedDay: DayOfWeek) {
  const { side } = useSide()
  const utils = trpc.useUtils()

  const queryKey = { side, dayOfWeek: selectedDay }
  const schedulesQuery = trpc.schedules.getByDay.useQuery(queryKey)

  // Derive phases from temperature schedules (sorted by time, named by position)
  const phases: SchedulePhase[] = useMemo(() => {
    const temps = schedulesQuery.data?.temperature
    if (!temps || temps.length === 0) return []
    const sorted = [...temps].sort((a: any, b: any) => a.time.localeCompare(b.time))
    return sorted.map((t: any, i: number) => ({
      id: t.id,
      name: i < PHASE_NAMES.length ? PHASE_NAMES[i] : `Phase ${i + 1}`,
      icon: (i < PHASE_ICONS.length ? PHASE_ICONS[i] : 'sun') as PhaseIcon,
      time: t.time,
      temperature: t.temperature,
      enabled: t.enabled,
    }))
  }, [schedulesQuery.data?.temperature])

  const invalidate = useCallback(() => {
    void utils.schedules.getByDay.invalidate(queryKey)
    void utils.schedules.getAll.invalidate({ side })
  }, [utils, side, selectedDay])

  // ── Create temperature schedule with optimistic update ──
  const createMutation = trpc.schedules.createTemperatureSchedule.useMutation({
    onMutate: async (newSchedule) => {
      await utils.schedules.getByDay.cancel(queryKey)
      const previous = utils.schedules.getByDay.getData(queryKey)

      utils.schedules.getByDay.setData(queryKey, (old: any) => {
        if (!old) return old
        const optimistic = {
          id: -Date.now(),
          side: newSchedule.side,
          dayOfWeek: newSchedule.dayOfWeek,
          time: newSchedule.time,
          temperature: newSchedule.temperature,
          enabled: newSchedule.enabled ?? true,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        return { ...old, temperature: [...old.temperature, optimistic] }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        utils.schedules.getByDay.setData(queryKey, context.previous)
      }
    },
    onSettled: () => invalidate(),
  })

  // ── Update temperature schedule with optimistic update ──
  const updateMutation = trpc.schedules.updateTemperatureSchedule.useMutation({
    onMutate: async (updates) => {
      await utils.schedules.getByDay.cancel(queryKey)
      const previous = utils.schedules.getByDay.getData(queryKey)

      utils.schedules.getByDay.setData(queryKey, (old: any) => {
        if (!old) return old
        return {
          ...old,
          temperature: old.temperature.map((t: any) =>
            t.id === updates.id
              ? {
                  ...t,
                  ...(updates.time !== undefined && { time: updates.time }),
                  ...(updates.temperature !== undefined && { temperature: updates.temperature }),
                  ...(updates.enabled !== undefined && { enabled: updates.enabled }),
                }
              : t
          ),
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        utils.schedules.getByDay.setData(queryKey, context.previous)
      }
    },
    onSettled: () => invalidate(),
  })

  // ── Delete temperature schedule with optimistic update ──
  const deleteMutation = trpc.schedules.deleteTemperatureSchedule.useMutation({
    onMutate: async ({ id }) => {
      await utils.schedules.getByDay.cancel(queryKey)
      const previous = utils.schedules.getByDay.getData(queryKey)

      utils.schedules.getByDay.setData(queryKey, (old: any) => {
        if (!old) return old
        return {
          ...old,
          temperature: old.temperature.filter((t: any) => t.id !== id),
        }
      })
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        utils.schedules.getByDay.setData(queryKey, context.previous)
      }
    },
    onSettled: () => invalidate(),
  })

  // ── Convenience methods ──

  const createSetPoint = useCallback(
    (time: string, temperature: number) => {
      createMutation.mutate({
        side,
        dayOfWeek: selectedDay,
        time,
        temperature,
        enabled: true,
      })
    },
    [createMutation, side, selectedDay]
  )

  const updateSetPoint = useCallback(
    (id: number, updates: { time?: string; temperature?: number; enabled?: boolean }) => {
      updateMutation.mutate({ id, ...updates })
    },
    [updateMutation]
  )

  const adjustTemperature = useCallback(
    (id: number, delta: number) => {
      const phase = phases.find((p) => p.id === id)
      if (!phase) return
      const newTemp = Math.max(55, Math.min(110, phase.temperature + delta))
      updateMutation.mutate({ id, temperature: newTemp })
    },
    [updateMutation, phases]
  )

  const deleteSetPoint = useCallback(
    (id: number) => {
      deleteMutation.mutate({ id })
    },
    [deleteMutation]
  )

  return {
    scheduleData: schedulesQuery.data as ScheduleData | undefined,
    phases,
    isLoading: schedulesQuery.isLoading,
    error: schedulesQuery.error,

    createSetPoint,
    updateSetPoint,
    adjustTemperature,
    deleteSetPoint,

    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isMutating: createMutation.isPending || updateMutation.isPending || deleteMutation.isPending,

    refetch: schedulesQuery.refetch,
  }
}

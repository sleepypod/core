'use client'

import { trpc } from '@/src/utils/trpc'
import { useSide } from './useSide'
import { formatTime12h } from '@/src/components/Schedule/TimeInput'

/**
 * Lightweight hook to check if any temperature schedule is active
 * and find the next upcoming set point time.
 * Uses a long stale time so it doesn't spam the API.
 */
export function useScheduleActive() {
  const { side } = useSide()
  const { data } = trpc.schedules.getAll.useQuery({ side })

  if (!data?.temperature) return { isActive: false, nextTime: null }

  interface TempSchedule { enabled: boolean, dayOfWeek: string, time: string }
  const enabled = data.temperature.filter((t: TempSchedule) => t.enabled)
  if (enabled.length === 0) return { isActive: false, nextTime: null }

  // Find next upcoming set point based on current time
  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const today = days[now.getDay()]

  // Look at today's remaining set points first
  const todayPoints = enabled
    .filter((t: TempSchedule) => t.dayOfWeek === today)
    .map((t: TempSchedule) => {
      const [h, m] = t.time.split(':').map(Number)
      return { ...t, minutes: h * 60 + m }
    })
    .filter((t: TempSchedule & { minutes: number }) => t.minutes > currentMinutes)
    .sort((a: { minutes: number }, b: { minutes: number }) => a.minutes - b.minutes)

  const next = todayPoints[0]
  const nextTime = next ? formatTime12h(next.time) : null

  return { isActive: true, nextTime }
}

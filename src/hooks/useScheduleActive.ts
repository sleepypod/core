'use client'

import { trpc } from '@/src/utils/trpc'
import { useSide } from './useSide'
import { formatTime12h } from '@/src/components/Schedule/TimeInput'

interface TempSchedule { enabled: boolean, dayOfWeek: string, time: string }

const DAYS_OF_WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/**
 * Lightweight hook to check if any temperature schedule is active
 * and find the next upcoming set point time. Scans forward across all 7
 * days so the hint stays accurate after today's last set point.
 */
export function useScheduleActive() {
  const { side } = useSide()
  const { data } = trpc.schedules.getAll.useQuery({ side })

  if (!data?.temperature) return { isActive: false, nextTime: null }

  const enabled = (data.temperature as TempSchedule[]).filter(t => t.enabled)
  if (enabled.length === 0) return { isActive: false, nextTime: null }

  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const todayIdx = now.getDay()

  const toMinutes = (t: string): number => {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }

  // Walk forward across the next 7 days, picking the first set point
  // strictly after "now".
  for (let offset = 0; offset < 7; offset++) {
    const day = DAYS_OF_WEEK[(todayIdx + offset) % 7]
    const dayPoints = enabled
      .filter(t => t.dayOfWeek === day)
      .map(t => ({ time: t.time, minutes: toMinutes(t.time) }))
      .filter(t => offset > 0 || t.minutes > currentMinutes)
      .sort((a, b) => a.minutes - b.minutes)

    if (dayPoints.length > 0) {
      return { isActive: true, nextTime: formatTime12h(dayPoints[0].time) }
    }
  }

  return { isActive: true, nextTime: null }
}

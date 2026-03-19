'use client'

import { useCallback, useState } from 'react'

function getWeekStart(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay() // 0=Sun
  d.setDate(d.getDate() - day)
  d.setHours(0, 0, 0, 0)
  return d
}

function getWeekEnd(weekStart: Date): Date {
  const d = new Date(weekStart)
  d.setDate(d.getDate() + 6)
  d.setHours(23, 59, 59, 999)
  return d
}

function formatWeekLabel(start: Date, end: Date): string {
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
  return `${fmt.format(start)} – ${fmt.format(end)}`
}

/**
 * Week-based navigation matching iOS WeekNavigatorView.
 * Provides start/end dates for the selected week and prev/next controls.
 */
export function useWeekNavigator() {
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()))

  const weekEnd = getWeekEnd(weekStart)
  const label = formatWeekLabel(weekStart, weekEnd)

  const isCurrentWeek = getWeekStart(new Date()).getTime() === weekStart.getTime()

  const goToPreviousWeek = useCallback(() => {
    setWeekStart(prev => {
      const d = new Date(prev)
      d.setDate(d.getDate() - 7)
      return d
    })
  }, [])

  const goToNextWeek = useCallback(() => {
    setWeekStart(prev => {
      const next = new Date(prev)
      next.setDate(next.getDate() + 7)
      const currentWeekStart = getWeekStart(new Date())
      // Don't go past current week
      if (next.getTime() > currentWeekStart.getTime()) return prev
      return next
    })
  }, [])

  const goToCurrentWeek = useCallback(() => {
    setWeekStart(getWeekStart(new Date()))
  }, [])

  return {
    weekStart,
    weekEnd,
    label,
    isCurrentWeek,
    goToPreviousWeek,
    goToNextWeek,
    goToCurrentWeek,
  } as const
}

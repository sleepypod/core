'use client'

import { useMemo } from 'react'
import { useTimeFormat } from '@/src/providers/PrefsProvider'
import { formatClock, formatTick, formatTime } from '@/src/lib/timeFormat'

/** Stable formatters so chart memoization updates when the preference changes. */
export function useTimeFormatter() {
  const timeFormat = useTimeFormat()
  return useMemo(() => ({
    timeFormat,
    formatTime: (time: string) => formatTime(time, timeFormat),
    formatClock: (value: Date | number | string | null | undefined, options?: Intl.DateTimeFormatOptions) => formatClock(value, timeFormat, options),
    formatTick: (value: number) => formatTick(value, timeFormat),
  }), [timeFormat])
}

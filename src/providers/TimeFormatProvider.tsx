'use client'

import { createContext, useContext } from 'react'
import { trpc } from '@/src/utils/trpc'
import type { TimeFormat } from '@/src/lib/timeFormat'

const TimeFormatContext = createContext<TimeFormat>('12h')

/** Publishes the pod-wide clock display from device settings; 12-hour until settings load. */
export function TimeFormatProvider({ children }: { children: React.ReactNode }) {
  const { data: settings } = trpc.settings.getAll.useQuery(
    {},
    { staleTime: 60_000, refetchInterval: 60_000 },
  )
  const timeFormat: TimeFormat = settings?.device?.timeFormat === '24h' ? '24h' : '12h'
  return <TimeFormatContext.Provider value={timeFormat}>{children}</TimeFormatContext.Provider>
}

export function useTimeFormat(): TimeFormat {
  return useContext(TimeFormatContext)
}

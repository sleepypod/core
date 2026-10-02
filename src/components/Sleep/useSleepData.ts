'use client'

import { useMemo } from 'react'
import { trpc } from '@/src/utils/trpc'
import { buildNights, nightWindow, type MovementRow, type Side, type SleepRecordRow, type VitalsRow } from './sleepData'

/** Sleep sessions whose night starts within the week (Sun–Sat). */
export function useWeekRecords(side: Side, weekStart: Date) {
  const range = useMemo(() => nightWindow(weekStart, 7), [weekStart])
  return trpc.biometrics.getSleepRecords.useQuery({ side, ...range, limit: 21 })
}

/**
 * The week's seven nights with durations, exits, per-night vitals and a
 * client-side stage classification (quality + REM/Light/Deep split).
 */
export function useWeekNights(side: Side, weekStart: Date) {
  const range = useMemo(() => nightWindow(weekStart, 7), [weekStart])
  const records = useWeekRecords(side, weekStart)
  // 20 000 covers a week of ~30 s vitals; movement is capped at 1 000 server-side.
  const vitals = trpc.biometrics.getVitals.useQuery({ side, ...range, limit: 20000 })
  const movement = trpc.biometrics.getMovement.useQuery({ side, ...range, limit: 1000 })

  const nights = useMemo(
    () => buildNights(
      weekStart,
      7,
      (records.data ?? []) as SleepRecordRow[],
      (vitals.data ?? []) as VitalsRow[],
      (movement.data ?? []) as MovementRow[],
    ),
    [weekStart, records.data, vitals.data, movement.data],
  )

  return {
    nights,
    isLoading: records.isLoading,
    /** Stage splits/quality are still being computed from vitals. */
    isClassifying: vitals.isLoading || movement.isLoading,
    error: records.error,
  }
}

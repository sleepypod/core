'use client'

import { useMemo } from 'react'
import { trpc } from '@/src/utils/trpc'
import { buildNights, nightWindow, withNightAnalysis, type Side, type SleepRecordRow } from './sleepData'

/** Sleep sessions whose night starts within the week (Sun–Sat). */
export function useWeekRecords(side: Side, weekStart: Date) {
  const range = useMemo(() => nightWindow(weekStart, 7), [weekStart])
  return trpc.biometrics.getSleepRecords.useQuery({ side, ...range, limit: 1000 })
}

/** Share Night's query keys and server-owned stages, scores and provenance for every week card. */
export function useWeekNights(side: Side, weekStart: Date) {
  const records = useWeekRecords(side, weekStart)
  const nights = useMemo(
    () => buildNights(weekStart, 7, (records.data ?? []) as SleepRecordRow[]),
    [weekStart, records.data],
  )
  const recorded = nights.filter(night => night.hours > 0)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const queries = trpc.useQueries(query => recorded.map(night => query.biometrics.getSleepStages(
    { side, nightDate: night.key, timeZone },
    { staleTime: 30_000 },
  )))
  const byNight = new Map(recorded.map((night, index) => [night.key, queries[index]]))

  return {
    nights: nights.map((night) => {
      const query = byNight.get(night.key)
      return {
        ...withNightAnalysis(night, query?.error ? undefined : query?.data),
        analysisLoading: query?.isLoading ?? false,
        analysisError: !!query?.error,
      }
    }),
    isLoading: records.isLoading,
    isClassifying: queries.some(query => query.isLoading),
    error: records.error,
  }
}

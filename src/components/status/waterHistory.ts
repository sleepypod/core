'use client'

import { useState } from 'react'
import { trpc } from '@/src/utils/trpc'

const DAY_MS = 24 * 60 * 60 * 1000

export type WaterDay = 'ok' | 'low' | null

interface Reading {
  timestamp: Date | string
  level: string
}

/**
 * Last 7 days of water readings. The window start is pinned once per mount so
 * the query key stays stable across renders.
 */
export function useWaterHistory(enabled = true) {
  const [startDate] = useState(() => new Date(Math.floor((Date.now() - 7 * DAY_MS) / 60_000) * 60_000))
  return trpc.waterLevel.getHistory.useQuery(
    { startDate, limit: 10000 },
    { refetchInterval: 60_000, enabled },
  )
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * One status per calendar day, oldest first, ending today. A day is 'low' if
 * any reading that day was low, 'ok' if it had readings and none were low,
 * null when there's no data.
 */
export function dailyWaterLevels(history: Reading[] | undefined, now = Date.now(), days = 7): { day: number, level: WaterDay }[] {
  const today = startOfDay(now)
  const out = Array.from({ length: days }, (_, i) => {
    const day = new Date(today)
    day.setDate(day.getDate() - (days - 1 - i))
    return { day: day.getTime(), level: null as WaterDay }
  })
  for (const r of history ?? []) {
    const d = startOfDay(new Date(r.timestamp).getTime())
    const slot = out.find(o => o.day === d)
    if (!slot) continue
    if (r.level === 'low') slot.level = 'low'
    else if (slot.level === null) slot.level = 'ok'
  }
  return out
}

/**
 * Fixed-bucket series for the 7-day chart: 1 = ok, 0 = low, NaN = no data.
 * Buckets use the worst reading in the window so short dips stay visible.
 */
export function waterSeries(history: Reading[] | undefined, now = Date.now(), buckets = 42): number[] {
  const start = now - 7 * DAY_MS
  const width = (7 * DAY_MS) / buckets
  const out = Array.from({ length: buckets }, () => Number.NaN)
  for (const r of history ?? []) {
    const ts = new Date(r.timestamp).getTime()
    if (ts < start || ts > now) continue
    const i = Math.min(buckets - 1, Math.floor((ts - start) / width))
    const v = r.level === 'low' ? 0 : 1
    out[i] = Number.isNaN(out[i]) ? v : Math.min(out[i], v)
  }
  return out
}

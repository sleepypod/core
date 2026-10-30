import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { comfortEventSchema } from './contract'
import { comfortLocalDate } from './policy'
import { median } from './signals'
import type { ThermalNight } from './thermal-learning'

/** Join one morning check-in to actual, quiet occupied observations from that side. */
export function thermalDataset(database: Database.Database, side: Side, now: number): ThermalNight[] {
  const reports = database.prepare('SELECT local_date AS date, comfort FROM comfort_feedback WHERE side = ? ORDER BY local_date DESC LIMIT 90')
    .all(side) as { date: string, comfort: string }[]
  const rows = database.prepare('SELECT event FROM comfort_events WHERE side = ? AND observed_at >= ? AND observed_at <= ? AND json_extract(event, \'$.thermalContext\') IS NOT NULL ORDER BY observed_at LIMIT 50000')
    .all(side, now - 90 * 86400000, now) as { event: string }[]
  const nights = new Map<string, { session: string, samples: Map<number, { targetF: number, waterF: number, roomF: number, humidity: number }> }>()
  const ambiguous = new Set<string>()
  for (const row of rows) {
    let value: unknown
    try {
      value = JSON.parse(row.event)
    }
    catch {
      continue
    }
    const parsed = comfortEventSchema.safeParse(value)
    if (!parsed.success) continue
    const event = parsed.data, preview = event.preview, context = event.thermalContext
    if (!preview || !context || preview.environment !== 'production' || !preview.buildRevision || !preview.hardwareIdentity
      || preview.end >= now || event.at < preview.start || event.at > preview.end
      || preview.presence !== 'occupied' || !preview.presenceSourceKey || !preview.mechanicallyQuiet
      || !preview.deviceFresh || preview.manualPaused || !event.eligible) continue
    const date = comfortLocalDate(preview.end, preview.timezone)
    const group = nights.get(date) ?? { session: preview.session, samples: new Map() }
    if (group.session !== preview.session) ambiguous.add(date)
    // At most one observation per five minutes so high-rate recording cannot dominate a night.
    group.samples.set(Math.floor(event.at / 300000), context)
    nights.set(date, group)
  }
  return reports.flatMap((feedback): ThermalNight[] => {
    const night = nights.get(feedback.date)
    if (!night || ambiguous.has(feedback.date) || night.samples.size < 12 || !['warm', 'cold', 'comfortable'].includes(feedback.comfort)) return []
    const contexts = [...night.samples.values()]
    const targets = contexts.map(context => context.targetF)
    // A large overnight curve or wake warming makes one whole-night comfort label ambiguous.
    if (Math.max(...targets) - Math.min(...targets) > 2) return []
    return [{ date: feedback.date, correction: feedback.comfort === 'warm' ? -1 : feedback.comfort === 'cold' ? 1 : 0,
      targetF: median(targets), waterF: median(contexts.map(context => context.waterF)),
      roomF: median(contexts.map(context => context.roomF)), humidity: median(contexts.map(context => context.humidity)) }]
  })
}

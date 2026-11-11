import type Database from 'better-sqlite3'
import { z } from 'zod'
import { nightExplanationSchema, nightEventSchema, nightThermalSchema, nightQuerySchema, type NightEvent, type NightExplanation, type NightSourceKey } from './contract'
import { nightWindow } from './window'
import { applicationEvent, decisionEvent, ruleEvents, groupNightDecisions, type StoredNightRow } from './events'
import { roomObservation } from './room'

const sourceLimits = { applications: 1000, decisions: 3000, rules: 3000, thermal: 3000, room: 10_000 }
const rowIdentity = z.object({ id: z.number().int().positive(), at: z.number().int().nonnegative() })
const sourceNotes: Record<NightSourceKey, string> = {
  applications: 'Retained controller attempts and acknowledgments; neither proves felt warming or cooling.',
  decisions: 'Retained personal policy evaluations. Preview and eligible proposals are not hardware commands.',
  rules: 'Recorded rule evaluations. Unassigned rules cannot be attributed to this side; current rule names and conditions are not substituted for historical evidence.',
  thermal: 'Pod-reported water temperatures and power samples. Missing intervals remain unknown; these are not body-temperature readings.',
  room: 'Historical source mappings and original clocks. At most the latest report per source/revision in each five-minute bin is shown; values are not interpolated.',
}

/** Bounded reads only: journal failures remain independent and never start a controller or sensor. */
export function readNightExplanation(database: Database.Database, biometrics: Database.Database,
  side: 'left' | 'right', wakeDate?: string, now = Date.now()): NightExplanation {
  nightQuerySchema.parse({ side, wakeDate })
  const settings = z.object({ timezone: z.string().min(1).max(100) }).parse(database.prepare('SELECT timezone FROM device_settings LIMIT 1').get())
  const window = nightWindow(settings.timezone, now, wakeDate)
  const result: NightExplanation = { apiVersion: 1, generatedAt: now, side, ...window, attribution: 'physical_zone_only',
    events: [], eventsTruncated: false, thermal: [], room: [], roomSampleIntervalMs: 300_000, roomTruncated: false, sources: [] }
  const queries: Record<NightSourceKey, { query: string, values: (number | string)[], database: Database.Database }> = {
    applications: { database, query: `SELECT id, attempt_id AS attemptId, attempted_at AS at, finished_at AS finishedAt, outcome, request
      FROM temperature_applications WHERE side=? AND attempted_at>=? AND attempted_at<? AND attempted_at<=? ORDER BY attempted_at DESC,id DESC LIMIT ?`,
    values: [side, window.start, window.end, window.observedThrough] },
    decisions: { database, query: `SELECT id,observed_at AS at,event FROM comfort_events
      WHERE side=? AND observed_at>=? AND observed_at<? AND observed_at<=? ORDER BY observed_at DESC,id DESC LIMIT ?`,
    values: [side, window.start, window.end, window.observedThrough] },
    rules: { database, query: `SELECT id,automation_id AS automationId,fired_at*1000 AS at,outcome,detail FROM automation_runs
      WHERE fired_at>=? AND fired_at<? AND fired_at<=? ORDER BY fired_at DESC,id DESC LIMIT ?`,
    values: [window.start / 1000, window.end / 1000, Math.floor(window.observedThrough / 1000)] },
    thermal: { database: biometrics, query: `SELECT id,timestamp*1000 AS at,is_powered AS powered,target_temp_f AS targetF,current_temp_f AS reportedF
      FROM thermal_state WHERE side=? AND timestamp>=? AND timestamp<? AND timestamp<=? ORDER BY timestamp DESC,id DESC LIMIT ?`,
    values: [side, window.start / 1000, window.end / 1000, Math.floor(window.observedThrough / 1000)] },
    room: { database, query: `SELECT id,source_id AS sourceId,revision,received_at AS at,source,report FROM bedroom_history
      WHERE received_at>=? AND received_at<? AND received_at<=? ORDER BY received_at DESC,id DESC LIMIT ?`,
    values: [window.start, window.end, window.observedThrough] },
  }
  for (const key of Object.keys(queries) as NightSourceKey[]) {
    const source: NightExplanation['sources'][number] = { key, status: 'empty', rowsRead: 0, discarded: 0, truncated: false, note: sourceNotes[key] }
    const sourceEvents: NightEvent[] = []
    try {
      const selected = queries[key]
      const raw = selected.database.prepare(selected.query).all(...selected.values, sourceLimits[key] + 1) as StoredNightRow[]
      source.truncated = raw.length > sourceLimits[key]
      const rows = raw.slice(0, sourceLimits[key]).reverse()
      source.rowsRead = rows.length
      for (const row of rows) {
        try {
          const identity = rowIdentity.parse(row)
          if (identity.at < window.start || identity.at >= window.end || identity.at > window.observedThrough) throw new Error('Invalid event clock')
          if (key === 'applications') sourceEvents.push(nightEventSchema.parse(applicationEvent(row, side, window.observedThrough)))
          if (key === 'decisions') sourceEvents.push(nightEventSchema.parse(decisionEvent(row, side)))
          if (key === 'rules') sourceEvents.push(...ruleEvents(row, side).map(event => nightEventSchema.parse(event)))
          if (key === 'thermal') {
            if (row.powered !== 0 && row.powered !== 1) throw new Error('Invalid power state')
            result.thermal.push(nightThermalSchema.parse({ ...row, powered: row.powered === 1 }))
          }
          if (key === 'room') {
            const observation = roomObservation(row, side)
            if (observation) result.room.push(observation)
          }
        }
        catch { source.discarded++ }
      }
      source.status = source.truncated || source.discarded ? 'partial' : rows.length ? 'read' : 'empty'
      result.events.push(...groupNightDecisions(sourceEvents))
    }
    catch { source.status = 'unavailable' }
    result.sources.push(source)
  }
  result.events.sort((first, second) => first.at - second.at || first.id.localeCompare(second.id))
  result.eventsTruncated = result.events.length > 600
  result.events = result.events.slice(-600)
  const bins = new Map<string, NightExplanation['room'][number]>()
  for (const observation of result.room) bins.set(`${observation.sourceId}:${observation.revision}:${Math.floor(observation.receivedAt / 300_000)}`, observation)
  result.room = [...bins.values()].sort((first, second) => first.receivedAt - second.receivedAt || first.id - second.id)
  result.roomTruncated = result.room.length > 2000
  result.room = result.room.slice(-2000)
  return nightExplanationSchema.parse(result)
}

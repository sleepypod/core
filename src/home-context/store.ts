import type Database from 'better-sqlite3'
import type { SignalSnapshot } from '@/src/automation/signals'
import { configVersionSchema, defaultRoomConfig, historyItemSchema, ROOM_HISTORY_LIMIT, ROOM_METRICS, ROOM_RETENTION_MS, roomConfigSchema, roomReportSchema, roomStatusSchema } from './contract'
import type { RoomConfig, RoomMetric } from './contract'

interface Latest {
  metric: RoomMetric
  revision: number
  measuredAt: number | null
  lastMeasuredAt: number | null
  reportedAt: number
  receivedAt: number
  value: number | null
  available: number
}
const latestColumns = 'metric, revision, measured_at AS measuredAt, last_measured_at AS lastMeasuredAt, reported_at AS reportedAt, received_at AS receivedAt, value, available'
export class RoomConfigConflict extends Error {}

/** Durable replay watermarks are separate from process-local proof of a live report. */
export function createRoomContextStore(database: Database.Database, clock = Date.now) {
  let connected = false
  let topic: string | null = null
  const liveReports = new Map<string, number>()
  function now() {
    const value = clock()
    if (!Number.isSafeInteger(value) || value <= 0 || value > 7_999_999_000_000) throw new Error('Room context clock unavailable')
    return value
  }
  function configuration() {
    const row = database.prepare('SELECT revision, config FROM room_context_settings WHERE id = 1').get() as { revision: number, config: string } | undefined
    return configVersionSchema.parse(row ? { revision: row.revision, config: JSON.parse(row.config) } : { revision: 0, config: defaultRoomConfig })
  }
  function status() {
    const generatedAt = now()
    const { revision, config } = configuration()
    const observations = config.mappings.map((mapping) => {
      const latest = database.prepare(`SELECT ${latestColumns} FROM room_context_latest WHERE metric = ? AND revision = ?`).get(mapping.metric, revision) as Latest | undefined
      const expiresAt = latest?.measuredAt ? latest.measuredAt + mapping.maxAgeSeconds * 1000 : null
      const status = !config.enabled
        ? 'disabled'
        : !connected
            ? 'disconnected'
            : !latest || liveReports.get(mapping.metric) !== latest.reportedAt
                ? 'waiting'
                : latest.reportedAt > generatedAt || latest.receivedAt > generatedAt
                  ? 'clock_invalid'
                  : !latest.available
                      ? 'unavailable'
                      : expiresAt === null || expiresAt <= generatedAt ? 'stale' : 'fresh'
      return {
        metric: mapping.metric, entityId: mapping.entityId, unit: ROOM_METRICS[mapping.metric].unit, status,
        value: status === 'fresh' ? latest?.value ?? null : null, lastValue: latest?.value ?? null,
        measuredAt: latest?.measuredAt ?? null, reportedAt: latest?.reportedAt ?? null, receivedAt: latest?.receivedAt ?? null, expiresAt,
      }
    })
    return roomStatusSchema.parse({ apiVersion: 1, generatedAt, revision, config, connected, topic, observations })
  }
  return {
    configuration, status,
    configure(input: RoomConfig, expectedRevision: number) {
      const config = roomConfigSchema.parse(input)
      const result = database.transaction(() => {
        const current = configuration()
        if (current.revision !== expectedRevision) throw new RoomConfigConflict('Room configuration changed. Reload before saving.')
        const revision = current.revision + 1
        database.prepare('INSERT INTO room_context_settings (id, revision, config) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, config = excluded.config')
          .run(revision, JSON.stringify(config))
        database.prepare('DELETE FROM room_context_latest').run()
        return { revision, config }
      })()
      liveReports.clear()
      return result
    },
    connection(ready: boolean, reportTopic: string | null = null) {
      connected = ready
      topic = reportTopic
      liveReports.clear()
    },
    receive(payload: Buffer, flags: { retain: boolean, dup: boolean }) {
      if (!connected || flags.retain || flags.dup || payload.length === 0 || payload.length > 2048) return false
      let report: ReturnType<typeof roomReportSchema.parse>
      try {
        report = roomReportSchema.parse(JSON.parse(payload.toString('utf8')))
      }
      catch { return false }
      const receivedAt = now()
      const accepted = database.transaction(() => {
        const { revision, config } = configuration()
        const mapping = config.mappings.find(candidate => candidate.metric === report.metric)
        if (!config.enabled || report.revision !== revision || !mapping || report.entityId !== mapping.entityId || report.unit !== mapping.unit) return false
        if (report.reportedAt > receivedAt || receivedAt - report.reportedAt >= 30000) return false
        const previous = database.prepare(`SELECT ${latestColumns} FROM room_context_latest WHERE metric = ?`).get(report.metric) as Latest | undefined
        if (previous && (report.reportedAt <= previous.reportedAt || receivedAt < previous.receivedAt)) return false
        // Bound write frequency per sensor; an unavailable transition still
        // withdraws a fresh value immediately, even during a burst.
        if (previous && receivedAt - previous.receivedAt < 5000 && (report.available || !previous.available)) return false
        let value = report.value
        if (report.available && report.measuredAt !== null && value !== null) {
          if (receivedAt - report.measuredAt >= mapping.maxAgeSeconds * 1000 || report.measuredAt <= (previous?.lastMeasuredAt ?? 0)) return false
          if (mapping.unit === '°C') value = value * 9 / 5 + 32
          const definition = ROOM_METRICS[mapping.metric]
          if (value < definition.min || value > definition.max) return false
        }
        const lastMeasuredAt = report.measuredAt ?? previous?.lastMeasuredAt ?? null
        database.prepare(`INSERT INTO room_context_latest (metric, revision, measured_at, last_measured_at, reported_at, received_at, value, available)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(metric) DO UPDATE SET revision = excluded.revision,
          measured_at = excluded.measured_at, last_measured_at = excluded.last_measured_at, reported_at = excluded.reported_at,
          received_at = excluded.received_at, value = excluded.value, available = excluded.available`)
          .run(report.metric, revision, report.measuredAt, lastMeasuredAt, report.reportedAt, receivedAt, value, Number(report.available))
        database.prepare(`INSERT INTO room_context_history (revision, metric, entity_id, unit, measured_at, reported_at, received_at, value, available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(revision, report.metric, mapping.entityId, ROOM_METRICS[mapping.metric].unit, report.measuredAt, report.reportedAt, receivedAt, value, Number(report.available))
        database.prepare('DELETE FROM room_context_history WHERE received_at < ?').run(receivedAt - ROOM_RETENTION_MS)
        database.prepare('DELETE FROM room_context_history WHERE id <= (SELECT id FROM room_context_history ORDER BY id DESC LIMIT 1 OFFSET ?)').run(ROOM_HISTORY_LIMIT)
        return true
      })()
      if (accepted) liveReports.set(report.metric, report.reportedAt)
      return accepted
    },
    signals(): SignalSnapshot {
      try {
        return Object.fromEntries(status().observations.flatMap(item => item.status === 'fresh' && item.value !== null ? [[`room.${item.metric}`, item.value]] : []))
      }
      catch { return {} }
    },
    history(beforeId?: number) {
      const generatedAt = now()
      const items = database.prepare(`SELECT id, revision, metric, entity_id AS entityId, unit, measured_at AS measuredAt,
        reported_at AS reportedAt, received_at AS receivedAt, value, available FROM room_context_history
        WHERE received_at >= ? AND received_at <= ? ${beforeId === undefined ? '' : 'AND id < ?'} ORDER BY id DESC LIMIT 201`)
        .all(generatedAt - ROOM_RETENTION_MS, generatedAt, ...(beforeId === undefined ? [] : [beforeId]))
        .map(row => historyItemSchema.parse({ ...row as object, available: Boolean((row as { available: number }).available) }))
      return { apiVersion: 1 as const, generatedAt, items: items.slice(0, 200), nextBeforeId: items.length > 200 ? items[199].id : null }
    },
  }
}

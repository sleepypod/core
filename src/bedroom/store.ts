import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { BEDROOM_METRICS, bedroomConfigSchema, bedroomReportSchema, bedroomStatusSchema, defaultBedroomConfig } from './contract'
import type { BedroomConfig, BedroomObservation, BedroomReport, BedroomSource } from './contract'
import { bedroomComfortGuidance, combineBedroomSensors } from './fusion'

interface StoredReading {
  sourceId: string
  revision: number
  observedAt: number
  receivedAt: number
  lastMeasuredAt: number | null
  report: string
}
const columns = 'source_id AS sourceId, revision, observed_at AS observedAt, received_at AS receivedAt, last_measured_at AS lastMeasuredAt, report'
const RETENTION_MS = 30 * 86400000
const HISTORY_LIMIT = 250000
export class BedroomConfigConflict extends Error {}

function normalizedValue(source: BedroomSource, value: number | null) {
  return value !== null && source.unit === '°C' ? value * 9 / 5 + 32 : value
}

/** Durable clocks reject replay; process-local receipts prevent restart from promoting saved data to live. */
export function createBedroomStore(database: Database.Database, clock = Date.now) {
  const live = new Map<string, { observedAt: number, transport: 'http' | 'mqtt' }>()
  let mqttConnected = false
  let mqttTopic: string | null = null
  function now() {
    const current = clock()
    if (!Number.isSafeInteger(current) || current <= 0 || current > 7_999_999_000_000) throw new Error('Bedroom clock unavailable')
    return current
  }
  function configuration(): { revision: number, config: BedroomConfig } {
    const row = database.prepare('SELECT revision, config FROM bedroom_settings WHERE id = 1').get() as { revision: number, config: string } | undefined
    return row
      ? { revision: row.revision, config: bedroomConfigSchema.parse(JSON.parse(row.config)) }
      : { revision: 0, config: defaultBedroomConfig }
  }
  function status() {
    const generatedAt = now()
    const { revision, config } = configuration()
    const rows = database.prepare(`SELECT ${columns} FROM bedroom_latest WHERE revision = ?`).all(revision) as StoredReading[]
    const observations: BedroomObservation[] = config.sources.map((source) => {
      const row = rows.find(item => item.sourceId === source.id)
      const report = row ? bedroomReportSchema.parse(JSON.parse(row.report)) : null
      const referenceAt = report?.timeBasis === 'measurement' ? report.measuredAt : report?.observedAt
      const expiresAt = referenceAt ? referenceAt + source.maxAgeSeconds * 1000 : null
      const state = !config.enabled || !source.enabled
        ? 'disabled'
        : !row || !report || live.get(source.id)?.observedAt !== row.observedAt
            ? 'waiting'
            : !report.available
                ? 'unavailable'
                : generatedAt < report.observedAt || expiresAt === null || expiresAt <= generatedAt
                  ? 'stale'
                  : report.timeBasis === 'cached' ? 'cached' : 'fresh'
      const value = report ? normalizedValue(source, report.value) : null
      return { source, status: state, value: state === 'fresh' ? value : null, lastValue: value,
        unit: BEDROOM_METRICS[source.metric].unit, observedAt: report?.observedAt ?? null,
        measuredAt: report?.measuredAt ?? null, receivedAt: row?.receivedAt ?? null, expiresAt,
        timeBasis: report?.timeBasis ?? null, controlEligible: state === 'fresh' && source.useForControl }
    })
    const aggregates = combineBedroomSensors(observations, generatedAt)
    return bedroomStatusSchema.parse({ apiVersion: 1, generatedAt, revision, config, observations, aggregates,
      guidance: bedroomComfortGuidance(aggregates, generatedAt, configurationDigest()), mqtt: { connected: mqttConnected, topic: mqttTopic } })
  }
  function configurationDigest() {
    const { revision, config } = configuration()
    return createHash('sha256').update(JSON.stringify([revision, config])).digest('hex')
  }
  return {
    configuration, configurationDigest, status,
    configure(input: BedroomConfig, expectedRevision: number) {
      const config = bedroomConfigSchema.parse(input)
      const result = database.transaction(() => {
        const current = configuration()
        if (current.revision !== expectedRevision) throw new BedroomConfigConflict('Bedroom configuration changed. Reload before saving.')
        const revision = current.revision + 1
        database.prepare('INSERT INTO bedroom_settings (id, revision, config) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, config=excluded.config')
          .run(revision, JSON.stringify(config))
        database.prepare('DELETE FROM bedroom_latest').run()
        return { revision, config }
      })()
      live.clear()
      return result
    },
    connection(connected: boolean, topic: string | null = null) {
      mqttConnected = connected
      mqttTopic = topic
      for (const [sourceId, receipt] of live) if (receipt.transport === 'mqtt') live.delete(sourceId)
    },
    receive(input: unknown, transport: 'http' | 'mqtt' = 'http') {
      if (transport === 'mqtt' && !mqttConnected) return { accepted: false, reason: 'broker_disconnected' }
      const parsed = bedroomReportSchema.safeParse(input)
      if (!parsed.success) return { accepted: false, reason: 'invalid_report' }
      const report = parsed.data
      const receivedAt = now()
      const result = database.transaction(() => {
        const { revision, config } = configuration()
        const source = config.sources.find(item => item.id === report.sourceId)
        if (!config.enabled || !source?.enabled) return { accepted: false, reason: 'source_not_enabled' }
        if (revision !== report.revision) return { accepted: false, reason: 'configuration_changed' }
        if (report.observedAt > receivedAt || receivedAt - report.observedAt >= 30000) return { accepted: false, reason: 'report_clock' }
        const previous = database.prepare(`SELECT ${columns} FROM bedroom_latest WHERE source_id = ?`).get(source.id) as StoredReading | undefined
        if (previous && (report.observedAt <= previous.observedAt || receivedAt < previous.receivedAt)) return { accepted: false, reason: 'replayed_report' }
        const oldReport: BedroomReport | null = previous ? bedroomReportSchema.parse(JSON.parse(previous.report)) : null
        if (previous && receivedAt - previous.receivedAt < 5000 && (report.available || !oldReport?.available)) return { accepted: false, reason: 'report_too_frequent' }
        const value = normalizedValue(source, report.value)
        if (report.available && value !== null) {
          const definition = BEDROOM_METRICS[source.metric]
          if (value < definition.minimum || value > definition.maximum
            || (['power', 'airQuality'].includes(source.metric) && !Number.isInteger(value))) return { accepted: false, reason: 'invalid_value' }
          const referenceAt = report.timeBasis === 'measurement' ? report.measuredAt : report.observedAt
          if (referenceAt === null) return { accepted: false, reason: 'measurement_clock_missing' }
          if (receivedAt - referenceAt >= source.maxAgeSeconds * 1000) return { accepted: false, reason: 'measurement_expired' }
          if (report.measuredAt !== null && report.measuredAt <= (previous?.lastMeasuredAt ?? 0)) return { accepted: false, reason: 'replayed_measurement' }
        }
        database.prepare(`INSERT INTO bedroom_latest (source_id, revision, observed_at, received_at, last_measured_at, report)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,
          observed_at=excluded.observed_at, received_at=excluded.received_at, last_measured_at=excluded.last_measured_at, report=excluded.report`)
          .run(source.id, revision, report.observedAt, receivedAt, report.measuredAt ?? previous?.lastMeasuredAt ?? null, JSON.stringify(report))
        database.prepare('INSERT INTO bedroom_history (revision, source_id, received_at, source, report) VALUES (?, ?, ?, ?, ?)')
          .run(revision, source.id, receivedAt, JSON.stringify(source), JSON.stringify(report))
        database.prepare('DELETE FROM bedroom_history WHERE received_at < ?').run(receivedAt - RETENTION_MS)
        // Indexed endpoints avoid scanning the entire retained history for every sensor packet.
        database.prepare('DELETE FROM bedroom_history WHERE id <= (SELECT MAX(id) FROM bedroom_history) - ?').run(HISTORY_LIMIT)
        return { accepted: true, reason: 'accepted' }
      })()
      if (result.accepted) live.set(report.sourceId, { observedAt: report.observedAt, transport })
      return result
    },
    guidance() {
      return status().guidance
    },
    signals(): Record<string, number> {
      return Object.fromEntries(status().aggregates.flatMap(item => item.status === 'ready' && item.value !== null
        ? [[`room.${item.metric}`, item.value]]
        : []))
    },
    history(beforeId?: number) {
      const generatedAt = now()
      const rows = database.prepare(`SELECT id, revision, received_at AS receivedAt, source, report FROM bedroom_history
        WHERE received_at >= ? AND received_at <= ? ${beforeId === undefined ? '' : 'AND id < ?'} ORDER BY id DESC LIMIT 201`)
        .all(generatedAt - RETENTION_MS, generatedAt, ...(beforeId === undefined ? [] : [beforeId])) as { id: number, revision: number, receivedAt: number, source: string, report: string }[]
      return { apiVersion: 1 as const, generatedAt, items: rows.slice(0, 200).map(row => ({ ...row,
        source: JSON.parse(row.source) as BedroomSource, report: JSON.parse(row.report) as BedroomReport })),
      nextBeforeId: rows.length > 200 ? rows[199].id : null }
    },
  }
}

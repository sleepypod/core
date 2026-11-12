import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { durableTransaction } from '@/src/db/durable'
import { PREDICTIVE_RECORDING_INTERVAL_MS, PREDICTIVE_RECORDING_RETENTION_MS, predictiveRecordingSchema, predictiveRecordingStatusSchema } from './predictive-recording-contract'
import { thermalConfiguration } from './thermal-dataset'

export const predictiveContentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function verifiedRecord(input: unknown) {
  const record = predictiveRecordingSchema.parse(input)
  if (thermalConfiguration(record.source, record.source.bedroom?.configuration ?? null) !== record.request.configuration) {
    throw new Error('Recorded sensor and routine identities do not match the model configuration.')
  }
  return record
}

/** Stream verified rows so historical inspection does not retain every parsed payload. */
export function* verifiedPredictiveRecordings(database: Database.Database, side: Side, now: number) {
  const records = database.prepare(`SELECT id,observed_at AS observedAt,recorded_at AS recordedAt,session,content_hash AS contentHash,
      length(CAST(record AS BLOB)) AS bytes
      FROM predictive_recordings WHERE side=? AND recorded_at>=? ORDER BY recorded_at DESC LIMIT 9001`)
    .all(side, now - PREDICTIVE_RECORDING_RETENTION_MS) as Array<{ id: string, observedAt: number, recordedAt: number, session: string, contentHash: string, bytes: number }>
  if (records.length > 9000 || records.some(row => row.bytes <= 0 || row.bytes > 32_768)
    || records.reduce((total, row) => total + row.bytes, 0) > 64 * 1024 ** 2) throw new Error('Prospective inspection exceeds its limit.')
  for (const row of records) {
    const payload = database.prepare('SELECT record FROM predictive_recordings WHERE id=?').get(row.id) as { record: string }
    const value = verifiedRecord(JSON.parse(payload.record))
    if (value.id !== row.id || value.request.side !== side || value.recordedAt !== row.recordedAt || value.recordedAt > now
      || value.request.observedAt !== row.observedAt || value.source.session !== row.session
      || predictiveContentHash(value) !== row.contentHash || value.forecasts.requestHash !== predictiveContentHash(value.request)) {
      throw new Error('Prospective evidence failed its integrity check.')
    }
    yield value
  }
}

/** Never replace an existing observation or infer an outcome from the proposed target. */
export function createPredictiveRecordings(database: Database.Database) {
  function append(input: unknown, now: number) {
    const record = verifiedRecord(input)
    if (record.recordedAt > now || now - record.request.observedAt >= 15_000
      || record.forecasts.requestHash !== predictiveContentHash(record.request)) throw new Error('Prospective recording expired or changed.')
    const encoded = JSON.stringify(record)
    if (Buffer.byteLength(encoded) > 32_768) throw new Error('Prospective recording exceeds its limit.')
    return durableTransaction(database, () => {
      const previous = database.prepare('SELECT recorded_at AS at FROM predictive_recordings WHERE side=? ORDER BY recorded_at DESC LIMIT 1')
        .get(record.request.side) as { at: number } | undefined
      if (previous && record.recordedAt - previous.at < PREDICTIVE_RECORDING_INTERVAL_MS) return false
      database.prepare(`INSERT INTO predictive_recordings(id,side,observed_at,recorded_at,session,content_hash,record)
        VALUES (?,?,?,?,?,?,?)`).run(record.id, record.request.side, record.request.observedAt, record.recordedAt,
        record.source.session, predictiveContentHash(record), encoded)
      return true
    })
  }
  function status(side: Side, now: number) {
    const counts = { candidate: 0, hold: 0, withheld: 0 }, nights = new Set<string>()
    let records = 0, latestAt: number | null = null
    for (const value of verifiedPredictiveRecordings(database, side, now)) {
      records++
      latestAt ??= value.recordedAt
      counts[value.selection.disposition]++
      nights.add(value.source.session)
    }
    return predictiveRecordingStatusSchema.parse({ apiVersion: 1, side, generatedAt: now, mode: 'research_preview', activationAvailable: false,
      records, sessions: nights.size, candidates: counts.candidate, holds: counts.hold, withheld: counts.withheld,
      latestAt,
      outcomeNotice: 'Unapplied targets have no observed outcome. These records do not establish comfort benefit.',
      reason: records
        ? 'Production Preview comparisons are recorded at most once every five minutes, with exact source and model identities. No proposed change was sent.'
        : 'Waiting for production Preview, current guarded readings and its five-minute predecessor. No research comparison has been recorded.' })
  }
  function prune(now: number) {
    database.prepare('DELETE FROM predictive_recordings WHERE recorded_at<?').run(now - PREDICTIVE_RECORDING_RETENTION_MS)
  }
  return { append, status, prune }
}

import type Database from 'better-sqlite3'
import { comfortEventSchema } from '../contract'
import { experimentDigest } from './access'
import type { ExperimentGrant } from './admission-contract'
import { ExperimentAdmissions } from './admissions'
import { ExperimentApplicationStore } from './applications'
import type { ExperimentRecord } from './contract'
import { exposureFromObservations, type ExperimentInterruptionSource } from './observed-exposure'
import { ExperimentObservationJournal, type RetainedExperimentWindow } from './observations'

interface AuditCache { stamp: string, at: number, withdrawn: boolean[] }
const shared = globalThis as typeof globalThis & {
  __sp_experimentObservationAudits?: WeakMap<Database.Database, Map<string, AuditCache>>
}

/** This reader cannot prepare/confirm an admission or change a controller mode. */
export function observationSourceReader(database: Database.Database, now: () => number, subject: string) {
  const unavailable = () => {
    throw new Error('Observation verification cannot change execution')
  }
  const admissions = new ExperimentAdmissions({ database, now, validate: unavailable, suspend: unavailable, revokeLease: unavailable })
  return { admissions, journal: new ExperimentObservationJournal({ database, now, grant: (account, id) => admissions.read(account, id) }, subject) }
}

/** Preserve interruption evidence from this admission; later occupants' events cannot enter an old night. */
export function observationInterruptions(database: Database.Database, now: () => number, retained: RetainedExperimentWindow,
  grant: ExperimentGrant): ExperimentInterruptionSource {
  const { binding } = retained
  const cutoff = Math.min(binding.windowEnd, grant.revokedAt === null ? binding.windowEnd : grant.revokedAt + 1)
  const manual = database.prepare(`SELECT id, side, observed_at, event FROM comfort_events
    WHERE observed_at >= ? AND observed_at < ? AND side IN (?, ?) AND json_extract(event, '$.kind') = 'manual_pause'
    ORDER BY observed_at, id LIMIT 10001`).all(binding.windowStart, cutoff, binding.sides[0], binding.sides[1] ?? binding.sides[0]) as {
    id: number
    side: string
    observed_at: number
    event: string
  }[]
  if (manual.length > 10_000) throw new Error('The manual interruption source exceeds its evidence limit')
  const events = manual.map((row) => {
    const event = comfortEventSchema.parse(JSON.parse(row.event))
    if (event.at !== row.observed_at || event.at > now() || event.kind !== 'manual_pause') throw new Error('The manual interruption source changed')
    return { id: row.id, side: row.side, event }
  })
  const applications = new ExperimentApplicationStore(database, now).window(binding.planId, binding.admissionId, binding.windowStart, binding.windowEnd)
  // A later resolution cannot turn an originally uncertain command into an acknowledged treatment.
  const commands = applications.map(value => ({ reservation: value.reservation,
    acknowledged: value.outcome === 'acknowledged', receiptId: value.receiptId }))
  const revokedAt = grant.revokedAt !== null && grant.revokedAt >= binding.windowStart && grant.revokedAt < binding.windowEnd
    ? grant.revokedAt
    : null
  const interruptedAt = Math.min(revokedAt ?? Infinity, ...events.map(item => item.event.at),
    ...commands.filter(value => !value.acknowledged).map(value => value.reservation.reservedAt))
  return { manualChanges: events.length, unconfirmedCommands: commands.filter(value => !value.acknowledged).length,
    admissionInterrupted: revokedAt !== null, interruptedAt: Number.isFinite(interruptedAt) ? interruptedAt : null,
    digest: experimentDigest({ events, commands, revokedAt }) }
}

/** Revalidate only retained windows referenced by this record; an unverifiable source is never a favorable result. */
export function auditObservedExperiment(database: Database.Database, now: () => number, record: ExperimentRecord): ExperimentRecord {
  if (!record.exposures.length) return record
  const caches = shared.__sp_experimentObservationAudits ??= new WeakMap()
  let cache = caches.get(database)
  if (!cache) {
    cache = new Map()
    caches.set(database, cache)
  }
  // Both same-connection changes and commits from other connections invalidate the compact verification cache.
  const changes = database.prepare('SELECT total_changes() AS count').get() as { count: number }
  const stamp = `${database.pragma('data_version', { simple: true })}:${changes.count}`
  const key = experimentDigest({ plan: record.plan, exposures: record.exposures }), at = now(), previous = cache.get(key)
  if (previous && previous.stamp === stamp && at >= previous.at && at - previous.at < 60_000)
    return { ...record, exposures: record.exposures.map((exposure, index) => previous.withdrawn[index]
      ? { ...exposure, sourceState: 'withdrawn' as const }
      : exposure) }
  const { journal, admissions } = observationSourceReader(database, now, record.plan.context.subjectKey)
  const exposures = record.exposures.map((exposure) => {
    if (exposure.sourceState === 'withdrawn') return exposure
    if (!exposure.observationWindowId) return record.plan.version === 2 ? { ...exposure, sourceState: 'withdrawn' as const } : exposure
    try {
      const retained = journal.read(exposure.observationWindowId)
      if (!retained) throw new Error('The observation source was removed')
      const grant = admissions.read(record.plan.context.subjectKey, retained.binding.admissionId)
      const current = exposureFromObservations(record.plan, retained, observationInterruptions(database, now, retained, grant), exposure.recordedAt)
      if (experimentDigest(current) !== experimentDigest(exposure)) throw new Error('The observation summary no longer matches its source')
      return exposure
    }
    catch { return { ...exposure, sourceState: 'withdrawn' as const } }
  })
  const oldest = cache.keys().next().value
  if (cache.size >= 8 && oldest !== undefined) cache.delete(oldest)
  cache.set(key, { stamp, at, withdrawn: exposures.map(exposure => exposure.sourceState === 'withdrawn') })
  return { ...record, exposures }
}

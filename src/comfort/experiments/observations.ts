import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { durableTransaction } from '@/src/db/durable'
import type { ExperimentGrant } from './admission-contract'
import { experimentDateSchema, experimentHashSchema, experimentInstantSchema } from './contract'
import { experimentDigest } from './access'
import { experimentPlanHash } from './plan'
import { ComfortExperimentStore } from './store'
import { EXPERIMENT_OBSERVATION_INTERVAL_MS, MAX_EXPERIMENT_OBSERVATIONS,
  experimentObservationBindingSchema, experimentObservationSchema,
  type ExperimentObservation, type ExperimentObservationBinding } from './observation-contract'

interface WindowRow {
  id: string
  subject_key: string
  admission_id: string
  plan_id: string
  night_date: string
  window_end: number
  sample_count: number
  tail_digest: string
  finalized_at: number | null
  binding: string
}
interface ObservationRow { id: string, window_id: string, position: number, observed_at: number, digest: string, record: string }
export interface ExperimentObservationJournalDeps {
  database: Database.Database
  now(): number
  grant(subjectKey: string, id: string): ExperimentGrant
}
export interface RetainedExperimentWindow {
  binding: ExperimentObservationBinding
  observations: ExperimentObservation[]
  finalizedAt: number | null
  sourceDigest: string
}
const identifier = z.string().uuid()

/** Private immutable source packets, linked to an actual admission and independently checked on read. */
export class ExperimentObservationJournal {
  private readonly database: Database.Database
  private readonly subject: string
  constructor(private readonly deps: ExperimentObservationJournalDeps, subject: string) {
    this.database = deps.database
    this.subject = experimentHashSchema.parse(subject)
  }

  private now() { return experimentInstantSchema.parse(this.deps.now()) }
  private plans() { return new ComfortExperimentStore(this.database, this.subject, this.deps.now) }

  private row(id: string): WindowRow | undefined {
    return this.database.prepare('SELECT * FROM comfort_experiment_observation_windows WHERE id = ? AND subject_key = ?')
      .get(identifier.parse(id), this.subject) as WindowRow | undefined
  }

  private binding(row: WindowRow): ExperimentObservationBinding {
    const binding = experimentObservationBindingSchema.parse(JSON.parse(row.binding))
    const grant = this.deps.grant(this.subject, binding.admissionId), plan = this.plans().read(binding.planId)?.plan
    const window = plan?.version === 2 ? plan.schedule.windows.find(item => item.date === binding.nightDate) : null
    if (row.id !== binding.id || row.subject_key !== binding.subjectKey || binding.subjectKey !== this.subject
      || row.admission_id !== binding.admissionId || row.plan_id !== binding.planId || row.night_date !== binding.nightDate
      || row.window_end !== binding.windowEnd || !plan || !window || grant.review.subjectKey !== this.subject || grant.review.id !== binding.admissionId
      || grant.review.planId !== binding.planId || grant.review.planHash !== binding.planHash
      || experimentPlanHash(plan) !== binding.planHash || window.windowStart !== binding.windowStart || window.windowEnd !== binding.windowEnd
      || JSON.stringify(grant.review.zones.map(zone => zone.side).sort()) !== JSON.stringify([...binding.sides].sort())
      || binding.createdAt < grant.admittedAt || binding.createdAt > this.now()
      || !Number.isSafeInteger(row.sample_count) || row.sample_count < 0 || row.sample_count > MAX_EXPERIMENT_OBSERVATIONS
      || (row.finalized_at !== null && (!Number.isSafeInteger(row.finalized_at) || row.finalized_at < binding.windowEnd || row.finalized_at > this.now())))
      throw new Error('The retained experiment window does not match its admission and scheduled source')
    experimentHashSchema.parse(row.tail_digest)
    return binding
  }

  private packet(row: ObservationRow, binding: ExperimentObservationBinding): ExperimentObservation {
    const value = experimentObservationSchema.parse(JSON.parse(row.record))
    if (row.id !== value.id || row.window_id !== value.windowId || value.windowId !== binding.id || row.observed_at !== value.at
      || value.at < binding.windowStart || value.at >= binding.windowEnd || value.at > this.now()
      || JSON.stringify(value.zones.map(zone => zone.side).sort()) !== JSON.stringify([...binding.sides].sort()))
      throw new Error('A retained observation has inconsistent identity, zones or clock')
    return value
  }

  /** The collector schedules by the persisted clock, including after a process restart. */
  due(admissionId: string, nightDate: string, at: number, initialOnly = false): boolean {
    identifier.parse(admissionId)
    experimentDateSchema.parse(nightDate)
    experimentInstantSchema.parse(at)
    const row = this.database.prepare('SELECT * FROM comfort_experiment_observation_windows WHERE admission_id = ? AND night_date = ? AND subject_key = ?')
      .get(admissionId, nightDate, this.subject) as WindowRow | undefined
    if (!row) return true
    const binding = this.binding(row)
    if (initialOnly) return false
    if (row.finalized_at !== null) return false
    const latest = this.database.prepare('SELECT * FROM comfort_experiment_observations WHERE window_id = ? ORDER BY position DESC LIMIT 1')
      .get(row.id) as ObservationRow | undefined
    if (!latest || latest.position !== row.sample_count - 1 || latest.digest !== row.tail_digest)
      throw new Error('The observation source tail is unavailable')
    const packet = this.packet(latest, binding)
    if (at < packet.at) throw new Error('The observation clock moved backwards')
    return at - packet.at >= EXPERIMENT_OBSERVATION_INTERVAL_MS
  }

  /** Only the runtime collector calls this; both authorization checks share the durable write transaction. */
  append(admissionId: string, nightDate: string, input: Pick<ExperimentObservation, 'at' | 'zones'>, assertCurrent: () => void): string {
    identifier.parse(admissionId)
    experimentDateSchema.parse(nightDate)
    return durableTransaction(this.database, () => {
      assertCurrent()
      const now = this.now(), grant = this.deps.grant(this.subject, admissionId), saved = this.plans().read(grant.review.planId)
      const plan = saved?.plan, window = plan?.version === 2 ? plan.schedule.windows.find(item => item.date === nightDate) : null
      if (!plan || !window || saved?.status !== 'planned' || grant.review.subjectKey !== this.subject || grant.review.id !== admissionId || grant.revokedAt !== null
        || experimentPlanHash(plan) !== grant.review.planHash || input.at < grant.admittedAt || input.at >= grant.endsAt
        || input.at < window.windowStart || input.at >= window.windowEnd || input.at > now || now - input.at > EXPERIMENT_OBSERVATION_INTERVAL_MS)
        throw new Error('Only a current admitted treatment window can record a live observation')
      let row = this.database.prepare('SELECT * FROM comfort_experiment_observation_windows WHERE admission_id = ? AND night_date = ? AND subject_key = ?')
        .get(admissionId, nightDate, this.subject) as WindowRow | undefined
      if (!row) {
        const binding = experimentObservationBindingSchema.parse({ version: 1, id: randomUUID(), subjectKey: this.subject,
          admissionId, planId: plan.id, planHash: grant.review.planHash, nightDate, windowStart: window.windowStart,
          windowEnd: window.windowEnd, sides: grant.review.zones.map(zone => zone.side), createdAt: input.at })
        this.database.prepare(`INSERT INTO comfort_experiment_observation_windows
          (id, subject_key, admission_id, plan_id, night_date, window_end, tail_digest, binding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(binding.id, this.subject, admissionId, plan.id, nightDate, window.windowEnd, experimentDigest(binding), JSON.stringify(binding))
        row = this.row(binding.id)
      }
      if (!row) throw new Error('The observation window could not be saved')
      const binding = this.binding(row)
      if (row.finalized_at !== null) throw new Error('A finalized observation window cannot be appended')
      const packet = experimentObservationSchema.parse({ ...input, version: 1, id: randomUUID(), windowId: row.id })
      // Validate exact zones and clocks through the same path used by an independent reader.
      this.packet({ id: packet.id, window_id: row.id, position: row.sample_count, observed_at: packet.at, digest: '', record: JSON.stringify(packet) }, binding)
      const latest = this.database.prepare('SELECT * FROM comfort_experiment_observations WHERE window_id = ? ORDER BY position DESC LIMIT 1')
        .get(row.id) as ObservationRow | undefined
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_observations WHERE window_id = ?').get(row.id) as { count: number }
      if (count.count !== row.sample_count || (latest ? latest.position !== row.sample_count - 1 || latest.digest !== row.tail_digest : row.sample_count !== 0))
        throw new Error('Retained observations changed; do not extend an unverified source')
      if (latest?.observed_at === packet.at) {
        const previous = this.packet(latest, binding)
        if (JSON.stringify(previous.zones) !== JSON.stringify(packet.zones)) throw new Error('The observation clock was reused with different measurements')
        assertCurrent()
        return row.id
      }
      if (latest && packet.at - latest.observed_at < EXPERIMENT_OBSERVATION_INTERVAL_MS)
        throw new Error('Observation clocks must advance by at least ten seconds')
      if (row.sample_count >= MAX_EXPERIMENT_OBSERVATIONS) throw new Error('The bounded observation window is full')
      const digest = experimentDigest({ previous: row.tail_digest, position: row.sample_count, observation: packet })
      this.database.prepare('INSERT INTO comfort_experiment_observations (id, window_id, position, observed_at, digest, record) VALUES (?, ?, ?, ?, ?, ?)')
        .run(packet.id, row.id, row.sample_count, packet.at, digest, JSON.stringify(packet))
      this.database.prepare('UPDATE comfort_experiment_observation_windows SET sample_count = sample_count + 1, tail_digest = ? WHERE id = ?')
        .run(digest, row.id)
      assertCurrent()
      return row.id
    })
  }

  /** Recompute the complete digest chain; a saved summary cannot conceal deleted or altered inputs. */
  read(id: string): RetainedExperimentWindow | null {
    return this.database.transaction(() => {
      const row = this.row(id)
      if (!row) return null
      const binding = this.binding(row)
      const rows = this.database.prepare('SELECT * FROM comfort_experiment_observations WHERE window_id = ? ORDER BY position LIMIT ?')
        .all(row.id, MAX_EXPERIMENT_OBSERVATIONS + 1) as ObservationRow[]
      if (rows.length !== row.sample_count) throw new Error('Retained observations are missing or exceed their recorded count')
      let digest = experimentDigest(binding), previousAt: number | null = null
      const observations = rows.map((item, position) => {
        const observation = this.packet(item, binding)
        if (item.position !== position || (previousAt !== null && observation.at - previousAt < EXPERIMENT_OBSERVATION_INTERVAL_MS))
          throw new Error('Retained observation ordering changed')
        digest = experimentDigest({ previous: digest, position, observation })
        if (digest !== item.digest) throw new Error('Retained observation content changed')
        previousAt = observation.at
        return observation
      })
      if (digest !== row.tail_digest) throw new Error('The retained observation tail changed')
      return { binding, observations, finalizedAt: row.finalized_at,
        sourceDigest: experimentDigest({ binding, count: row.sample_count, tail: digest, finalizedAt: row.finalized_at }) }
    }).immediate()
  }

  /** Seal only after the original complete window, including when it ended with missing samples. */
  finalize(id: string, assertCurrent: () => void, publish?: (retained: RetainedExperimentWindow) => void): RetainedExperimentWindow {
    return durableTransaction(this.database, () => {
      assertCurrent()
      const current = this.read(id), now = this.now()
      if (!current || now < current.binding.windowEnd) throw new Error('The original observation window has not completed')
      if (current.finalizedAt === null) this.database.prepare('UPDATE comfort_experiment_observation_windows SET finalized_at = ? WHERE id = ? AND subject_key = ?')
        .run(now, id, this.subject)
      assertCurrent()
      const result = this.read(id)
      if (!result) throw new Error('The finalized observations are unavailable')
      publish?.(result)
      assertCurrent()
      return result
    })
  }
}

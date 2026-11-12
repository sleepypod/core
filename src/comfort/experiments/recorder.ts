import type Database from 'better-sqlite3'
import type { ExperimentGrant } from './admission-contract'
import type { ExperimentObservation } from './observation-contract'
import { ExperimentObservationJournal } from './observations'
import { observationInterruptions } from './observation-source'
import { exposureFromObservations } from './observed-exposure'
import { ComfortExperimentStore } from './store'

export interface ExperimentRecorderDeps {
  database: Database.Database
  now(): number
  grant(subject: string, id: string): ExperimentGrant
}

/** Collect source packets and publish bounded completed windows; never owns a hardware command. */
export class ExperimentRecorder {
  private cursor?: { end: number, id: string }
  constructor(private readonly deps: ExperimentRecorderDeps) {}
  private journal(subject: string) { return new ExperimentObservationJournal(this.deps, subject) }

  /** Startup and periodic execution audits check the complete current source before renewing treatment. */
  audit(grant: ExperimentGrant): void {
    const rows = this.deps.database.prepare(`SELECT id FROM comfort_experiment_observation_windows
      WHERE admission_id = ? AND subject_key = ? AND finalized_at IS NULL`).all(grant.review.id, grant.review.subjectKey) as { id: string }[]
    if (rows.length > 16) throw new Error('The experiment has too many open observation windows')
    for (const row of rows) this.journal(grant.review.subjectKey).read(row.id)
  }

  record(grant: ExperimentGrant, capture: () => Pick<ExperimentObservation, 'at' | 'zones'>, assertCurrent: () => void, initialOnly = false): void {
    const { review } = grant, now = this.deps.now()
    const plan = new ComfortExperimentStore(this.deps.database, review.subjectKey, this.deps.now).read(review.planId)?.plan
    const window = plan?.version === 2 ? plan.schedule.windows.find(item => now >= item.windowStart && now < item.windowEnd) : null
    if (!window) return
    const journal = this.journal(review.subjectKey)
    if (!journal.due(review.id, window.date, now, initialOnly)) return
    assertCurrent()
    const packet = capture()
    journal.append(review.id, window.date, packet, assertCurrent)
  }

  /** Finalize at most two windows per tick; a corrupt source cannot starve later completed nights. */
  finishReady(): void {
    const { database, now } = this.deps, cursor = this.cursor
    const rows = database.prepare(`SELECT id, subject_key, window_end FROM comfort_experiment_observation_windows
      WHERE finalized_at IS NULL AND window_end <= ? AND (window_end > ? OR (window_end = ? AND id > ?))
      ORDER BY window_end, id LIMIT 2`).all(now(), cursor?.end ?? -1, cursor?.end ?? -1, cursor?.id ?? '') as {
      id: string
      subject_key: string
      window_end: number
    }[]
    if (!rows.length) {
      this.cursor = undefined
      return
    }
    for (const row of rows) {
      this.cursor = { end: row.window_end, id: row.id }
      try {
        this.journal(row.subject_key).finalize(row.id, () => {}, (retained) => {
          const grant = this.deps.grant(row.subject_key, retained.binding.admissionId)
          const store = new ComfortExperimentStore(database, row.subject_key, now), record = store.read(retained.binding.planId)
          if (!record) throw new Error('The experiment source plan was removed')
          const exposure = exposureFromObservations(record.plan, retained, observationInterruptions(database, now, retained, grant), now())
          store.saveExposure(record.plan.id, record.revision, exposure)
        })
      }
      catch { /* The transaction retains an unsealed source for a later retry; no comparison is fabricated. */ }
    }
    if (rows.length < 2) this.cursor = undefined
  }
}

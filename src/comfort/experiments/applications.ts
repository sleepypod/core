import type Database from 'better-sqlite3'
import { z } from 'zod'
import { durableTransaction } from '@/src/db/durable'
import type { Side } from '@/src/hardware/types'
import { temperatureApplicationInputSchema, type TemperatureApplicationReceipt } from '@/src/temperature/applications'
import { DEVICE_MAX_AGE_MS } from '../policy'
import { experimentInstantSchema } from './contract'
import { EXPERIMENT_LEASE_MS, experimentApplicationSchema, experimentReservationSchema, type ExperimentApplication, type ExperimentApplicationReservation } from './application-contract'
import { experimentAuthorityRequestId } from './exposure'
import { checkedExperimentRecord, experimentNightAt, experimentPlanHash } from './plan'

interface Row { id: string, plan_id: string, side: string, outcome: string, reserved_at: number, record: string }

/** Trusted execution journal. This repository grants no activation and exposes no public mutation. */
export class ExperimentApplicationStore {
  constructor(private readonly database: Database.Database, private readonly now = Date.now) {}

  private decode(row: Row): ExperimentApplication {
    const value = experimentApplicationSchema.parse(JSON.parse(row.record)), reservation = value.reservation
    if (row.id !== reservation.id || row.plan_id !== reservation.planId || row.side !== reservation.side
      || row.reserved_at !== reservation.reservedAt || row.outcome !== value.outcome
      || reservation.reservedAt > this.now() || (value.finishedAt !== null && value.finishedAt > this.now())
      || (value.resolution !== null && value.resolution.resolvedAt > this.now()))
      throw new Error('The experiment application identity or clock is inconsistent')
    return value
  }

  latest(side: Side): ExperimentApplication | null {
    z.enum(['left', 'right']).parse(side)
    const row = this.database.prepare('SELECT * FROM comfort_experiment_applications WHERE side = ? ORDER BY sequence DESC LIMIT 1').get(side) as Row | undefined
    return row ? this.decode(row) : null
  }

  forAdmission(planId: string, admissionId: string, side: Side): ExperimentApplication | null {
    const row = this.database.prepare(`SELECT * FROM comfort_experiment_applications
      WHERE plan_id = ? AND side = ? AND json_extract(record, '$.reservation.admissionRevision') = ?
      ORDER BY sequence DESC LIMIT 1`).get(z.string().uuid().parse(planId),
      z.enum(['left', 'right']).parse(side), z.string().uuid().parse(admissionId)) as Row | undefined
    return row ? this.decode(row) : null
  }

  /** Bounded retained command evidence, scoped to the original admission and night. */
  window(planId: string, admissionId: string, start: number, end: number): ExperimentApplication[] {
    z.string().uuid().parse(planId)
    z.string().uuid().parse(admissionId)
    experimentInstantSchema.parse(start)
    experimentInstantSchema.parse(end)
    if (end <= start || end - start > 26 * 3_600_000) throw new Error('Invalid experiment application window')
    const rows = this.database.prepare(`SELECT * FROM comfort_experiment_applications
      WHERE plan_id = ? AND reserved_at >= ? AND reserved_at < ? ORDER BY sequence LIMIT 10001`)
      .all(planId, start, end) as Row[]
    if (rows.length > 10_000) throw new Error('The experiment application window exceeds its evidence limit')
    return rows.map(row => this.decode(row)).filter(value => value.reservation.admissionRevision === admissionId)
  }

  private read(id: string): ExperimentApplication {
    const row = this.database.prepare('SELECT * FROM comfort_experiment_applications WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('The experiment application is unavailable')
    return this.decode(row)
  }

  /** Commit intent with FULL synchronization before the shared authority may send any bytes. */
  reserve(input: ExperimentApplicationReservation, assertCurrent: () => void): void {
    const value = experimentReservationSchema.parse(input)
    durableTransaction(this.database, () => {
      assertCurrent()
      const now = experimentInstantSchema.parse(this.now())
      if (value.reservedAt > now || now - value.reservedAt >= EXPERIMENT_LEASE_MS) throw new Error('The experiment application clock changed')
      const row = this.database.prepare('SELECT id, subject_key, revision, status, updated_at, record FROM comfort_experiments WHERE id = ?').get(value.planId) as {
        id: string
        subject_key: string
        revision: string
        status: string
        updated_at: number
        record: string
      } | undefined
      const record = row && checkedExperimentRecord(JSON.parse(row.record)), plan = record?.plan
      const window = plan?.version === 2 && plan.schedule.windows.find(item => item.date === value.nightDate)
      const night = plan && window ? experimentNightAt(plan, window.windowStart) : null
      if (!record || record.status !== 'planned' || record.updatedAt > now || !plan || !window || !night
        || plan.id !== value.planId || row?.subject_key !== plan.context.subjectKey || row.revision !== record.revision
        || row.status !== record.status || row.updated_at !== record.updatedAt
        || value.planHash !== experimentPlanHash(plan) || value.requestId !== experimentAuthorityRequestId(plan, night.date)
        || value.targetF !== night.targetF || now < window.windowStart || now >= window.windowEnd)
        throw new Error('The experiment no longer admits this scheduled application')
      const previous = this.latest(value.side)
      if (previous && (['attempting', 'unknown'].includes(previous.outcome)
        || (previous.outcome === 'resolved' && previous.reservation.admissionRevision === value.admissionRevision)))
        throw new Error('The previous experiment application needs reviewed recovery and a new admission')
      const application: ExperimentApplication = { reservation: value, outcome: 'attempting', receiptId: null, finishedAt: null, resolution: null }
      this.database.prepare('INSERT INTO comfort_experiment_applications (id, plan_id, side, outcome, reserved_at, record) VALUES (?, ?, ?, ?, ?, ?)')
        .run(value.id, value.planId, value.side, application.outcome, value.reservedAt, JSON.stringify(application))
      assertCurrent()
    })
  }

  /** Match the shared journal as well as the receipt: acceptance is never physical verification. */
  finish(reservation: ExperimentApplicationReservation, receipt: TemperatureApplicationReceipt | null): void {
    durableTransaction(this.database, () => {
      const current = this.read(reservation.id), now = experimentInstantSchema.parse(this.now())
      if (JSON.stringify(current.reservation) !== JSON.stringify(experimentReservationSchema.parse(reservation))
        || current.outcome !== 'attempting') throw new Error('The experiment application reservation changed')
      if (receipt) {
        const row = this.database.prepare('SELECT attempted_at, finished_at, outcome, request FROM temperature_applications WHERE attempt_id = ?')
          .get(receipt.attemptId) as { attempted_at: number, finished_at: number | null, outcome: string, request: string } | undefined
        const request = row && temperatureApplicationInputSchema.parse(JSON.parse(row.request))
        if (receipt.outcome !== 'acknowledged' || receipt.finishedAt === null || receipt.attemptedAt < reservation.reservedAt
          || receipt.finishedAt < receipt.attemptedAt || receipt.finishedAt > now || row?.outcome !== 'acknowledged'
          || row.attempted_at !== receipt.attemptedAt || row.finished_at !== receipt.finishedAt
          || request?.side !== reservation.side || request.source !== 'autopilot'
          || request.requestId !== reservation.requestId || request.targetF !== reservation.targetF)
          throw new Error('The shared temperature journal does not confirm this application')
      }
      const updated = experimentApplicationSchema.parse({ ...current, outcome: receipt ? 'acknowledged' : 'unknown',
        receiptId: receipt?.attemptId ?? null, finishedAt: receipt?.finishedAt ?? now })
      this.write(updated, 'attempting')
    })
  }

  /** Explicit recovery only. The old admission remains unusable even after a fresh readback. */
  resolve(id: string, observation: { targetF: number, observedAt: number }, assertCurrent: () => void): void {
    z.string().uuid().parse(id)
    durableTransaction(this.database, () => {
      assertCurrent()
      const current = this.read(id), now = experimentInstantSchema.parse(this.now())
      if (!['attempting', 'unknown'].includes(current.outcome) || !Number.isSafeInteger(observation.observedAt)
        || observation.observedAt <= Math.max(current.reservation.reservedAt, current.finishedAt ?? 0) || observation.observedAt > now
        || now - observation.observedAt >= DEVICE_MAX_AGE_MS)
        throw new Error('Recovery needs a fresh observation after the unresolved application')
      const updated = experimentApplicationSchema.parse({ ...current, outcome: 'resolved',
        resolution: { ...observation, resolvedAt: now } })
      this.write(updated, current.outcome)
      assertCurrent()
    })
  }

  private write(value: ExperimentApplication, previous: ExperimentApplication['outcome']) {
    const result = this.database.prepare('UPDATE comfort_experiment_applications SET outcome = ?, record = ? WHERE id = ? AND outcome = ?')
      .run(value.outcome, JSON.stringify(value), value.reservation.id, previous)
    if (result.changes !== 1) throw new Error('The experiment application changed')
  }
}

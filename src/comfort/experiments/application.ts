import { randomUUID } from 'node:crypto'
import { ControlGuardError, withinDispatchGuard } from '@/src/controls/context'
import type { Side } from '@/src/hardware/types'
import type { PolicyApplication, TemperatureController, TemperatureRequest } from '@/src/temperature/controller'
import type { TemperatureApplicationReceipt } from '@/src/temperature/applications'
import { DEVICE_MAX_AGE_MS, PRESENCE_MAX_AGE_MS } from '../policy'
import type { ExperimentContext, ExperimentRecord, ExperimentWindow } from './contract'
import type { ExperimentSample } from './exposure'
import { experimentAuthorityRequestId, experimentRequestId } from './exposure'
import { checkedExperimentRecord, experimentContextMatches, experimentNightAt, experimentPlanHash } from './plan'
import { EXPERIMENT_LEASE_MS, EXPERIMENT_POLICY, experimentAdmissionSchema, experimentApplicationSchema,
  type ExperimentAdmission, type ExperimentApplication, type ExperimentApplicationReservation } from './application-contract'
export interface ExperimentExecutionSnapshot {
  record: ExperimentRecord
  context: ExperimentContext
  admission: ExperimentAdmission | null
  sample: ExperimentSample
  enabled: boolean
  adaptationSuspended: boolean
  manualPausedUntil: number
  application: ExperimentApplication | null
}
export interface ExperimentApplicationDeps {
  now(): number
  monotonicNow(): number
  withSideLock<T>(side: Side, work: () => Promise<T>): Promise<T>
  authority: Pick<TemperatureController, 'replacePolicy'>
  /** Must not call authority.status(): selection invokes this reader recursively. */
  read(side: Side, now: number): ExperimentExecutionSnapshot | null
  /** Must durably reserve before returning. A failed completion must retain unresolved intent. */
  reserve(value: ExperimentApplicationReservation, assertCurrent: () => void): void
  finish(value: ExperimentApplicationReservation, receipt: TemperatureApplicationReceipt | null): void
}
interface Candidate {
  generation: number
  side: Side
  at: number
  expiresAt: number
  monotonicAt: number
  monotonicEnd: number
  window: ExperimentWindow
  admissionRevision: string
  planId: string
  planHash: string
  requestId: string
  authorityRequestId: string
  targetF: number
  reservationId: string | null
}
const fresh = (source: number | null, now: number, maximumAge: number) => source !== null
  && Number.isSafeInteger(source) && source <= now && source >= now - maximumAge

/**
 * Apply a qualified treatment through the existing authority, never directly to hardware.
 * This adapter is not started by production until durable admission/journaling are integrated.
 */
export class ExperimentApplicationAdapter {
  private generations: Record<Side, number> = { left: 0, right: 0 }
  private published = new Set<Side>()
  private failedAdmission: Partial<Record<Side, string>> = {}
  constructor(private readonly deps: ExperimentApplicationDeps) {}

  /** Immediately invalidates queued proposals; reconciliation reveals the current independent plan. */
  revoke(side: Side) { this.generations[side]++ }

  async reconcile(side: Side): Promise<void> {
    const generation = ++this.generations[side]
    const candidate = await this.deps.withSideLock(side, async () => this.candidate(side, generation))
    if (!candidate && !this.published.has(side)) return
    const current = () => this.generations[side] === generation
    const requests: TemperatureRequest[] = candidate
      ? [{ id: candidate.requestId, source: 'autopilot',
          temperature: candidate.targetF, startsAt: candidate.at, expiresAt: candidate.expiresAt,
          createdAt: candidate.window.windowStart, priority: Number.MIN_SAFE_INTEGER + 1 }]
      : []
    this.published.add(side)
    await this.deps.authority.replacePolicy(side, EXPERIMENT_POLICY, requests,
      () => candidate !== null && this.eligible(candidate), current,
      candidate ? this.application(candidate) : undefined)
    if (!candidate && current()) this.published.delete(side)
  }

  private snapshot(side: Side, now: number, reservationId: string | null = null): ExperimentExecutionSnapshot | null {
    const snapshot = this.deps.read(side, now)
    if (!snapshot || !Number.isSafeInteger(now) || now < 0) return null
    const { record, admission, sample, context, application } = snapshot
    checkedExperimentRecord(record)
    const granted = experimentAdmissionSchema.safeParse(admission)
    if (application) experimentApplicationSchema.parse(application)
    const ownAttempt = application?.outcome === 'attempting' && application.reservation.id === reservationId
    const unresolved = application && application.outcome !== 'acknowledged' && !ownAttempt
      && (application.outcome !== 'resolved' || application.reservation.admissionRevision === admission?.revision)
    if (snapshot.enabled !== true || snapshot.adaptationSuspended !== true || unresolved
      || !Number.isSafeInteger(snapshot.manualPausedUntil) || snapshot.manualPausedUntil < 0 || snapshot.manualPausedUntil > now
      || record.status !== 'planned' || record.updatedAt > now || record.plan.version !== 2
      || !experimentContextMatches(record.plan, context) || !admission || !granted.success
      || this.failedAdmission[side] === admission.revision || admission.planHash !== experimentPlanHash(record.plan)
      || !admission.sides.includes(side)
      || admission.issuedAt < record.plan.createdAt || admission.issuedAt > now || admission.expiresAt <= now
      || sample.at !== now || !fresh(sample.deviceAt, now, DEVICE_MAX_AGE_MS)
      || !fresh(sample.presenceAt, now, PRESENCE_MAX_AGE_MS) || sample.occupied !== true
      || sample.waterAdequate !== true || sample.powered !== true || sample.priming !== false
      || sample.vibrating !== false || sample.baseMoving !== false || sample.attributionAmbiguous !== false
      || sample.bindingHash !== context.bindingHash || sample.routineHash !== context.routineHash || sample.wakeHash !== context.wakeHash)
      return null
    if (application && (application.reservation.side !== side || application.reservation.reservedAt > now
      || (application.finishedAt !== null && application.finishedAt > now))) return null
    if (ownAttempt && (application.reservation.planId !== record.plan.id
      || application.reservation.admissionRevision !== admission.revision)) return null
    return snapshot
  }

  private safeSnapshot(side: Side, now: number, reservationId: string | null = null) {
    try {
      return this.snapshot(side, now, reservationId)
    }
    catch { return null /* Corrupt or unavailable evidence withdraws admission. */ }
  }

  private candidate(side: Side, generation: number): Candidate | null {
    const now = this.deps.now(), monotonic = this.deps.monotonicNow()
    const snapshot = this.safeSnapshot(side, now)
    if (!snapshot || snapshot.record.plan.version !== 2 || !snapshot.admission
      || !Number.isFinite(monotonic) || monotonic < 0) return null
    const { plan } = snapshot.record
    const window = plan.schedule.windows.find(item => now >= item.windowStart && now < item.windowEnd)
    const night = window && experimentNightAt(plan, window.windowStart)
    if (!window || !night) return null
    const requestId = experimentRequestId(plan, night.date)
    if (!this.targetCurrent(snapshot, side, window, night.targetF, now)) return null
    const awaiting = snapshot.application?.outcome === 'acknowledged' && snapshot.application.reservation.nightDate === window.date
      && snapshot.application.finishedAt !== null && (snapshot.sample.deviceAt ?? 0) < snapshot.application.finishedAt
    const expiresAt = Math.min(now + EXPERIMENT_LEASE_MS, window.windowEnd, snapshot.admission.expiresAt,
      awaiting ? (snapshot.application?.finishedAt ?? now) + EXPERIMENT_LEASE_MS : Infinity,
      (snapshot.sample.deviceAt as number) + DEVICE_MAX_AGE_MS, (snapshot.sample.presenceAt as number) + PRESENCE_MAX_AGE_MS)
    if (expiresAt <= now) return null
    return { generation, side, at: now, expiresAt, monotonicAt: monotonic, monotonicEnd: monotonic + expiresAt - now,
      window, admissionRevision: snapshot.admission.revision, planId: plan.id, planHash: experimentPlanHash(plan),
      requestId, authorityRequestId: experimentAuthorityRequestId(plan, night.date), targetF: night.targetF, reservationId: null }
  }

  private targetCurrent(snapshot: ExperimentExecutionSnapshot, side: Side, window: ExperimentWindow, targetF: number, now: number) {
    const { application, sample, admission } = snapshot
    if (!admission) return false
    const own = application?.outcome === 'acknowledged' && application.reservation.planId === snapshot.record.plan.id
      && application.reservation.admissionRevision === admission.revision && application.reservation.nightDate === window.date
    if (own && application.finishedAt !== null && sample.targetF !== targetF) {
      if (sample.deviceAt !== null && sample.deviceAt < application.finishedAt
        && now < application.finishedAt + EXPERIMENT_LEASE_MS && sample.targetF === application.reservation.previousF) return true
      this.failedAdmission[side] = admission.revision
      return false
    }
    if (sample.targetF === targetF || sample.targetF === snapshot.record.plan.context.baselineF) return true
    this.failedAdmission[side] = admission.revision
    return false
  }

  /** Repeat live evidence after side-lock/transport waits and at the actual FIFO write. */
  private eligible(candidate: Candidate): boolean {
    const current = () => {
      const now = this.deps.now(), monotonic = this.deps.monotonicNow()
      return this.generations[candidate.side] === candidate.generation && this.failedAdmission[candidate.side] !== candidate.admissionRevision
        && now >= candidate.at && now < candidate.expiresAt
        && Number.isFinite(monotonic) && monotonic >= candidate.monotonicAt && monotonic < candidate.monotonicEnd
    }
    if (!current()) return false
    const snapshot = this.safeSnapshot(candidate.side, this.deps.now(), candidate.reservationId)
    return snapshot !== null && snapshot.admission?.revision === candidate.admissionRevision
      && snapshot.record.plan.id === candidate.planId && experimentPlanHash(snapshot.record.plan) === candidate.planHash
      && this.targetCurrent(snapshot, candidate.side, candidate.window, candidate.targetF, this.deps.now())
      && current()
  }

  private application(candidate: Candidate): PolicyApplication {
    return async (input, execute) => {
      if (!this.eligible(candidate) || input.targetF !== candidate.targetF
        || input.side !== candidate.side || input.source !== 'autopilot'
        || input.requestId !== candidate.authorityRequestId) throw new ControlGuardError()
      const snapshot = this.safeSnapshot(candidate.side, this.deps.now())
      if (!snapshot || snapshot.sample.targetF === null) throw new ControlGuardError()
      // Wait for a new poll before another write; a stale pre-command target is not a failed treatment.
      if (snapshot.application?.outcome === 'acknowledged' && snapshot.application.finishedAt !== null
        && (snapshot.sample.deviceAt === null || snapshot.sample.deviceAt < snapshot.application.finishedAt)) throw new ControlGuardError()
      const reservation: ExperimentApplicationReservation = { id: randomUUID(), planId: candidate.planId, planHash: candidate.planHash,
        admissionRevision: candidate.admissionRevision, side: candidate.side, nightDate: candidate.window.date,
        requestId: input.requestId, targetF: candidate.targetF, previousF: snapshot.sample.targetF, reservedAt: this.deps.now() }
      candidate.reservationId = reservation.id
      const assertCurrent = () => {
        if (!this.eligible(candidate)) throw new ControlGuardError()
      }
      try {
        this.deps.reserve(reservation, assertCurrent)
        const receipt = await withinDispatchGuard(assertCurrent, execute)
        const acknowledged = receipt?.outcome === 'acknowledged' && receipt.finishedAt !== null
          && receipt.attemptedAt >= reservation.reservedAt && receipt.finishedAt >= receipt.attemptedAt
          && receipt.finishedAt <= this.deps.now()
        if (!acknowledged) this.failedAdmission[candidate.side] = candidate.admissionRevision
        this.deps.finish(reservation, acknowledged ? receipt : null)
      }
      catch (error) {
        this.failedAdmission[candidate.side] = candidate.admissionRevision
        try {
          this.deps.finish(reservation, null)
        }
        catch { /* A durable reservation must remain unresolved if completion fails. */ }
        throw error
      }
      finally { candidate.reservationId = null }
    }
  }
}

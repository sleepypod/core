import { randomUUID } from 'node:crypto'
import type { Side } from '@/src/hardware/types'
import { ControlGuardError } from '@/src/controls/context'
import type { PolicyApplication, TemperatureController, TemperatureRequest } from '@/src/temperature/controller'
import type { ComfortApplication } from './application-contract'
import { comfortEvent, type ComfortStore } from './store'
import { decideComfort, MANUAL_PAUSE_MS, type ComfortContext, type ComfortState } from './policy'

const PRODUCER = 'personal-comfort'
const LEASE_MS = 10_000

/** Supplied only by an owner-activation service that has verified qualification and night evidence. */
export interface ComfortAdmission {
  revision: string
  issuedAt: number
  expiresAt: number
}

export interface ComfortApplicationDeps {
  now(): number
  monotonicNow(): number
  store: ComfortStore
  authority: Pick<TemperatureController, 'replacePolicy'>
  withSideLock<T>(side: Side, work: () => Promise<T>): Promise<T>
  autopilotEnabled(): boolean
  admission(side: Side, state: ComfortState): ComfortAdmission | null
  pendingPause(side: Side): number | null
  /** Must not call authority.status(): this reader is also called from selection/dispatch guards. */
  readContext(side: Side, state: ComfortState, now: number): ComfortContext
}

interface Candidate {
  id: string
  side: Side
  generation: number
  at: number
  createdAt: number
  expiresAt: number
  monotonicStart: number
  monotonicDeadline: number
  admissionRevision: string
  config: string
  offsetF: number
  segment: string
  targetF: number
  previousF: number
  applying: boolean
}

function admitted(admission: ComfortAdmission | null, now: number): admission is ComfortAdmission {
  return admission !== null && admission.revision.length > 0
    && Number.isSafeInteger(admission.issuedAt) && admission.issuedAt > 0 && admission.issuedAt <= now
    && Number.isSafeInteger(admission.expiresAt) && now < admission.expiresAt
}

function awaitingTarget(state: ComfortState, context: ComfortContext): boolean {
  const application = state.application
  return application?.outcome === 'acknowledged' && application.finishedAt !== null
    && context.now >= application.finishedAt && context.now < application.finishedAt + LEASE_MS
    && application.segment === context.window?.segment
    && context.device.observedAt !== null && context.device.observedAt < application.finishedAt
    && context.device.targetF === application.previousF
}

/**
 * The owner activation service must verify qualification and night evidence before admission.
 * Proposals enter the shared authority; this class never calls a hardware client or powers a side on.
 */
export class ComfortApplicationAdapter {
  private generations: Record<Side, number> = { left: 0, right: 0 }
  private unexpectedTargets: Partial<Record<Side, number>> = {}
  private published = new Set<Side>()

  constructor(private readonly deps: ComfortApplicationDeps) {}

  /** Invalidate immediately; ordinary authority reconciliation restores the remaining owner. */
  revoke(side: Side): void {
    this.generations[side]++
  }

  async reconcile(side: Side): Promise<void> {
    const generation = ++this.generations[side]
    const candidate = await this.deps.withSideLock(side, async () => this.candidate(side, generation))
    // An inert Preview/withheld adapter must not trigger baseline reconciliation.
    if (!candidate && !this.published.has(side)) return
    // A newer evaluation or stop must never be overwritten by work queued before it.
    const current = () => this.generations[side] === generation
    const request: TemperatureRequest[] = candidate
      ? [{
          id: candidate.id, source: 'autopilot', temperature: candidate.targetF,
          startsAt: candidate.at, expiresAt: candidate.expiresAt, createdAt: candidate.createdAt,
          priority: Number.MIN_SAFE_INTEGER,
        }]
      : []
    this.published.add(side)
    await this.deps.authority.replacePolicy(side, PRODUCER, request,
      () => candidate !== null && this.eligible(candidate), current,
      candidate ? this.application(candidate) : undefined)
    if (!candidate && current()) this.published.delete(side)
  }

  private candidate(side: Side, generation: number): Candidate | null {
    const now = this.deps.now()
    let state = this.deps.store.read(side)
    const pending = this.unexpectedTargets[side]
    if (pending !== undefined) {
      state = { ...state, pausedUntil: Math.max(state.pausedUntil, pending + MANUAL_PAUSE_MS) }
      this.deps.store.commit(side, state,
        comfortEvent(pending, 'manual_pause', 'An unexpected target requires a six-hour adaptive pause.'), true)
      this.unexpectedTargets[side] = undefined
    }
    const admission = this.deps.admission(side, state)
    if (state.config.mode !== 'active' || !this.deps.autopilotEnabled() || !admitted(admission, now)
      || this.deps.pendingPause(side) !== null || state.config.followBedtime) return null
    // Phase shifting remains Preview-only until its active mapping is independently qualified.
    const context = this.deps.readContext(side, state, now)
    const monotonic = this.deps.monotonicNow()
    if (context.now !== now || !Number.isFinite(monotonic) || monotonic < 0) return null
    const decision = decideComfort(state, context)
    if (decision.pauseRequired) {
      this.deps.store.commit(side, { ...state, pausedUntil: Math.max(state.pausedUntil, now + MANUAL_PAUSE_MS) },
        comfortEvent(now, 'manual_pause', decision.reason), true)
    }
    const waitingForReport = awaitingTarget(state, context)
      && decideComfort({ ...state, lastAppliedAt: 0 }, context).eligible
    const targetF = decision.retainPreviousLease || waitingForReport ? state.lastTargetF : decision.eligible ? decision.proposedF : null
    if (targetF === null || !context.window || context.device.targetF === null) return null
    if (targetF === context.device.targetF && (state.lastTargetF !== targetF || state.lastSegment !== context.window.segment)) return null
    const same = state.application?.outcome === 'acknowledged' && state.application.targetF === targetF
      && state.application.segment === context.window.segment
    return { id: same && state.application ? state.application.requestId : randomUUID(), side, generation,
      createdAt: same && state.application ? state.application.createdAt : now,
      at: now, expiresAt: Math.min(now + LEASE_MS, admission.expiresAt, context.window.end,
        state.config.roomAware ? context.bedroom?.expiresAt ?? now : Infinity,
        waitingForReport ? (state.application?.finishedAt ?? now) + LEASE_MS : Infinity),
      monotonicStart: monotonic, monotonicDeadline: monotonic + LEASE_MS,
      admissionRevision: admission.revision, config: JSON.stringify(state.config), offsetF: state.offsetF,
      segment: context.window.segment, targetF, previousF: context.device.targetF, applying: false }
  }

  /** Re-read consent, persisted state and live inputs after both side-lock and DAC-queue waits. */
  private eligible(candidate: Candidate): boolean {
    return this.leaseCurrent(candidate) && this.inputsEligible(candidate) && this.leaseCurrent(candidate)
  }

  /** Input/database checks can block; recheck cheap clocks after them, immediately before dispatch. */
  private leaseCurrent(candidate: Candidate): boolean {
    const now = this.deps.now()
    const monotonic = this.deps.monotonicNow()
    return this.generations[candidate.side] === candidate.generation && now >= candidate.at && now < candidate.expiresAt
      && Number.isFinite(monotonic) && monotonic >= candidate.monotonicStart && monotonic < candidate.monotonicDeadline
  }

  private inputsEligible(candidate: Candidate): boolean {
    const { side } = candidate
    const now = this.deps.now()
    if (!this.deps.autopilotEnabled()
      || this.deps.pendingPause(side) !== null || this.unexpectedTargets[side] !== undefined) return false
    const state = this.deps.store.read(side)
    const admission = this.deps.admission(side, state)
    if (!admitted(admission, now) || admission.revision !== candidate.admissionRevision
      || JSON.stringify(state.config) !== candidate.config || state.offsetF !== candidate.offsetF || state.lastAppliedAt > now) return false
    const own = state.application?.requestId === candidate.id
    if (state.application && state.application.outcome !== 'acknowledged' && !(own && candidate.applying)) return false
    const input = this.deps.readContext(side, state, now)
    const context = { ...input, device: { ...input.device } }
    if (context.now !== now || context.window?.segment !== candidate.segment) return false
    const application = state.application
    // Firmware polling can still describe the pre-write target. This bounded
    // lease can wait for a newer report; it never labels that old reading verified.
    const awaitingReport = own && awaitingTarget(state, context)
    if (candidate.applying || awaitingReport) {
      if (context.device.targetF !== candidate.previousF && context.device.targetF !== candidate.targetF) return false
      // Only this in-flight one-degree target is known; every other safety input stays current.
      context.targetKnown = context.targetKnown || context.device.targetF === candidate.targetF
      context.device.targetF = candidate.previousF
    }
    const decision = decideComfort({ ...state, application: candidate.applying ? undefined : application }, context)
    if (decision.pauseRequired) {
      // Selection also runs on status reads. Latch without writing outside the
      // side lock; the next evaluation persists it before admitting any proposal.
      this.unexpectedTargets[side] = now
      return false
    }
    if (own && application?.outcome === 'acknowledged') {
      // Revalidate every guard without consuming another correction interval for a keepalive.
      const guarded = decideComfort({ ...state, lastAppliedAt: 0 }, context)
      return guarded.eligible && (context.device.targetF === candidate.targetF || awaitingReport)
    }
    return (decision.eligible && decision.proposedF === candidate.targetF)
      || (decision.retainPreviousLease && state.lastTargetF === candidate.targetF)
  }

  private application(candidate: Candidate): PolicyApplication {
    return async (input, execute) => {
      if (!this.eligible(candidate) || input.targetF !== candidate.targetF
        || input.requestId !== `policy:${PRODUCER}:${candidate.id}`) throw new ControlGuardError()
      const { side } = candidate
      const state = this.deps.store.read(side)
      const context = this.deps.readContext(side, state, this.deps.now())
      if (awaitingTarget(state, context)) throw new ControlGuardError()
      const previousF = context.device.targetF
      if (previousF === null) throw new ControlGuardError()
      const application: ComfortApplication = { requestId: candidate.id, segment: candidate.segment,
        targetF: candidate.targetF, previousF, createdAt: candidate.createdAt,
        reservedAt: this.deps.now(), finishedAt: null, receiptId: null, outcome: 'attempting' }
      // Reserve before the shared attempt journal. A crash in either commit stays withheld after restart.
      this.deps.store.commit(side, { ...state, application }, undefined, true)
      candidate.applying = true
      try {
        const receipt = await execute()
        const current = this.deps.store.read(side)
        if (current.application?.requestId !== candidate.id) throw new Error('Comfort application reservation changed')
        const acknowledged = receipt?.outcome === 'acknowledged' && receipt.finishedAt !== null
          && receipt.attemptedAt >= application.reservedAt && receipt.finishedAt >= receipt.attemptedAt && receipt.finishedAt <= this.deps.now()
        const finishedAt = receipt?.finishedAt !== null && receipt?.finishedAt !== undefined
          && receipt.finishedAt >= application.reservedAt && receipt.finishedAt <= this.deps.now()
          ? receipt.finishedAt
          : null
        // Keepalives retain the original correction clock; only a new target consumes a new step.
        const changed = state.lastTargetF !== candidate.targetF || state.lastSegment !== candidate.segment
        this.deps.store.commit(side, { ...current,
          ...(acknowledged
            ? { lastAppliedAt: changed ? receipt.finishedAt as number : state.lastAppliedAt,
                lastTargetF: candidate.targetF, lastSegment: candidate.segment }
            : {}),
          application: { ...application, outcome: acknowledged ? 'acknowledged' : 'unknown',
            receiptId: receipt?.attemptId ?? null, finishedAt } }, undefined, true)
      }
      catch (error) {
        // Preserve the original failure. If this commit also fails, attempting is equally withholding.
        try {
          const current = this.deps.store.read(side)
          if (current.application?.requestId === candidate.id) {
            this.deps.store.commit(side, { ...current, application: { ...application, outcome: 'unknown' } }, undefined, true)
          }
        }
        catch { /* The already durable reservation must not be cleared. */ }
        throw error
      }
      finally { candidate.applying = false }
    }
  }
}

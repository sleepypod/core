import { COOLING_RETURN_WINDOW_MS, coolingLeaseSchema, coolingProposal, freshCoolingContext, type CoolingLease, type CoolingPage, type CoolingPersistence } from './cooling'
import type { ComfortLimitDecision } from './limits'
import { MAX_TEMP, MIN_TEMP, type Side } from '@/src/hardware/types'
import { assertControlCurrent, ControlGuardError, withinDispatchGuard } from '@/src/controls/context'
import type { RecordTemperatureApplication, TemperatureApplicationInput, TemperatureApplicationReceipt } from './applications'

export class TemperatureBlockedError extends Error {
  constructor() {
    super('Pump stall protection active — re-enable the side first')
    this.name = 'TemperatureBlockedError'
  }
}

export const DEFAULT_HOLD_MS = 30 * 60_000
export const MAX_HOLD_MS = 24 * 60 * 60_000

export type TemperatureSource = 'manual' | 'run-once' | 'autopilot' | 'schedule'

/** A resolved target, never a deferred relative operation. Times are epoch ms. */
export interface TemperatureRequest {
  id: string
  source: TemperatureSource
  temperature: number
  startsAt: number
  expiresAt: number
  priority: number
  /** Stable for a request's lifetime, including continuous-policy refreshes. */
  createdAt: number
  durationSec?: number
}

export interface TemperatureControlStatus {
  source: TemperatureSource | null
  requestId: string | null
  targetTemperature: number | null
  holdUntil: number | null
  blocked: 'safety' | 'off' | null
  comfortLimit?: ComfortLimitDecision
}

interface PolicyLease {
  request: TemperatureRequest
  /** Synchronous current-input check, repeated after transport recovery. */
  isEligible: () => boolean
  application?: PolicyApplication
}

/** Runs only for the selected policy, inside its side lock; never acquire that lock again. */
export type PolicyApplication = (input: TemperatureApplicationInput,
  execute: () => Promise<TemperatureApplicationReceipt | undefined>) => Promise<void>

export interface TemperatureControllerDeps {
  now: () => number
  cooling?: CoolingPersistence
  withSideLock: <T>(side: Side, fn: () => Promise<T>) => Promise<T>
  /** Synchronous DB access inside the side lock. Throws on persistence failure. */
  readHold: (side: Side) => TemperatureRequest | null
  writeHold: (side: Side, hold: TemperatureRequest | null) => void
  /** Compute current schedule/session requests from their original clocks. */
  readBaseline: (side: Side, now: number) => TemperatureRequest[]
  resolveTarget?: (side: Side, request: TemperatureRequest | null, requestedF: number, now: number) => ComfortLimitDecision
  isPowered: (side: Side) => boolean
  readCurrentTarget: (side: Side) => number | null
  readHardwareDeadline: (side: Side) => number | null
  writeHardwareDeadline: (side: Side, deadline: number | null) => void
  isBlocked: (side: Side) => boolean
  /** Must connect before returning; selection and safety are rechecked afterward. */
  connect: () => Promise<void>
  /** Hardware write + state mirror; the caller already owns the side lock. */
  apply: (side: Side, temperature: number, durationSec?: number) => Promise<void>
  recordApplication?: RecordTemperatureApplication
  powerOff: (side: Side) => Promise<void>
  publish: (side: Side, status: TemperatureControlStatus) => void
  /** Persist the personal-policy pause. Must not throw or block manual shutdown on storage failure. */
  onManualControl?: (side: Side) => void
}

const rank: Record<TemperatureSource, number> = {
  'manual': 4, 'run-once': 3, 'autopilot': 2, 'schedule': 1,
}

export function isLiveRequest(request: TemperatureRequest, now: number): boolean {
  return Number.isFinite(request.temperature)
    && request.temperature >= MIN_TEMP && request.temperature <= MAX_TEMP
    && Number.isFinite(request.startsAt) && Number.isFinite(request.expiresAt)
    && request.startsAt <= now && now < request.expiresAt
}

/** Deterministic priority: source, rule priority, activation time, then stable ID. */
export function selectTemperatureRequest(requests: TemperatureRequest[], now: number): TemperatureRequest | null {
  return requests.filter(r => isLiveRequest(r, now)).sort((a, b) =>
    rank[b.source] - rank[a.source]
    || b.priority - a.priority
    || b.createdAt - a.createdAt
    || a.id.localeCompare(b.id),
  )[0] ?? null
}

/**
 * Temperature authority shared by all producers. Methods suffixed Locked are
 * for callers already holding withSideLock; never recursively acquire it.
 * Passive reconciliation never powers an off side on. Only an explicit manual
 * or scheduled power-on operation may authorize energizing an off side.
 */
export class TemperatureController {
  private requests: Record<Side, Map<string, TemperatureRequest>> = {
    left: new Map(), right: new Map(),
  }

  private policies: Record<Side, Map<string, PolicyLease[]>> = {
    left: new Map(), right: new Map(),
  }

  private poweredOff: Record<Side, boolean> = { left: false, right: false }

  private applied: Record<Side, number | null> = { left: null, right: null }

  private appliedDeadline: Record<Side, number | null> = { left: null, right: null }

  private published: Partial<Record<Side, string>> = {}

  private publishStatus(side: Side, status: TemperatureControlStatus): void {
    const key = JSON.stringify(status)
    if (this.published[side] === key) return
    this.deps.publish(side, status)
    this.published[side] = key
  }

  constructor(private deps: TemperatureControllerDeps) {}

  private target(side: Side, request: TemperatureRequest | null, fallback: number): number | null {
    const requestedF = request?.temperature ?? fallback
    if (!Number.isFinite(requestedF) || requestedF < MIN_TEMP || requestedF > MAX_TEMP) return null
    return this.deps.resolveTarget ? this.deps.resolveTarget(side, request, requestedF, this.deps.now()).targetF : requestedF
  }

  /** Keep the selected owner with the attempt; arbitration status alone is not delivery evidence. */
  private recordApplication(side: Side, targetF: number, durationSec: number | undefined,
    request: TemperatureRequest | null, reason: TemperatureApplicationInput['reason'], apply: () => Promise<void>, requestedFallback = targetF): Promise<void> {
    const decision = this.deps.resolveTarget?.(side, request, request?.temperature ?? requestedFallback, this.deps.now())
    const input = { side, targetF, durationSec: durationSec ?? null,
      source: request?.source ?? null, requestId: request?.id ?? null, reason,
      ...(decision && decision.state !== 'disabled' ? { comfortLimit: decision } : {}) }
    // Recheck at every actual FIFO write: a wake window or saved limit can change while queued.
    const limitedApply = () => withinDispatchGuard(() => {
      if (this.target(side, request, requestedFallback) !== targetF) throw new ControlGuardError()
    }, apply)
    const execute = async () => {
      if (this.deps.recordApplication) return this.deps.recordApplication(input, limitedApply)
      await limitedApply()
      return undefined
    }
    // Identity, not a caller-controlled ID: an automation rule cannot borrow a policy's hook.
    const policy = request && [...this.policies[side].values()].flat().find(lease => lease.request === request)
    if (!policy) return execute().then(() => {})
    const guarded = () => withinDispatchGuard(() => {
      if (!this.isPowered(side) || this.deps.isBlocked(side)
        || this.select(side, this.deps.now()) !== request) throw new ControlGuardError()
    }, execute)
    return policy.application ? policy.application(input, guarded) : guarded().then(() => {})
  }

  private isPowered(side: Side): boolean {
    const deadline = this.deps.readHardwareDeadline(side)
    return !this.poweredOff[side] && this.deps.isPowered(side)
      && (deadline === null || deadline > this.deps.now())
  }

  /** Internal observation provenance; selecting a request is not an acknowledgment of hardware movement. */
  selectedRequest(side: Side): Pick<TemperatureRequest, 'id' | 'expiresAt'> | null {
    const selected = this.select(side, this.deps.now())
    return selected ? { id: selected.id, expiresAt: selected.expiresAt } : null
  }

  status(side: Side): TemperatureControlStatus {
    const now = this.deps.now()
    const hold = this.deps.readHold(side)
    const selected = this.select(side, now, hold)
    const fallback = selected?.temperature ?? this.deps.readCurrentTarget(side)
    const comfortLimit = fallback === null ? undefined : this.deps.resolveTarget?.(side, selected, fallback, now)
    return {
      ...(comfortLimit ? { comfortLimit } : {}),
      source: selected?.source ?? null,
      requestId: selected?.id ?? null,
      targetTemperature: selected ? this.target(side, selected, selected.temperature) : null,
      holdUntil: selected?.id.startsWith('cooling:') ? selected.expiresAt : hold && isLiveRequest(hold, now) ? hold.expiresAt : null,
      blocked: this.deps.isBlocked(side) ? 'safety' : this.isPowered(side) ? null : 'off',
    }
  }

  private select(side: Side, now: number, hold = this.deps.readHold(side)): TemperatureRequest | null {
    return selectTemperatureRequest([
      ...(hold ? [hold] : []),
      ...this.coolingRequests(side, now),
      ...this.deps.readBaseline(side, now),
      ...this.requests[side].values(),
      ...this.livePolicyRequests(side, now),
    ], now)
  }

  private coolingRequests(side: Side, now: number): TemperatureRequest[] {
    const lease = this.deps.cooling?.read(side)
    if (!lease || lease.phase !== 'active' || now < lease.startedAt || now >= lease.expiresAt
      || this.deps.cooling?.context(side, now).scope !== lease.scope) return []
    return [{ id: `cooling:${lease.id}`, source: 'manual', temperature: lease.targetF,
      startsAt: lease.startedAt, expiresAt: lease.expiresAt, createdAt: lease.startedAt, priority: 1 }]
  }

  /** Replaces only this temporary intent; existing manual holds and routines remain intact. */
  private supersedeCooling(side: Side): void {
    if (this.deps.cooling?.read(side)) this.deps.cooling.write(side, null)
  }

  coolingStatus(side: Side): CoolingPage {
    const now = this.deps.now(), storage = this.deps.cooling
    const context = storage?.context(side, now)
    const lease = storage?.read(side) ?? null
    const ready = !!context && freshCoolingContext(context, now) && this.isPowered(side) && !this.deps.isBlocked(side)
    const proposal = ready && context && !lease ? coolingProposal(context, this.deps.readCurrentTarget(side), now) : null
    const uncertain = lease && lease.phase !== 'active'
    const current = lease && context?.scope === lease.scope && now >= lease.startedAt
    return { apiVersion: 1, side, generatedAt: now, observedAt: context?.observedAt ?? null,
      state: uncertain ? 'unknown' : lease ? (current && ready && now < lease.expiresAt ? 'cooling' : 'waiting') : proposal ? 'ready' : 'unavailable',
      reason: uncertain
        ? 'The last change is unconfirmed. Read the current target before cancelling or choosing a new temperature.'
        : lease
          ? 'Returns to the current prior plan only if no newer manual change or Stop has replaced this request.'
          : proposal
            ? 'Cool this zone by up to 2°F for up to 20 minutes. Your wake plan stays unchanged.'
            : context?.reason || 'Fresh, powered Pod readings are required. Cooling cannot overlap wake warming.',
      proposal, lease, physicalVerification: 'unverified' }
  }

  async startCooling(side: Side, id: string, expectedScope: string, expectedTargetF: number, expectedExpiresAt?: number): Promise<CoolingPage> {
    return this.deps.withSideLock(side, async () => {
      const storage = this.deps.cooling
      if (!storage) throw new Error('Temporary cooling is unavailable')
      await this.deps.connect()
      const now = this.deps.now(), context = storage.context(side, now)
      const proposal = coolingProposal(context, this.deps.readCurrentTarget(side), now)
      if (!proposal || context.sessionEndsAt === null || proposal.scope !== expectedScope || proposal.fromTargetF !== expectedTargetF
        || (expectedExpiresAt !== undefined && (!Number.isSafeInteger(expectedExpiresAt) || expectedExpiresAt - now < 60_000))
        || storage.read(side) || !this.isPowered(side) || this.deps.isBlocked(side)) throw new ControlGuardError()
      assertControlCurrent()
      const sessionEndsAt = Math.min(context.sessionEndsAt, this.deps.readHardwareDeadline(side) ?? Infinity)
      if (sessionEndsAt - now < 60_000) throw new ControlGuardError()
      const lease = coolingLeaseSchema.parse({ version: 1, id, side,
        ...proposal, startedAt: now, expiresAt: Math.min(proposal.expiresAt, sessionEndsAt, expectedExpiresAt ?? Infinity), sessionEndsAt, phase: 'prepared' })
      storage.begin(lease)
      // Capture the existing firmware countdown, never reset it to a new eight-hour session.
      this.deps.writeHardwareDeadline(side, sessionEndsAt)
      this.deps.onManualControl?.(side)
      const request: TemperatureRequest = { id: `cooling:${id}`, source: 'manual', temperature: lease.targetF,
        startsAt: now, expiresAt: lease.expiresAt, createdAt: now, priority: 1 }
      try {
        await withinDispatchGuard(() => {
          const at = this.deps.now(), current = storage.context(side, at)
          if (storage.read(side)?.id !== id || !freshCoolingContext(current, at) || current.scope !== lease.scope
            || at < now || at >= lease.expiresAt || (current.wakeStartsAt !== null && at >= current.wakeStartsAt)
            || !this.isPowered(side) || this.deps.isBlocked(side)) throw new ControlGuardError()
        }, () => this.recordApplication(side, lease.targetF, Math.floor((sessionEndsAt - this.deps.now()) / 1_000), request, 'manual',
          () => this.deps.apply(side, lease.targetF, Math.floor((sessionEndsAt - this.deps.now()) / 1_000))))
        storage.write(side, { ...lease, phase: 'active' })
        this.applied[side] = lease.targetF
        this.appliedDeadline[side] = sessionEndsAt
      }
      catch (error) {
        // A prepared/unknown request is never automatically dispatched after recovery.
        try {
          storage.write(side, { ...lease, phase: 'unknown' })
        }
        catch { /* Prepared remains unconfirmed. */ }
        this.invalidate(side)
        throw error
      }
      this.publishStatus(side, this.status(side))
      return this.coolingStatus(side)
    })
  }

  async cancelCooling(side: Side, id: string): Promise<CoolingPage> {
    return this.deps.withSideLock(side, async () => {
      assertControlCurrent()
      const storage = this.deps.cooling
      const lease = storage?.read(side)
      if (!storage || !lease || lease.id !== id) return this.coolingStatus(side)
      const context = storage.context(side, this.deps.now())
      if (context.scope !== lease.scope || (freshCoolingContext(context, this.deps.now())
        && (!this.isPowered(side) || this.deps.readCurrentTarget(side) !== lease.targetF))) {
        this.supersedeCooling(side)
        return this.coolingStatus(side)
      }
      await this.finishCoolingLocked(side, lease, true)
      return this.coolingStatus(side)
    })
  }

  /** One bounded return attempt, guarded again at the FIFO. Unknown writes are not replayed. */
  private async finishCoolingLocked(side: Side, lease: CoolingLease, explicit = false): Promise<void> {
    const storage = this.deps.cooling
    if (!storage) return
    const valid = () => {
      const now = this.deps.now(), context = storage.context(side, now)
      return storage.read(side)?.id === lease.id && context.scope === lease.scope && freshCoolingContext(context, now)
        && now >= lease.startedAt && (explicit || now < lease.expiresAt + COOLING_RETURN_WINDOW_MS)
        && this.deps.readHardwareDeadline(side) === lease.sessionEndsAt && this.isPowered(side) && !this.deps.isBlocked(side)
        && this.deps.readCurrentTarget(side) === lease.targetF
    }
    if (!valid()) return
    await this.deps.connect()
    if (!valid()) return
    assertControlCurrent()
    storage.write(side, { ...lease, phase: 'returning' })
    // Removing the cooling lease from arbitration reveals the original hold or the latest plan.
    const selected = this.select(side, this.deps.now())
    const targetF = this.target(side, selected, lease.fromTargetF)
    if (targetF === null) {
      storage.write(side, { ...lease, phase: 'unknown' })
      return
    }
    const duration = Math.floor((lease.sessionEndsAt - this.deps.now()) / 1_000)
    try {
      await withinDispatchGuard(() => {
        if (!valid()) throw new ControlGuardError()
      },
      () => this.recordApplication(side, targetF, duration, selected, 'reconcile',
        () => this.deps.apply(side, targetF, Math.floor((lease.sessionEndsAt - this.deps.now()) / 1_000)), lease.fromTargetF))
      storage.write(side, null)
      this.applied[side] = targetF
      this.appliedDeadline[side] = lease.sessionEndsAt
    }
    catch (error) {
      try {
        storage.write(side, { ...lease, phase: 'unknown' })
      }
      catch { /* Returning remains unconfirmed. */ }
      this.invalidate(side)
      throw error
    }
    this.publishStatus(side, this.status(side))
  }

  /** Hold the requested target without replaying the original command on reconnect/restart. */
  private async reconcileCoolingLocked(side: Side): Promise<boolean> {
    const storage = this.deps.cooling, lease = storage?.read(side)
    if (!storage || !lease) return false
    const now = this.deps.now(), context = storage.context(side, now)
    if (context.scope !== lease.scope || now < lease.startedAt || !this.isPowered(side) || this.deps.isBlocked(side)
      || this.deps.readHardwareDeadline(side) !== lease.sessionEndsAt) {
      storage.write(side, null)
      return false
    }
    // An unacknowledged cooling request cannot suppress the saved wake or ongoing plan.
    // It is excluded from arbitration, so only independently configured owners may apply.
    if (lease.phase !== 'active') return false
    if (!freshCoolingContext(context, now)) {
      // Stale observations cannot authorize a guessed return, but a bounded cooling
      // request must not keep the independently saved wake/normal plan suspended.
      if (now >= lease.expiresAt + COOLING_RETURN_WINDOW_MS || (context.wakeStartsAt !== null && now >= context.wakeStartsAt)) {
        storage.write(side, { ...lease, phase: 'unknown' })
        return false
      }
      return true
    }
    if (this.deps.readCurrentTarget(side) !== lease.targetF) {
      storage.write(side, null)
      return false
    }
    if (now >= lease.expiresAt || (context.wakeStartsAt !== null && now >= context.wakeStartsAt)) {
      if (now >= lease.expiresAt + COOLING_RETURN_WINDOW_MS) {
        storage.write(side, { ...lease, phase: 'unknown' })
      }
      else await this.finishCoolingLocked(side, lease)
    }
    return true
  }

  /** Invalid input revokes a lease permanently; fresh data needs a new evaluation. */
  private livePolicyRequests(side: Side, now: number): TemperatureRequest[] {
    const requests: TemperatureRequest[] = []
    for (const [producer, leases] of this.policies[side]) {
      const live = leases.filter((lease) => {
        try {
          // A personal policy may apply only its reviewed one-degree proposal.
          // If a new range excludes it, fall back to the bounded schedule instead.
          return isLiveRequest(lease.request, now) && lease.isEligible()
            && this.target(side, lease.request, lease.request.temperature) === lease.request.temperature
        }
        catch { return false }
      })
      if (live.length) this.policies[side].set(producer, live)
      else this.policies[side].delete(producer)
      requests.push(...live.map(lease => lease.request))
    }
    return requests
  }

  /**
   * Replace one producer's passive proposals without erasing rules or another
   * policy. Only the shared authority writes hardware; these leases never carry
   * a power-on request or a hardware duration. The producer must include consent,
   * fresh inputs and manual-pause checks in isEligible, not just at evaluation.
   */
  async replacePolicy(
    side: Side,
    producer: string,
    requests: TemperatureRequest[],
    isEligible: () => boolean,
    isCurrent: () => boolean = () => true,
    application?: PolicyApplication,
  ): Promise<TemperatureControlStatus> {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(producer)) throw new Error('Invalid policy producer')
    return this.deps.withSideLock(side, async () => {
      if (!isCurrent()) return this.status(side)
      const now = this.deps.now()
      const identities = new Set<string>()
      const leases = requests.map((request) => {
        if (request.source !== 'autopilot' || !isLiveRequest(request, now)
          || request.durationSec !== undefined || !request.id || identities.has(request.id)
          || !Number.isFinite(request.createdAt) || request.createdAt > now
          || !Number.isFinite(request.priority)) {
          throw new Error('Invalid policy lease')
        }
        identities.add(request.id)
        return { request: { ...request, id: `policy:${producer}:${request.id}` }, isEligible: () => isCurrent() && isEligible(), application }
      })
      if (leases.length) this.policies[side].set(producer, leases)
      else this.policies[side].delete(producer)
      return this.reconcileLocked(side, false, isCurrent)
    })
  }

  async setManual(side: Side, temperature: number, holdMs = DEFAULT_HOLD_MS, durationSec?: number): Promise<TemperatureControlStatus> {
    return this.deps.withSideLock(side, () => this.setManualLocked(side, temperature, holdMs, durationSec))
  }

  async setManualLocked(side: Side, temperature: number, holdMs = DEFAULT_HOLD_MS, durationSec?: number, validateBeforeApply?: () => void): Promise<TemperatureControlStatus> {
    if (!Number.isFinite(temperature) || temperature < MIN_TEMP || temperature > MAX_TEMP) {
      throw new Error('Temperature outside hardware bounds')
    }
    if (!Number.isInteger(holdMs) || holdMs <= 0 || holdMs > MAX_HOLD_MS) {
      throw new Error('Hold must be between 1 millisecond and 24 hours')
    }
    if (durationSec !== undefined && (!Number.isSafeInteger(durationSec) || durationSec < 0)) {
      throw new Error('Hardware duration must be a nonnegative integer')
    }
    if (durationSec === 0) {
      await this.powerOffLocked(side, true)
      return this.status(side)
    }
    await this.deps.connect()
    if (this.deps.isBlocked(side)) throw new TemperatureBlockedError()
    // Conditional manual surfaces recheck their evidence after a reconnect, before any hold or hardware write.
    validateBeforeApply?.()
    assertControlCurrent()
    this.deps.onManualControl?.(side)
    this.supersedeCooling(side)
    const now = this.deps.now()
    const previous = this.deps.readHold(side)
    const previousDeadline = this.deps.readHardwareDeadline(side)
    // Save first: a persistence failure must not acknowledge a non-durable hold.
    this.deps.writeHold(side, {
      id: 'manual', source: 'manual', temperature, startsAt: now,
      expiresAt: now + holdMs, createdAt: now, priority: 0,
    })
    try {
      this.deps.writeHardwareDeadline(side, durationSec === undefined ? null : now + durationSec * 1_000)
      await this.recordApplication(side, temperature, durationSec, this.deps.readHold(side), 'manual',
        () => this.deps.apply(side, temperature, durationSec))
      this.applied[side] = temperature
      this.appliedDeadline[side] = this.deps.readHardwareDeadline(side)
      this.poweredOff[side] = false
    }
    catch (error) {
      this.applied[side] = null // an ambiguous hardware error needs reconciliation
      this.deps.writeHold(side, previous)
      this.deps.writeHardwareDeadline(side, previousDeadline)
      throw error
    }
    const status = this.status(side)
    this.publishStatus(side, status)
    return status
  }

  async resume(side: Side): Promise<TemperatureControlStatus> {
    return this.deps.withSideLock(side, async () => {
      assertControlCurrent()
      this.deps.onManualControl?.(side)
      this.supersedeCooling(side)
      this.deps.writeHold(side, null)
      return this.reconcileLocked(side)
    })
  }

  /** Explicit shutdown ends the hold; it must never reconcile an energizing target. */
  clearHoldLocked(side: Side): void {
    assertControlCurrent()
    this.supersedeCooling(side)
    this.deps.writeHold(side, null)
    this.invalidate(side)
  }

  /** An explicit power event may energize the selected target, but creates no manual hold. */
  async powerOnLocked(side: Side, fallback = 75, isCurrent: () => boolean = () => true, manual = false): Promise<TemperatureControlStatus> {
    await this.deps.connect()
    if (this.deps.isBlocked(side)) throw new TemperatureBlockedError()
    if (!isCurrent()) return this.status(side)
    assertControlCurrent()
    if (manual) {
      this.deps.onManualControl?.(side)
      this.supersedeCooling(side)
    }
    else if (await this.reconcileCoolingLocked(side)) {
      // An already-powered temporary session never needs a second ON command.
      return this.status(side)
    }
    const selected = this.select(side, this.deps.now())
    const temperature = this.target(side, selected, fallback)
    if (temperature === null) throw new Error('Automatic comfort limit is unavailable; inspect configuration before powering on')
    // A scheduled ON during a manual hold must not extend its bounded session.
    // A new explicit ON with no hold starts a new hardware session.
    const previousDeadline = this.deps.readHardwareDeadline(side)
    if (selected?.source !== 'manual') this.deps.writeHardwareDeadline(side, null)
    const duration = this.remainingDuration(side, selected)
    if (duration !== undefined && duration <= 0) {
      await this.powerOffLocked(side)
      return this.status(side)
    }
    try {
      await this.recordApplication(side, temperature, duration, selected, 'power_on',
        () => duration === undefined ? this.deps.apply(side, temperature) : this.deps.apply(side, temperature, duration), fallback)
    }
    catch (error) {
      this.invalidate(side)
      this.deps.writeHardwareDeadline(side, previousDeadline)
      throw error
    }
    this.applied[side] = temperature
    this.appliedDeadline[side] = this.hardwareDeadline(side, selected)
    this.poweredOff[side] = false
    const status = this.status(side)
    this.publishStatus(side, status)
    return status
  }

  async powerOffLocked(side: Side, manual = false): Promise<void> {
    assertControlCurrent()
    if (manual) this.deps.onManualControl?.(side)
    this.poweredOff[side] = true
    this.invalidate(side)
    await this.deps.powerOff(side)
    this.supersedeCooling(side)
    this.deps.writeHold(side, null)
    this.deps.writeHardwareDeadline(side, null)
    this.publishStatus(side, this.status(side))
  }

  /** Replacing a lease does not apply it when a higher-priority source owns the side. */
  async submit(side: Side, request: TemperatureRequest): Promise<TemperatureControlStatus> {
    return this.deps.withSideLock(side, async () => {
      if (request.source !== 'autopilot') throw new Error('Only Autopilot leases may be submitted')
      if (!isLiveRequest(request, this.deps.now())) throw new Error('Invalid or expired temperature request')
      this.requests[side].set(request.id, { ...request })
      return this.reconcileLocked(side)
    })
  }

  async withdraw(side: Side, id: string): Promise<TemperatureControlStatus> {
    return this.deps.withSideLock(side, async () => {
      this.requests[side].delete(id)
      return this.reconcileLocked(side)
    })
  }

  /** Publish one evaluation atomically so lower-priority rules never flash a target first. */
  async replaceAutopilot(
    side: Side,
    requests: TemperatureRequest[],
    powerOnIds: string[] = [],
    isCurrent: () => boolean = () => true,
  ): Promise<TemperatureControlStatus> {
    return this.deps.withSideLock(side, async () => {
      if (!isCurrent()) return this.status(side)
      const live = requests.filter(r => r.source === 'autopilot' && isLiveRequest(r, this.deps.now()))
      this.requests[side] = new Map(live.map(r => [r.id, { ...r }]))
      const selected = this.select(side, this.deps.now())
      if (selected && this.requests[side].get(selected.id) === selected
        && powerOnIds.includes(selected.id) && !this.deps.isBlocked(side)) {
        return this.powerOnLocked(side, 75, isCurrent)
      }
      return this.reconcileLocked(side, false, isCurrent)
    })
  }

  /** Relative rules use the scheduled/session baseline, never their own output or a manual hold. */
  automationBaseline(side: Side): number | undefined {
    const request = selectTemperatureRequest(this.deps.readBaseline(side, this.deps.now()), this.deps.now())
    return this.target(side, request, 75) ?? undefined
  }

  async powerOff(side: Side, isCurrent: () => boolean = () => true): Promise<void> {
    return this.deps.withSideLock(side, async () => {
      if (isCurrent()) await this.powerOffLocked(side)
    })
  }

  async reconcile(side: Side, force = false, isCurrent: () => boolean = () => true): Promise<TemperatureControlStatus> {
    return this.deps.withSideLock(side, () => this.reconcileLocked(side, force, isCurrent))
  }

  /** Call after power-off, safety cutoff, or an independently observed target change. */
  invalidate(side: Side): void {
    this.applied[side] = null
    this.appliedDeadline[side] = null
  }

  /** Guard recovery owns the bounded hardware duration; it resolves only the target here. */
  recoveryTargetLocked(side: Side, fallback: number): number {
    this.supersedeCooling(side)
    const target = this.target(side, this.select(side, this.deps.now()), fallback)
    if (target === null) throw new Error('Automatic comfort limit is unavailable')
    return target
  }

  /** Called only after a successful, guard-authorized restore under the side lock. */
  recoveredLocked(side: Side, temperature: number): void {
    this.poweredOff[side] = false
    this.applied[side] = temperature
    this.appliedDeadline[side] = this.hardwareDeadline(side, this.select(side, this.deps.now()))
  }

  /** An explicit hardware deadline survives hold expiry/Resume and producer changes. */
  private hardwareDeadline(side: Side, request: TemperatureRequest | null): number | null {
    const manualDeadline = this.deps.readHardwareDeadline(side)
    const requestDeadline = request?.durationSec === undefined ? null : request.createdAt + request.durationSec * 1_000
    const deadlines = [manualDeadline, requestDeadline].filter((d): d is number => d !== null)
    return deadlines.length ? Math.min(...deadlines) : null
  }

  private remainingDuration(side: Side, request: TemperatureRequest | null): number | undefined {
    const deadline = this.hardwareDeadline(side, request)
    return deadline === null ? undefined : Math.floor((deadline - this.deps.now()) / 1_000)
  }

  recoveryDurationLocked(side: Side, duration: number): number {
    return Math.max(0, Math.min(duration, this.remainingDuration(side, null) ?? duration))
  }

  async reconcileLocked(side: Side, force = false, isCurrent: () => boolean = () => true): Promise<TemperatureControlStatus> {
    if (!isCurrent()) return this.status(side)
    const now = this.deps.now()
    const deadline = this.deps.readHardwareDeadline(side)
    if (deadline !== null && deadline <= now) {
      await this.powerOffLocked(side)
      return this.status(side)
    }
    if (await this.reconcileCoolingLocked(side)) {
      const status = this.status(side)
      this.publishStatus(side, status)
      return status
    }
    const hold = this.deps.readHold(side)
    if (hold && !isLiveRequest(hold, now)) this.deps.writeHold(side, null)
    for (const [id, request] of this.requests[side]) {
      if (request.expiresAt <= now) this.requests[side].delete(id)
    }
    let selected = this.select(side, now)
    if (selected && (this.remainingDuration(side, selected) ?? 1) <= 0 && this.deps.isPowered(side)) {
      await this.powerOffLocked(side)
      return this.status(side)
    }
    // With no configured owner, releasing a hold leaves the current target in
    // place. Always-on keepalive may refresh that target without inventing an
    // owner or extending a hold. The off/safety gates still apply.
    const currentTarget = this.deps.readCurrentTarget(side)
    const correctedTarget = !selected && currentTarget !== null ? this.target(side, null, currentTarget) : null
    const needsLimitCorrection = correctedTarget !== null && currentTarget !== correctedTarget
    if (!selected && (force || needsLimitCorrection) && this.isPowered(side) && !this.deps.isBlocked(side)) {
      await this.deps.connect()
      selected = this.select(side, this.deps.now())
      const reported = this.deps.readCurrentTarget(side)
      const target = selected || reported !== null ? this.target(side, selected, reported ?? 75) : null
      if (isCurrent() && target !== null && Number.isFinite(target) && target >= MIN_TEMP && target <= MAX_TEMP
        && this.isPowered(side) && !this.deps.isBlocked(side)) {
        const duration = this.remainingDuration(side, selected)
        if (duration !== undefined && duration <= 0) {
          await this.powerOffLocked(side)
          return this.status(side)
        }
        await this.recordApplication(side, target, duration, selected, 'keepalive',
          () => duration === undefined ? this.deps.apply(side, target) : this.deps.apply(side, target, duration), reported ?? target)
        this.applied[side] = target
        this.appliedDeadline[side] = this.hardwareDeadline(side, selected)
      }
      const status = this.status(side)
      this.publishStatus(side, status)
      return status
    }
    if (selected && !this.deps.isBlocked(side) && this.isPowered(side)
      && this.target(side, selected, selected.temperature) !== null
      && (force || this.target(side, selected, selected.temperature) !== this.applied[side]
        || this.hardwareDeadline(side, selected) !== this.appliedDeadline[side])) {
      await this.deps.connect()
      // Connecting can wait for transport recovery. Do not issue an expired
      // request or undo a guard trip that happened while connecting.
      selected = this.select(side, this.deps.now())
      if (isCurrent() && selected && !this.deps.isBlocked(side) && this.isPowered(side)) {
        const duration = this.remainingDuration(side, selected)
        if (duration !== undefined && duration <= 0) {
          await this.powerOffLocked(side)
          return this.status(side)
        }
        const target = this.target(side, selected, selected.temperature)
        if (target === null) return this.status(side)
        await this.recordApplication(side, target, duration, selected, force ? 'keepalive' : 'reconcile',
          () => duration === undefined ? this.deps.apply(side, target) : this.deps.apply(side, target, duration))
        this.applied[side] = target
        this.appliedDeadline[side] = this.hardwareDeadline(side, selected)
      }
    }
    if (this.deps.isBlocked(side) || !this.isPowered(side)) this.applied[side] = null
    const status = this.status(side)
    this.publishStatus(side, status)
    return status
  }
}

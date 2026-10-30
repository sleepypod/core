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
  withSideLock: <T>(side: Side, fn: () => Promise<T>) => Promise<T>
  /** Synchronous DB access inside the side lock. Throws on persistence failure. */
  readHold: (side: Side) => TemperatureRequest | null
  writeHold: (side: Side, hold: TemperatureRequest | null) => void
  /** Compute current schedule/session requests from their original clocks. */
  readBaseline: (side: Side, now: number) => TemperatureRequest[]
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

  /** Keep the selected owner with the attempt; arbitration status alone is not delivery evidence. */
  private recordApplication(side: Side, targetF: number, durationSec: number | undefined,
    request: TemperatureRequest | null, reason: TemperatureApplicationInput['reason'], apply: () => Promise<void>): Promise<void> {
    const input = { side, targetF, durationSec: durationSec ?? null,
      source: request?.source ?? null, requestId: request?.id ?? null, reason }
    const execute = async () => {
      if (this.deps.recordApplication) return this.deps.recordApplication(input, apply)
      await apply()
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

  status(side: Side): TemperatureControlStatus {
    const now = this.deps.now()
    const hold = this.deps.readHold(side)
    const selected = this.select(side, now, hold)
    return {
      source: selected?.source ?? null,
      requestId: selected?.id ?? null,
      targetTemperature: selected?.temperature ?? null,
      holdUntil: hold && isLiveRequest(hold, now) ? hold.expiresAt : null,
      blocked: this.deps.isBlocked(side) ? 'safety' : this.isPowered(side) ? null : 'off',
    }
  }

  private select(side: Side, now: number, hold = this.deps.readHold(side)): TemperatureRequest | null {
    return selectTemperatureRequest([
      ...(hold ? [hold] : []),
      ...this.deps.readBaseline(side, now),
      ...this.requests[side].values(),
      ...this.livePolicyRequests(side, now),
    ], now)
  }

  /** Invalid input revokes a lease permanently; fresh data needs a new evaluation. */
  private livePolicyRequests(side: Side, now: number): TemperatureRequest[] {
    const requests: TemperatureRequest[] = []
    for (const [producer, leases] of this.policies[side]) {
      const live = leases.filter((lease) => {
        try {
          return isLiveRequest(lease.request, now) && lease.isEligible()
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
      this.deps.writeHold(side, null)
      return this.reconcileLocked(side)
    })
  }

  /** Explicit shutdown ends the hold; it must never reconcile an energizing target. */
  clearHoldLocked(side: Side): void {
    assertControlCurrent()
    this.deps.writeHold(side, null)
    this.invalidate(side)
  }

  /** An explicit power event may energize the selected target, but creates no manual hold. */
  async powerOnLocked(side: Side, fallback = 75, isCurrent: () => boolean = () => true, manual = false): Promise<TemperatureControlStatus> {
    await this.deps.connect()
    if (this.deps.isBlocked(side)) throw new TemperatureBlockedError()
    if (!isCurrent()) return this.status(side)
    assertControlCurrent()
    if (manual) this.deps.onManualControl?.(side)
    const selected = this.select(side, this.deps.now())
    const temperature = selected?.temperature ?? fallback
    if (!Number.isFinite(temperature) || temperature < MIN_TEMP || temperature > MAX_TEMP) {
      throw new Error('Temperature outside hardware bounds')
    }
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
        () => duration === undefined ? this.deps.apply(side, temperature) : this.deps.apply(side, temperature, duration))
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
    return selectTemperatureRequest(this.deps.readBaseline(side, this.deps.now()), this.deps.now())?.temperature
      ?? 75
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
    return this.select(side, this.deps.now())?.temperature ?? fallback
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
    if (!selected && force && this.isPowered(side) && !this.deps.isBlocked(side)) {
      await this.deps.connect()
      selected = this.select(side, this.deps.now())
      const target = selected?.temperature ?? this.deps.readCurrentTarget(side)
      if (isCurrent() && target !== null && Number.isFinite(target) && target >= MIN_TEMP && target <= MAX_TEMP
        && this.isPowered(side) && !this.deps.isBlocked(side)) {
        const duration = this.remainingDuration(side, selected)
        if (duration !== undefined && duration <= 0) {
          await this.powerOffLocked(side)
          return this.status(side)
        }
        await this.recordApplication(side, target, duration, selected, 'keepalive',
          () => duration === undefined ? this.deps.apply(side, target) : this.deps.apply(side, target, duration))
        this.applied[side] = target
        this.appliedDeadline[side] = this.hardwareDeadline(side, selected)
      }
      const status = this.status(side)
      this.publishStatus(side, status)
      return status
    }
    if (selected && !this.deps.isBlocked(side) && this.isPowered(side)
      && (force || selected.temperature !== this.applied[side]
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
        const target = selected.temperature
        await this.recordApplication(side, target, duration, selected, force ? 'keepalive' : 'reconcile',
          () => duration === undefined ? this.deps.apply(side, target) : this.deps.apply(side, target, duration))
        this.applied[side] = selected.temperature
        this.appliedDeadline[side] = this.hardwareDeadline(side, selected)
      }
    }
    if (this.deps.isBlocked(side) || !this.isPowered(side)) this.applied[side] = null
    const status = this.status(side)
    this.publishStatus(side, status)
    return status
  }
}

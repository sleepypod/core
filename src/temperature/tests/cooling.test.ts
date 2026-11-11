import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { beforeControlWrite, withinControlRequest } from '@/src/controls/context'
import { withSideLock } from '@/src/hardware/sideLock'
import type { Side } from '@/src/hardware/types'
import { ControlService } from '@/src/controls/service'
import { createControlStore } from '@/src/controls/store'
import type { ControlRequest } from '@/src/controls/contract'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { createCoolingStore } from '../coolingStore'
import { TemperatureController, type TemperatureControllerDeps, type TemperatureRequest } from '../controller'
import { COOLING_DURATION_MS, COOLING_RETURN_WINDOW_MS, coolingLeaseSchema, coolingProposal, type CoolingContext, type CoolingLease } from '../cooling'

function requireLease(lease: CoolingLease | null): CoolingLease {
  if (!lease) throw new Error('Expected a persisted cooling lease')
  return lease
}
function requireStorage(storage: TemperatureControllerDeps['cooling']) {
  if (!storage) throw new Error('Expected cooling storage')
  return storage
}

function harness() {
  let now = 1_794_350_000_000
  const source: CoolingContext = { scope: 'a'.repeat(64), available: true, readyToStart: true, observedAt: now,
    reason: 'Ready', sessionEndsAt: now + 8 * 60 * 60_000, wakeStartsAt: null }
  const leases: Record<Side, CoolingLease | null> = { left: null, right: null }
  const holds: Record<Side, TemperatureRequest | null> = { left: null, right: null }
  const deadlines: Record<Side, number | null> = { left: null, right: null }
  const targets = { left: 70, right: 74 }, powered = { left: true, right: true }, blocked = { left: false, right: false }
  const baseline: TemperatureRequest[] = [{ id: 'night', source: 'schedule', temperature: 70,
    startsAt: now - 60_000, expiresAt: now + 24 * 60 * 60_000, createdAt: now - 60_000, priority: 0 }]
  const feedback: CoolingLease[] = []
  const apply = vi.fn(async (side: Side, target: number, duration?: number) => {
    if (duration !== undefined) expect(duration).toBeGreaterThan(0)
    beforeControlWrite()
    source.readyToStart = false // The first of our own DAC writes changes its mutation revision.
    beforeControlWrite()
    targets[side] = target
  })
  const deps: TemperatureControllerDeps = {
    now: () => now, withSideLock,
    cooling: { read: side => leases[side], write: (side, lease) => { leases[side] = lease },
      begin: (lease) => {
        if (feedback.some(row => row.id === lease.id)) throw new Error('Reused ID')
        feedback.push(lease)
        leases[lease.side] = lease
      },
      context: () => ({ ...source }) },
    readHold: side => holds[side], writeHold: (side, hold) => { holds[side] = hold },
    readBaseline: () => baseline, isPowered: side => powered[side], readCurrentTarget: side => targets[side],
    readHardwareDeadline: side => deadlines[side], writeHardwareDeadline: (side, value) => { deadlines[side] = value },
    isBlocked: side => blocked[side], connect: vi.fn(async () => {}), apply,
    powerOff: vi.fn(async (side: Side) => { powered[side] = false }), publish: vi.fn(), onManualControl: vi.fn(),
  }
  const controller = new TemperatureController(deps)
  const start = (id = randomUUID()) => controller.startCooling('left', id, source.scope, targets.left)
  const advance = (amount: number, fresh = true) => {
    now += amount
    if (fresh) {
      source.observedAt = now
      source.readyToStart = true
    }
  }
  return { controller, deps, source, leases, holds, deadlines, targets, powered, blocked, baseline, feedback, apply, start, advance, now: () => now }
}

describe('temporary cooling authority', () => {
  it('deduplicates persisted cooling and cancellation commands across service reconstruction', async () => {
    const database = migratedComfortDatabase(':memory:')
    try {
      const context = harness(), cooling = createCoolingStore(database), store = createControlStore(database)
      context.deps.cooling = { ...cooling, context: () => ({ ...context.source }) }
      const authority = new TemperatureController(context.deps)
      const service = () => new ControlService({ store, runId: 'cooling-fixture', now: context.now, monotonicNow: context.now,
        execute: async (action) => {
          if (action.kind === 'cooling.start') await authority.startCooling(action.side, action.coolingId, action.expectedScope, action.expectedTargetF, action.expectedExpiresAt)
          else if (action.kind === 'cooling.cancel') await authority.cancelCooling(action.side, action.coolingId)
          else throw new Error('Unexpected fixture command')
        } })
      const input: ControlRequest = { requestId: randomUUID(), issuedAt: context.now(), expiresAt: context.now() + 30_000,
        action: { kind: 'cooling.start', side: 'left', coolingId: randomUUID(), expectedScope: context.source.scope,
          expectedTargetF: 70, expectedExpiresAt: context.now() + COOLING_DURATION_MS } }
      const first = await service().submit(input)
      expect(first).toMatchObject({ state: 'acknowledged', dispatchCount: 2, physicalVerification: 'unverified' })
      expect(await service().submit(input)).toEqual(first)
      expect(context.apply).toHaveBeenCalledTimes(1)
      expect(database.prepare('SELECT count(*) AS count FROM comfort_moments').get()).toEqual({ count: 1 })
      context.advance(1_000)
      const cancel: ControlRequest = { ...input, requestId: randomUUID(), issuedAt: context.now(), expiresAt: context.now() + 30_000,
        action: { kind: 'cooling.cancel', side: 'left', coolingId: requireLease(cooling.read('left')).id } }
      const cancelled = await service().submit(cancel)
      expect(cancelled.state).toBe('acknowledged')
      expect(await service().submit(cancel)).toEqual(cancelled)
      expect(context.apply).toHaveBeenCalledTimes(2)
      expect(cooling.read('left')).toBeNull()
      expect(await service().submit(input)).toEqual(first)
      expect(context.apply).toHaveBeenCalledTimes(2)
    }
    finally { database.close() }
  })

  it('records explicit feedback, cools two degrees and returns to the latest plan without extending the firmware countdown', async () => {
    const context = harness()
    const page = await context.start()
    expect(page.lease).toMatchObject({ fromTargetF: 70, targetF: 68, phase: 'active' })
    expect(context.feedback).toHaveLength(1)
    expect(context.apply).toHaveBeenCalledExactlyOnceWith('left', 68, 8 * 3600)
    context.baseline[0].temperature = 71
    context.advance(COOLING_DURATION_MS)
    await context.controller.reconcile('left')
    expect(context.apply).toHaveBeenLastCalledWith('left', 71, 8 * 3600 - 1200)
    expect(context.leases.left).toBeNull()
    expect(context.deadlines.left).toBe(context.source.sessionEndsAt)
    expect(context.targets.right).toBe(74)
  })

  it('preserves an existing manual hold and its original expiry', async () => {
    const context = harness()
    const prior = { ...context.baseline[0], id: 'manual', source: 'manual' as const, temperature: 72, expiresAt: context.now() + 30 * 60_000 }
    context.holds.left = prior
    await context.start()
    context.advance(10_000)
    await context.controller.cancelCooling('left', requireLease(context.leases.left).id)
    expect(context.holds.left).toEqual(prior)
    expect(context.targets.left).toBe(72)
    expect(context.apply.mock.calls.at(-1)?.[2]).toBe(8 * 3600 - 10)
  })

  it('returns to the prior target when no configured plan exists', async () => {
    const context = harness()
    context.baseline.length = 0
    const page = await context.start()
    context.advance(1_000)
    await context.controller.cancelCooling('left', requireLease(page.lease).id)
    expect(context.targets.left).toBe(70)
    expect(context.holds.left).toBeNull()
    expect(context.leases.left).toBeNull()
  })

  it.each(['manual', 'off', 'resume'] as const)('a newer %s supersedes the return and a late cancel cannot restore it', async (action) => {
    const context = harness(), page = await context.start()
    if (action === 'manual') await context.controller.setManual('left', 73)
    else if (action === 'off') await context.controller.powerOff('left')
    else await context.controller.resume('left')
    const calls = context.apply.mock.calls.length
    context.advance(COOLING_DURATION_MS)
    await context.controller.cancelCooling('left', requireLease(page.lease).id)
    expect(context.leases.left).toBeNull()
    expect(context.apply).toHaveBeenCalledTimes(calls)
    if (action === 'off') expect(context.powered.left).toBe(false)
    if (action === 'manual') expect(context.targets.left).toBe(73)
  })

  it('never moves the reviewed end time later while the owner reads the preview', async () => {
    const context = harness()
    const reviewedEnd = context.now() + 10 * 60_000
    context.advance(60_000)
    const result = await context.controller.startCooling('left', randomUUID(), context.source.scope, 70, reviewedEnd)
    expect(result.lease?.expiresAt).toBe(reviewedEnd)
  })

  it('rejects a preview with less than one useful minute left', async () => {
    const context = harness()
    await expect(context.controller.startCooling('left', randomUUID(), context.source.scope, 70, context.now() + 59_999)).rejects.toThrow()
    expect(context.feedback).toHaveLength(0)
    expect(context.apply).not.toHaveBeenCalled()
  })

  it('also honors a shorter persisted firmware deadline before recording feedback', async () => {
    const context = harness()
    context.deadlines.left = context.now() + 59_000
    await expect(context.start()).rejects.toThrow()
    expect(context.feedback).toHaveLength(0)
    expect(context.apply).not.toHaveBeenCalled()
  })

  it('stale cooling observations cannot suspend an independently scheduled wake target', async () => {
    const context = harness()
    await context.start()
    context.advance(60_000, false)
    context.source.wakeStartsAt = context.now()
    context.baseline[0].temperature = 105
    await context.controller.reconcile('left')
    expect(context.leases.left?.phase).toBe('unknown')
    expect(context.targets.left).toBe(105)
    expect(context.apply).toHaveBeenCalledTimes(2)
  })

  it('expired stale cooling without a saved plan never guesses a return', async () => {
    const context = harness()
    context.baseline.length = 0
    await context.start()
    context.advance(COOLING_DURATION_MS + COOLING_RETURN_WINDOW_MS, false)
    await context.controller.reconcile('left')
    expect(context.leases.left?.phase).toBe('unknown')
    expect(context.apply).toHaveBeenCalledTimes(1)
  })

  it('scheduled ON cannot replay active cooling or extend its session', async () => {
    const context = harness()
    await context.start()
    const deadline = context.deadlines.left
    await withSideLock('left', () => context.controller.powerOnLocked('left'))
    expect(context.apply).toHaveBeenCalledTimes(1)
    expect(context.deadlines.left).toBe(deadline)
    context.advance(COOLING_DURATION_MS)
    await withSideLock('left', () => context.controller.powerOnLocked('left'))
    expect(context.apply).toHaveBeenCalledTimes(2)
    expect(context.targets.left).toBe(70)
  })

  it('guard recovery discards cooling and resolves the original plan', async () => {
    const context = harness()
    await context.start()
    expect(context.controller.recoveryTargetLocked('left', 75)).toBe(70)
    expect(context.leases.left).toBeNull()
    expect(context.apply).toHaveBeenCalledTimes(1)
  })

  it('does not cool again when a controller restarts, and returns once at expiry', async () => {
    const context = harness()
    await context.start()
    const restarted = new TemperatureController(context.deps)
    await restarted.reconcile('left', true)
    expect(context.apply).toHaveBeenCalledTimes(1)
    context.advance(COOLING_DURATION_MS)
    await restarted.reconcile('left')
    await restarted.reconcile('left')
    expect(context.apply).toHaveBeenCalledTimes(2)
  })

  it.each(['available', 'readyToStart'] as const)('rejects unavailable %s without feedback or a write', async (field) => {
    const context = harness()
    context.source[field] = false
    expect(context.controller.coolingStatus('left').proposal).toBeNull()
    await expect(context.start()).rejects.toThrow()
    expect(context.feedback).toHaveLength(0)
    expect(context.apply).not.toHaveBeenCalled()
  })

  it.each(['old', 'future', 'off', 'blocked', 'neutral', 'session_end', 'wake'] as const)('rejects %s source evidence', async (condition) => {
    const context = harness()
    if (condition === 'old') context.source.observedAt = context.now() - 30_000
    if (condition === 'future') context.source.observedAt = context.now() + 1
    if (condition === 'off') context.powered.left = false
    if (condition === 'blocked') context.blocked.left = true
    if (condition === 'neutral') context.source.sessionEndsAt = null
    if (condition === 'session_end') context.source.sessionEndsAt = context.now() + 500
    if (condition === 'wake') context.source.wakeStartsAt = context.now()
    await expect(context.start()).rejects.toThrow()
    expect(context.apply).not.toHaveBeenCalled()
  })

  it('caps cooling at wake warming without changing the saved alarm or baseline', async () => {
    const context = harness()
    context.source.wakeStartsAt = context.now() + 5 * 60_000
    const page = await context.start()
    expect(page.lease?.expiresAt).toBe(context.source.wakeStartsAt)
    context.advance(5 * 60_000)
    context.baseline[0].temperature = 105
    await context.controller.reconcile('left')
    expect(context.targets.left).toBe(105)
    expect(context.apply).toHaveBeenCalledTimes(2)
  })

  it('ends early when a new wake plan begins during cooling', async () => {
    const context = harness()
    await context.start()
    context.advance(60_000)
    context.source.wakeStartsAt = context.now()
    context.baseline[0].temperature = 105
    await context.controller.reconcile('left')
    expect(context.targets.left).toBe(105)
    expect(context.leases.left).toBeNull()
  })

  it('does not guess a return from stale sources or replay one long after expiry', async () => {
    const context = harness()
    context.baseline.length = 0
    await context.start()
    context.advance(COOLING_DURATION_MS, false)
    await context.controller.reconcile('left')
    expect(context.apply).toHaveBeenCalledTimes(1)
    expect(context.controller.coolingStatus('left').state).toBe('waiting')
    context.advance(COOLING_RETURN_WINDOW_MS)
    await context.controller.reconcile('left')
    expect(context.leases.left?.phase).toBe('unknown')
    await context.controller.reconcile('left')
    expect(context.apply).toHaveBeenCalledTimes(1)
  })

  it('can explicitly cancel after a missed return window using fresh unchanged target evidence', async () => {
    const context = harness()
    context.baseline.length = 0
    const page = await context.start()
    context.advance(COOLING_DURATION_MS + COOLING_RETURN_WINDOW_MS)
    await context.controller.reconcile('left')
    await context.controller.cancelCooling('left', requireLease(page.lease).id)
    expect(context.targets.left).toBe(70)
    expect(context.leases.left).toBeNull()
  })

  it('withholds the original action after an uncertain write, without suppressing the saved wake plan', async () => {
    const context = harness()
    context.deps.apply = vi.fn(async () => {
      beforeControlWrite()
      throw new Error('lost reply')
    })
    await expect(context.start()).rejects.toThrow('lost reply')
    expect(context.leases.left?.phase).toBe('unknown')
    context.deps.apply = context.apply
    context.baseline[0].temperature = 105
    await new TemperatureController(context.deps).reconcile('left')
    expect(context.apply).toHaveBeenCalledExactlyOnceWith('left', 105, 8 * 3600)
  })

  it('does not replay an uncertain return after restarting', async () => {
    const context = harness()
    context.baseline.length = 0
    await context.start()
    context.advance(COOLING_DURATION_MS)
    context.deps.apply = vi.fn(async () => {
      beforeControlWrite()
      throw new Error('lost return reply')
    })
    await expect(context.controller.reconcile('left')).rejects.toThrow('lost return reply')
    expect(context.leases.left?.phase).toBe('unknown')
    context.deps.apply = context.apply
    await new TemperatureController(context.deps).reconcile('left')
    expect(context.apply).toHaveBeenCalledTimes(1)
  })

  it.each(['scope', 'target', 'deadline', 'clock'] as const)('does not restore obsolete %s state', async (changed) => {
    const context = harness()
    context.baseline.length = 0
    await context.start()
    if (changed === 'scope') context.source.scope = 'b'.repeat(64)
    if (changed === 'target') context.targets.left = 74
    if (changed === 'deadline') context.deadlines.left = context.now() + 60_000
    if (changed === 'clock') context.advance(-1)
    await context.controller.reconcile('left')
    expect(context.apply).toHaveBeenCalledTimes(1)
    expect(context.leases.left).toBeNull()
  })

  it('rechecks after connect and at the actual FIFO write', async () => {
    const context = harness()
    context.deps.connect = async () => {
      context.source.scope = 'b'.repeat(64)
    }
    await expect(context.controller.startCooling('left', randomUUID(), 'a'.repeat(64), 70)).rejects.toThrow()
    expect(context.feedback).toHaveLength(0)
    context.deps.connect = async () => {}
    context.deps.apply = async () => {
      context.source.available = false
      beforeControlWrite()
    }
    await expect(context.start()).rejects.toThrow()
    expect(context.leases.left?.phase).toBe('unknown')
  })

  it('persists intent before pausing or writing, and retains Stop if cooling storage fails', async () => {
    const context = harness()
    requireStorage(context.deps.cooling).begin = () => {
      throw new Error('disk full')
    }
    await expect(context.start()).rejects.toThrow('disk full')
    expect(context.deps.onManualControl).not.toHaveBeenCalled()
    expect(context.apply).not.toHaveBeenCalled()
    requireStorage(context.deps.cooling).read = () => {
      throw new Error('disk unavailable')
    }
    await expect(context.controller.powerOff('left')).rejects.toThrow('disk unavailable')
    expect(context.powered.left).toBe(false)
  })

  it('an expired control request creates no feedback or active intent', async () => {
    const context = harness()
    let clock = context.now()
    const scope = { issuedAt: clock, expiresAt: clock + 1_000, monotonicDeadline: clock + 1_000,
      now: () => clock, monotonicNow: () => clock, beforeDispatch: vi.fn(), dispatchCount: 0, deadlineRejected: false, closed: false }
    context.deps.connect = async () => {
      clock += 1000
    }
    await expect(withinControlRequest(scope, () => context.start())).rejects.toThrow('expired')
    expect(context.feedback).toHaveLength(0)
    expect(context.apply).not.toHaveBeenCalled()
  })

  it('does not stack another cooling request and cannot borrow another lease for cancellation', async () => {
    const context = harness()
    await context.start()
    context.source.readyToStart = true
    await expect(context.start()).rejects.toThrow()
    await context.controller.cancelCooling('left', randomUUID())
    expect(context.apply).toHaveBeenCalledTimes(1)
    expect(context.feedback).toHaveLength(1)
  })

  it('keeps the hardware floor and validates durable lease boundaries', () => {
    const context = harness()
    expect(coolingProposal(context.source, 56, context.now())?.targetF).toBe(55)
    expect(coolingProposal(context.source, 55, context.now())).toBeNull()
    expect(coolingLeaseSchema.safeParse({}).success).toBe(false)
  })
})

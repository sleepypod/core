import { describe, expect, it, vi } from 'vitest'
import { withSideLock } from '@/src/hardware/sideLock'
import type { Side } from '@/src/hardware/types'
import { ControlGuardError, withinControlRequest, withinDispatchGuard } from '@/src/controls/context'
import { DEFAULT_HOLD_MS, TemperatureController, selectTemperatureRequest } from '../controller'
import type { TemperatureControllerDeps, TemperatureRequest, TemperatureSource } from '../controller'

function request(source: TemperatureSource, temperature: number, overrides: Partial<TemperatureRequest> = {}): TemperatureRequest {
  return { id: source, source, temperature, startsAt: 0, expiresAt: 10_000_000, createdAt: 0, priority: 0, ...overrides }
}

function harness() {
  let now = 1_000
  const deadlines: Record<Side, number | null> = { left: null, right: null }
  const holds: Record<Side, TemperatureRequest | null> = { left: null, right: null }
  const baselines: Record<Side, TemperatureRequest[]> = { left: [request('schedule', 72)], right: [request('schedule', 68)] }
  const powered = { left: true, right: true }
  const blocked = { left: false, right: false }
  const apply = vi.fn(async (side: Side, temperature: number) => {
    if (!Number.isFinite(temperature)) throw new Error('Invalid target')
    powered[side] = true
  })
  const deps: TemperatureControllerDeps = {
    now: () => now,
    withSideLock,
    readHold: side => holds[side],
    writeHold: (side, hold) => { holds[side] = hold },
    readBaseline: side => baselines[side],
    isPowered: side => powered[side],
    readCurrentTarget: () => 75,
    readHardwareDeadline: side => deadlines[side],
    writeHardwareDeadline: (side, deadline) => { deadlines[side] = deadline },
    isBlocked: side => blocked[side],
    connect: vi.fn(async () => {}),
    apply,
    powerOff: async (side) => {
      powered[side] = false
    },
    publish: vi.fn(),
  }
  return {
    controller: new TemperatureController(deps), deps, holds, baselines, powered, blocked, apply,
    advance: (ms: number) => { now += ms },
  }
}

describe('shared passive policy arbitration', () => {
  it.each(['temperature', 'power_on'] as const)('rechecks personal authority after %s reconnect before changing persistent intent', async (operation) => {
    const context = harness(), paused = vi.fn()
    const previous = request('manual', 71)
    context.holds.left = previous
    context.deps.onManualControl = paused
    let current = true
    context.deps.connect = async () => {
      current = false
    }
    const check = () => {
      if (!current) throw new ControlGuardError()
    }
    await expect(withinDispatchGuard(check, () => withSideLock('left', () => operation === 'temperature'
      ? context.controller.setManualLocked('left', 80)
      : context.controller.powerOnLocked('left', 80, () => true, true)))).rejects.toBeInstanceOf(ControlGuardError)
    expect(context.holds.left).toBe(previous)
    expect(paused).not.toHaveBeenCalled()
    expect(context.apply).not.toHaveBeenCalled()
  })

  it.each(['temperature', 'power_on', 'power_off', 'resume', 'clear_hold'] as const)('expired %s commands leave existing intent and manual-pause state unchanged', async (operation) => {
    const context = harness(), paused = vi.fn()
    const previous = request('manual', 71)
    context.holds.left = previous
    context.deps.onManualControl = paused
    let clock = 1000
    const scope = { issuedAt: 1000, expiresAt: 2000, monotonicDeadline: 2000,
      now: () => clock, monotonicNow: () => clock, beforeDispatch: vi.fn(),
      dispatchCount: 0, deadlineRejected: false, closed: false }
    const execute = async () => {
      clock = 2000
      switch (operation) {
        case 'temperature': return context.controller.setManual('left', 80)
        case 'power_on': return withSideLock('left', () => context.controller.powerOnLocked('left', 80, () => true, true))
        case 'power_off': return withSideLock('left', () => context.controller.powerOffLocked('left', true))
        case 'resume': return context.controller.resume('left')
        case 'clear_hold': return withSideLock('left', async () => context.controller.clearHoldLocked('left'))
      }
    }
    await expect(withinControlRequest(scope, execute)).rejects.toThrow('expired')
    expect(context.holds.left).toBe(previous)
    expect(context.powered.left).toBe(true)
    expect(paused).not.toHaveBeenCalled()
    expect(context.apply).not.toHaveBeenCalled()
  })

  it('revalidates a conditional manual target after connecting, before persistence or manual pause', async () => {
    const context = harness(), paused = vi.fn()
    let current = true
    context.deps.onManualControl = paused
    context.deps.connect = async () => {
      current = false
    }
    await expect(withSideLock('left', () => context.controller.setManualLocked('left', 74, undefined, undefined, () => {
      if (!current) throw new Error('HomeKit observation expired')
    }))).rejects.toThrow('HomeKit observation expired')
    expect(context.holds.left).toBeNull()
    expect(context.apply).not.toHaveBeenCalled()
    expect(paused).not.toHaveBeenCalled()
  })

  it('records explicit manual intent before a write but leaves scheduled reconciliation alone', async () => {
    const context = harness()
    const paused = vi.fn()
    context.deps.onManualControl = paused
    await context.controller.reconcile('left')
    await withSideLock('left', () => context.controller.powerOnLocked('left'))
    expect(paused).not.toHaveBeenCalled()
    await context.controller.setManual('left', 74)
    expect(paused.mock.invocationCallOrder[0]).toBeLessThan(context.apply.mock.invocationCallOrder.at(-1) ?? 0)
    await context.controller.resume('left')
    await withSideLock('left', () => context.controller.powerOffLocked('left', true))
    await withSideLock('left', () => context.controller.powerOnLocked('left', 75, () => true, true))
    expect(paused).toHaveBeenCalledTimes(4)
    context.blocked.left = true
    await expect(context.controller.setManual('left', 74)).rejects.toThrow('Pump stall')
    expect(paused).toHaveBeenCalledTimes(4)
  })
  it('keeps a comfort lease when the rules engine replaces its own evaluation', async () => {
    const context = harness()
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71)], () => true)
    await context.controller.replaceAutopilot('left', [])
    expect(context.controller.status('left')).toMatchObject({ requestId: 'policy:comfort:autopilot', targetTemperature: 71 })
    expect(context.apply).toHaveBeenCalledTimes(1)
  })

  it('arbitrates both producers and returns to comfort when the higher-priority rule withdraws', async () => {
    const context = harness()
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71)], () => true)
    await context.controller.replaceAutopilot('left', [request('autopilot', 74, { priority: 10 })])
    expect(context.controller.status('left')).toMatchObject({ requestId: 'autopilot', targetTemperature: 74 })
    await context.controller.replaceAutopilot('left', [])
    expect(context.apply).toHaveBeenLastCalledWith('left', 71)
    await context.controller.replacePolicy('left', 'comfort', [], () => true)
    expect(context.apply).toHaveBeenLastCalledWith('left', 72)
  })

  it('isolates each producer and each bed side', async () => {
    const context = harness()
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71)], () => true)
    await context.controller.replacePolicy('left', 'room', [request('autopilot', 70, { priority: 1 })], () => true)
    await context.controller.replacePolicy('right', 'comfort', [request('autopilot', 67)], () => true)
    await context.controller.replacePolicy('left', 'room', [], () => true)
    expect(context.controller.status('left').targetTemperature).toBe(71)
    expect(context.controller.status('right').targetTemperature).toBe(67)
  })

  it('keeps manual and run-once ownership above passive policies', async () => {
    const context = harness()
    context.baselines.left.push(request('run-once', 73))
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71, { priority: 1_000 })], () => true)
    expect(context.apply).toHaveBeenLastCalledWith('left', 73)
    await context.controller.setManual('left', 76)
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 70, { priority: 2_000 })], () => true)
    expect(context.apply).toHaveBeenLastCalledWith('left', 76, undefined)
  })

  it('never powers an off side on even when a rule names the same request ID', async () => {
    const context = harness()
    context.powered.left = false
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71, { priority: 10 })], () => true)
    await context.controller.replaceAutopilot('left', [request('autopilot', 70, { id: 'policy:comfort:autopilot' })], ['policy:comfort:autopilot'])
    expect(context.apply).not.toHaveBeenCalled()
    expect(context.controller.status('left').blocked).toBe('off')
  })

  it('revokes stale leases and never resurrects them when a signal recovers', async () => {
    const context = harness()
    let fresh = true
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71)], () => fresh)
    fresh = false
    await context.controller.reconcile('left')
    expect(context.apply).toHaveBeenLastCalledWith('left', 72)
    fresh = true
    await context.controller.reconcile('left')
    expect(context.controller.status('left').source).toBe('schedule')
  })

  it('rechecks the guard after a delayed connection and does not replay the old proposal', async () => {
    const context = harness()
    let fresh = true
    vi.mocked(context.deps.connect).mockImplementation(async () => {
      fresh = false
    })
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71)], () => fresh)
    expect(context.apply).toHaveBeenCalledExactlyOnceWith('left', 72)
  })

  it('treats failed guards as unavailable and expires leases without extending them', async () => {
    const context = harness()
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71)], () => {
      throw new Error('sensor unavailable')
    })
    expect(context.controller.status('left').source).toBe('schedule')
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71, { expiresAt: 2_000 })], () => true)
    context.advance(1_000)
    await context.controller.reconcile('left')
    expect(context.apply).toHaveBeenLastCalledWith('left', 72)
  })

  it.each([
    { durationSec: 0 }, { durationSec: 600 }, { temperature: NaN }, { createdAt: NaN },
    { createdAt: 1_001 }, { priority: Infinity }, { expiresAt: 999 }, { id: '' },
  ])('rejects a malformed passive lease atomically: %j', async (changes) => {
    const context = harness()
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71)], () => true)
    await expect(context.controller.replacePolicy('left', 'comfort', [request('autopilot', 70, changes)], () => true)).rejects.toThrow('Invalid policy lease')
    expect(context.controller.status('left').targetTemperature).toBe(71)
  })

  it('drops an obsolete producer evaluation after waiting for the side lock', async () => {
    const context = harness()
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71)], () => true, () => false)
    expect(context.apply).not.toHaveBeenCalled()
    expect(context.controller.status('left').source).toBe('schedule')
  })

  it('revokes a producer generation that becomes obsolete after publication', async () => {
    const context = harness()
    let current = true
    await context.controller.replacePolicy('left', 'comfort', [request('autopilot', 71)], () => true, () => current)
    current = false
    await context.controller.reconcile('left')
    expect(context.controller.status('left').source).toBe('schedule')
  })
})

describe('temperature arbitration', () => {
  it('selects source priority independently of producer order', () => {
    const requests = [request('manual', 75), request('schedule', 72), request('run-once', 71), request('autopilot', 70)]
    expect(selectTemperatureRequest(requests, 100)?.temperature).toBe(75)
    expect(selectTemperatureRequest(requests.slice(1), 100)?.temperature).toBe(71)
    expect(selectTemperatureRequest(requests.filter(r => r.source === 'autopilot' || r.source === 'schedule'), 100)?.temperature).toBe(70)
  })

  it('uses rule priority before activation time and a stable tie break', () => {
    const a = request('autopilot', 70, { id: 'a', priority: 2 })
    const b = request('autopilot', 80, { id: 'b', priority: 1, createdAt: 90 })
    expect(selectTemperatureRequest([b, a], 100)).toEqual(a)
    expect(selectTemperatureRequest([{ ...a, id: 'c' }, a], 100)).toEqual(a)
  })

  it('rejects future, expired, and invalid targets including NaN', () => {
    const baseline = request('schedule', 72)
    for (const bad of [{ startsAt: 101 }, { expiresAt: 100 }, { temperature: NaN }, { temperature: 111 }, { temperature: 54 }]) {
      expect(selectTemperatureRequest([request('manual', 75, bad), baseline], 100)).toEqual(baseline)
    }
  })

  it('publishes ownership changes without repeating unchanged periodic status', async () => {
    const h = harness()
    await h.controller.reconcile('left')
    await h.controller.reconcile('right')
    expect(h.deps.publish).toHaveBeenCalledTimes(2)
    h.advance(1_000)
    await h.controller.reconcile('left')
    await h.controller.reconcile('right')
    expect(h.deps.publish).toHaveBeenCalledTimes(2)
    await h.controller.setManual('left', 75)
    expect(h.deps.publish).toHaveBeenCalledTimes(3)
    h.advance(1_000)
    await h.controller.setManual('left', 75)
    expect(h.deps.publish).toHaveBeenCalledTimes(4) // hold expiry changed
    h.blocked.left = true
    await h.controller.reconcile('left')
    expect(h.deps.publish).toHaveBeenCalledTimes(5)
    await h.controller.resume('left')
    expect(h.deps.publish).toHaveBeenLastCalledWith('left', expect.objectContaining({ source: 'schedule', blocked: 'safety' }))
    expect(h.deps.publish).toHaveBeenCalledTimes(6)
  })

  it('power-on without a requested temperature honors the current owner without a hold', async () => {
    const h = harness()
    h.powered.left = false
    h.baselines.left.push(request('run-once', 69))
    await withSideLock('left', () => h.controller.powerOnLocked('left'))
    expect(h.apply).toHaveBeenLastCalledWith('left', 69)
    expect(h.holds.left).toBeNull()
    h.baselines.left = [request('schedule', 66)]
    await h.controller.reconcile('left')
    expect(h.apply).toHaveBeenLastCalledWith('left', 66)
  })

  it('retains evolving lower-priority targets throughout a manual hold', async () => {
    const h = harness()
    await h.controller.setManual('left', 75)
    await h.controller.submit('left', request('autopilot', 70))
    h.baselines.left = [request('schedule', 66), request('run-once', 69)]
    await h.controller.reconcile('left')
    expect(h.apply.mock.calls).toEqual([['left', 75, undefined]])
    h.advance(DEFAULT_HOLD_MS)
    await h.controller.reconcile('left')
    expect(h.apply).toHaveBeenLastCalledWith('left', 69)
    expect(h.holds.left).toBeNull()
  })

  it('refreshes the hold on another adjustment without affecting the other side', async () => {
    const h = harness()
    await h.controller.setManual('left', 75)
    h.advance(60_000)
    await h.controller.setManual('left', 76)
    expect(h.holds.left?.expiresAt).toBe(61_000 + DEFAULT_HOLD_MS)
    expect(h.controller.status('right').holdUntil).toBeNull()
    await h.controller.reconcile('right')
    expect(h.apply).toHaveBeenLastCalledWith('right', 68)
  })

  it('restores a persisted hold in a new controller without extending it', async () => {
    const h = harness()
    await h.controller.setManual('left', 75)
    const expiry = h.holds.left?.expiresAt
    h.advance(10_000)
    const restarted = new TemperatureController(h.deps)
    await restarted.reconcile('left')
    expect(h.apply).toHaveBeenLastCalledWith('left', 75)
    expect(restarted.status('left').holdUntil).toBe(expiry)
  })

  it('preserves a custom hardware cutoff across restart, Resume, and forced keepalive', async () => {
    const h = harness()
    await h.controller.setManual('left', 75, DEFAULT_HOLD_MS, 600)
    h.advance(300_000)
    const restarted = new TemperatureController(h.deps)
    await restarted.reconcile('left')
    expect(h.apply).toHaveBeenLastCalledWith('left', 75, 300)
    await restarted.resume('left')
    expect(h.apply).toHaveBeenLastCalledWith('left', 72, 300)
    h.advance(60_000)
    await restarted.reconcile('left', true)
    expect(h.apply).toHaveBeenLastCalledWith('left', 72, 240)
    expect(restarted.recoveryDurationLocked('left', 28_800)).toBe(240)
    h.advance(240_000)
    h.apply.mockClear()
    await restarted.reconcile('left')
    expect(h.powered.left).toBe(false)
    expect(h.apply).not.toHaveBeenCalled()
    expect(restarted.status('left').blocked).toBe('off')
  })

  it('does not extend a live bounded hold for a scheduled power-on', async () => {
    const h = harness()
    await h.controller.setManual('left', 75, DEFAULT_HOLD_MS, 600)
    h.advance(300_000)
    await withSideLock('left', () => h.controller.powerOnLocked('left'))
    expect(h.apply).toHaveBeenLastCalledWith('left', 75, 300)
  })

  it('persists a cutoff beyond hold expiry and permits a new explicit manual session', async () => {
    const h = harness()
    await h.controller.setManual('left', 75, 60_000, 600)
    h.advance(60_000)
    await h.controller.reconcile('left')
    expect(h.apply).toHaveBeenLastCalledWith('left', 72, 540)
    await h.controller.setManual('left', 75)
    expect(h.deps.readHardwareDeadline('left')).toBeNull()
  })

  it('treats duration zero as shutdown, never a hold that can restart heating', async () => {
    const h = harness()
    await h.controller.setManual('left', 75, DEFAULT_HOLD_MS, 0)
    await h.controller.reconcile('left')
    expect(h.apply).not.toHaveBeenCalled()
    expect(h.holds.left).toBeNull()
    expect(h.powered.left).toBe(false)
  })

  it('applies a changed request deadline even when the new temperature is identical', async () => {
    const h = harness()
    await h.controller.submit('left', request('autopilot', 72, { createdAt: 1_000, durationSec: 600 }))
    expect(h.apply).toHaveBeenLastCalledWith('left', 72, 600)
    h.advance(60_000)
    await h.controller.submit('left', request('autopilot', 72, { createdAt: 61_000, durationSec: 120 }))
    expect(h.apply).toHaveBeenLastCalledWith('left', 72, 120)
    h.advance(120_000)
    await h.controller.reconcile('left')
    expect(h.powered.left).toBe(false)
  })

  it('resumes the current schedule without replaying missed events', async () => {
    const h = harness()
    await h.controller.setManual('left', 75)
    h.baselines.left = [request('schedule', 65)]
    const status = await h.controller.resume('left')
    expect(status.source).toBe('schedule')
    expect(h.apply.mock.calls.map(c => c[1])).toEqual([75, 65])
  })

  it('withdraws deactivated rules and expires one-shot requests', async () => {
    const h = harness()
    await h.controller.submit('left', request('autopilot', 70))
    await h.controller.withdraw('left', 'autopilot')
    expect(h.apply).toHaveBeenLastCalledWith('left', 72)
    await h.controller.submit('left', request('autopilot', 71, { expiresAt: 2_000 }))
    h.advance(1_000)
    await h.controller.reconcile('left')
    expect(h.apply).toHaveBeenLastCalledWith('left', 72)
  })

  it('does not let reconciliation, expiry, or Resume undo shutdown', async () => {
    const h = harness()
    await h.controller.setManual('left', 75)
    h.powered.left = false
    h.apply.mockClear()
    await h.controller.reconcile('left', true)
    await h.controller.resume('left')
    expect(h.apply).not.toHaveBeenCalled()
    expect(h.controller.status('left').blocked).toBe('off')
  })

  it('rechecks safety after waiting for a connection and refuses manual holds', async () => {
    const h = harness()
    h.deps.connect = async () => {
      h.blocked.left = true
    }
    await h.controller.reconcile('left')
    expect(h.apply).not.toHaveBeenCalled()
    await expect(h.controller.setManual('left', 75)).rejects.toThrow('Pump stall')
    expect(h.holds.left).toBeNull()
  })

  it('reselects an expired request after transport recovery', async () => {
    const h = harness()
    h.deps.connect = async () => {
      h.advance(1_000)
    }
    await h.controller.submit('left', request('autopilot', 70, { expiresAt: 2_000 }))
    expect(h.apply).toHaveBeenCalledExactlyOnceWith('left', 72)
  })

  it('discards an obsolete queued automation shutdown while allowing operator shutdown', async () => {
    const h = harness()
    let release!: () => void
    const holder = withSideLock('left', () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await Promise.resolve()
    let current = true
    const pending = h.controller.powerOff('left', () => current)
    current = false
    release()
    await Promise.all([holder, pending])
    expect(h.powered.left).toBe(true)
    await h.controller.powerOff('left')
    expect(h.powered.left).toBe(false)
  })

  it('serializes a queued automation behind a newer manual adjustment', async () => {
    const h = harness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const owner = withSideLock('left', async () => {
      entered()
      await gate
    })
    await waiting
    const manual = h.controller.setManual('left', 75)
    const automated = h.controller.submit('left', request('autopilot', 70))
    release()
    await Promise.all([owner, manual, automated])
    expect(h.apply).toHaveBeenCalledExactlyOnceWith('left', 75, undefined)
  })

  it('does not apply a command when its hold cannot be persisted', async () => {
    const h = harness()
    h.deps.writeHold = () => {
      throw new Error('disk full')
    }
    await expect(h.controller.setManual('left', 75)).rejects.toThrow('disk full')
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('restores the previous hold after a failed hardware command', async () => {
    const h = harness()
    await h.controller.setManual('left', 75)
    const previous = h.holds.left
    h.apply.mockRejectedValueOnce(new Error('disconnected'))
    await expect(h.controller.setManual('left', 76)).rejects.toThrow('disconnected')
    expect(h.holds.left).toEqual(previous)
  })

  it('refreshes always-on without inventing a hold when there is no schedule', async () => {
    const h = harness()
    h.baselines.left = []
    await h.controller.reconcile('left', true)
    expect(h.apply).toHaveBeenCalledExactlyOnceWith('left', 75)
    expect(h.controller.status('left').source).toBeNull()
    expect(h.holds.left).toBeNull()
  })

  it('does not write twice when a target appears during keepalive connection', async () => {
    const h = harness()
    h.baselines.left = []
    h.deps.connect = async () => {
      h.baselines.left = [request('schedule', 72)]
    }
    await h.controller.reconcile('left', true)
    expect(h.apply).toHaveBeenCalledExactlyOnceWith('left', 72)
  })

  it('keeps a failed shutdown latched off until an explicit power-on succeeds', async () => {
    const h = harness()
    h.deps.powerOff = async () => {
      throw new Error('state persistence failed')
    }
    await expect(withSideLock('left', () => h.controller.powerOffLocked('left'))).rejects.toThrow('persistence')
    await h.controller.reconcile('left')
    expect(h.apply).not.toHaveBeenCalled()
    await withSideLock('left', () => h.controller.powerOnLocked('left'))
    expect(h.apply).toHaveBeenCalledExactlyOnceWith('left', 72)
    expect(h.controller.status('left').blocked).toBeNull()
  })
})

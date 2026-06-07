/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for src/automation/instance.ts — the AutomationEngine singleton wrapper.
 *
 * Covers: lazy init + caching, timezone-from-db with fallbacks, kill-switch
 * restore from persisted settings (on / off / unreadable), teardown, and the
 * production dependency closures the wrapper injects (loadRules, recordRun,
 * disableRule, hasActiveRunOnceSession, and the hardware/broadcast wiring).
 *
 * The AutomationEngine class and the hardware/signal modules are mocked at the
 * import boundary so only the wrapper's wiring is exercised; engine behaviour
 * is covered in engine.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ctorMock = vi.fn()
const startMock = vi.fn(async () => {})
const stopMock = vi.fn()
const setGlobalEnabledMock = vi.fn()
let capturedDeps: any = null

vi.mock('../engine', () => {
  class AutomationEngine {
    constructor(deps: any) {
      capturedDeps = deps
      ctorMock(deps)
    }

    start = startMock
    stop = stopMock
    setGlobalEnabled = setGlobalEnabledMock
  }
  return { AutomationEngine }
})

vi.mock('../signals', () => ({
  DeviceSignalReader: class {
    read() { return {} }
  },
  clockInTimezone: vi.fn(() => ({ nowMinutes: 123, dayOfWeek: 'monday' })),
}))

const hardwareClient = { connect: async () => {}, setTemperature: async () => {}, setPower: async () => {} }
const markSideMutatedMock = vi.fn()
const broadcastMock = vi.fn()

vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getSharedHardwareClient: () => hardwareClient }))
vi.mock('@/src/hardware/deviceStateSync', () => ({ markSideMutated: markSideMutatedMock }))
vi.mock('@/src/hardware/sideLock', () => ({ withSideLock: async (_side: any, fn: () => Promise<any>) => fn() }))
vi.mock('@/src/streaming/broadcastMutationStatus', () => ({ broadcastMutationStatus: broadcastMock }))
vi.mock('drizzle-orm', () => ({ and: (...a: any[]) => ({ a }), eq: (...a: any[]) => ({ a }), gt: (...a: any[]) => ({ a }) }))
vi.mock('@/src/db/schema', () => ({
  automationRuns: {},
  automations: { id: 'id' },
  deviceSettings: { autopilotEnabled: 'autopilotEnabled', timezone: 'timezone' },
  runOnceSessions: { id: 'id', side: 'side', status: 'status', expiresAt: 'expiresAt' },
}))

// Reassignable behaviours the db mock delegates to.
let selectImpl: () => Promise<any[]> = async () => []
let insertImpl: (v: unknown) => Promise<void> = async () => {}

vi.mock('@/src/db', () => {
  const thenable = (): any => {
    const p: any = {
      from() { return p },
      where() { return p },
      limit() { return p },
      then(res: (v: any) => void, rej?: (e: unknown) => void) { selectImpl().then(res, rej) },
    }
    return p
  }
  return {
    db: {
      select: () => thenable(),
      insert: () => ({ values: (v: unknown) => insertImpl(v) }),
      update: () => ({ set: () => ({ where: async (w: unknown) => w }) }),
    },
  }
})

import type * as InstanceModuleTypes from '../instance'
type InstanceModule = typeof InstanceModuleTypes

async function freshModule(): Promise<InstanceModule> {
  vi.resetModules()
  return await import('../instance')
}

beforeEach(() => {
  ctorMock.mockClear()
  startMock.mockClear()
  stopMock.mockClear()
  setGlobalEnabledMock.mockClear()
  markSideMutatedMock.mockClear()
  broadcastMock.mockClear()
  capturedDeps = null
  selectImpl = async () => []
  insertImpl = async () => {}
})

describe('automation/instance — init & caching', () => {
  it('constructs the engine, starts it, and caches the instance', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    selectImpl = async () => [{ timezone: 'UTC', on: true }]
    const mod = await freshModule()

    expect(mod.getAutomationEngineIfRunning()).toBeNull()
    const a = await mod.getAutomationEngine()
    const b = await mod.getAutomationEngine()

    expect(a).toBe(b)
    expect(ctorMock).toHaveBeenCalledTimes(1)
    expect(startMock).toHaveBeenCalledTimes(1)
    expect(mod.getAutomationEngineIfRunning()).toBe(a)
    expect(setGlobalEnabledMock).not.toHaveBeenCalled() // kill-switch on → no override
    expect(log).toHaveBeenCalledWith('AutomationEngine initialized with timezone:', 'UTC')
    log.mockRestore()
  })

  it('falls back to the default timezone when no settings row exists', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    selectImpl = async () => []
    const mod = await freshModule()
    await mod.getAutomationEngine()
    expect(log).toHaveBeenCalledWith('AutomationEngine initialized with timezone:', 'America/Los_Angeles')
    log.mockRestore()
  })

  it('falls back to the default timezone when the db read throws', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    selectImpl = async () => {
      throw new Error('db down')
    }
    const mod = await freshModule()
    await mod.getAutomationEngine()
    expect(log).toHaveBeenCalledWith('AutomationEngine initialized with timezone:', 'America/Los_Angeles')
    log.mockRestore()
  })
})

describe('automation/instance — kill-switch restore', () => {
  it('engages the kill-switch when the persisted setting is off', async () => {
    selectImpl = async () => [{ timezone: 'UTC', on: false }]
    const mod = await freshModule()
    await mod.getAutomationEngine()
    expect(setGlobalEnabledMock).toHaveBeenCalledWith(false)
  })

  it('leaves autopilot enabled when the kill-switch read throws', async () => {
    // First select (timezone) succeeds; second (kill-switch) throws.
    let calls = 0
    selectImpl = async () => {
      calls++
      if (calls === 1) return [{ timezone: 'UTC' }]
      throw new Error('settings unreadable')
    }
    const mod = await freshModule()
    await mod.getAutomationEngine()
    expect(setGlobalEnabledMock).not.toHaveBeenCalled()
  })
})

describe('automation/instance — shutdown', () => {
  it('stops the engine and clears state', async () => {
    selectImpl = async () => [{ timezone: 'UTC', on: true }]
    const mod = await freshModule()
    await mod.getAutomationEngine()

    await mod.shutdownAutomationEngine()
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(mod.getAutomationEngineIfRunning()).toBeNull()
  })

  it('is a no-op when no engine is running', async () => {
    const mod = await freshModule()
    await mod.shutdownAutomationEngine()
    expect(stopMock).not.toHaveBeenCalled()
  })
})

describe('automation/instance — injected dependency closures', () => {
  it('wires loadRules / recordRun / disableRule / runOnce / hardware deps', async () => {
    selectImpl = async () => [{ timezone: 'UTC', on: true }]
    const mod = await freshModule()
    await mod.getAutomationEngine()
    expect(capturedDeps).toBeTruthy()

    // loadRules maps DB rows to the engine's AutomationRule shape.
    selectImpl = async () => [{
      id: 9,
      name: 'r',
      enabled: true,
      side: 'left',
      priority: 0,
      dryRun: false,
      cooldownMin: 30,
      trigger: { kind: 'tick', everyMin: 1 },
      conditions: { kind: 'and', conditions: [] },
      actions: [{ kind: 'notify', message: 'x' }],
    }]
    const rules = await capturedDeps.loadRules()
    expect(rules).toEqual([{
      id: 9,
      name: 'r',
      enabled: true,
      side: 'left',
      priority: 0,
      dryRun: false,
      cooldownMin: 30,
      trigger: { kind: 'tick', everyMin: 1 },
      conditions: { kind: 'and', conditions: [] },
      actions: [{ kind: 'notify', message: 'x' }],
    }])

    // recordRun inserts; the failure path is swallowed with a warning.
    let inserted: any = null
    insertImpl = async (v) => {
      inserted = v
    }
    await capturedDeps.recordRun(9, 'fired', { actions: [] })
    expect(inserted).toMatchObject({ automationId: 9, outcome: 'fired' })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    insertImpl = async () => {
      throw new Error('insert failed')
    }
    await expect(capturedDeps.recordRun(9, 'error', {})).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()

    // disableRule resolves through the mocked update chain.
    await expect(capturedDeps.disableRule(9)).resolves.toBeUndefined()

    // hasActiveRunOnceSession reflects whether a row was found.
    selectImpl = async () => [{ id: 1 }]
    expect(await capturedDeps.hasActiveRunOnceSession('left')).toBe(true)
    selectImpl = async () => []
    expect(await capturedDeps.hasActiveRunOnceSession('right')).toBe(false)

    // Remaining wiring closures.
    expect(typeof capturedDeps.now()).toBe('number')
    expect(capturedDeps.clock()).toEqual({ nowMinutes: 123, dayOfWeek: 'monday' })
    expect(capturedDeps.getHardware()).toBe(hardwareClient)
    expect(await capturedDeps.withSideLock('left', async () => 42)).toBe(42)

    capturedDeps.broadcast('left', { targetLevel: 0 })
    expect(broadcastMock).toHaveBeenCalledWith('left', { targetLevel: 0 })
    capturedDeps.markMutated('left')
    expect(markSideMutatedMock).toHaveBeenCalledWith('left')

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    capturedDeps.notify(9, 'hello')
    capturedDeps.log('a message')
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})

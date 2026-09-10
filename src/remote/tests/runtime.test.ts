// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyConfig, type Detection } from '../model'
import type { executeRemoteAction as ActionExecutor } from '../actions'

const mocks = vi.hoisted(() => ({
  frame: undefined as ((frame: Record<string, unknown>) => void) | undefined,
  unsubscribe: vi.fn(), read: vi.fn(), action: vi.fn(),
  row: vi.fn(), blocked: vi.fn(), runNow: vi.fn(),
  device: { setTemperature: vi.fn(), setPower: vi.fn(), clearAlarm: vi.fn(), snoozeAlarm: vi.fn(), startPriming: vi.fn() },
  settings: { updateSide: vi.fn() },
}))
vi.mock('@/src/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ get: mocks.row }) }) }) }, sqlite: {} }))
vi.mock('@/src/streaming/piezoStream', () => ({ onServerFrame: (fn: typeof mocks.frame) => {
  mocks.frame = fn
  return mocks.unsubscribe
} }))
vi.mock('../store', () => ({ RemoteStore: class { read = mocks.read } }))
vi.mock('../actions', () => ({ executeRemoteAction: mocks.action }))
vi.mock('@/src/automation', () => ({ getAutomationEngine: async () => ({ runNow: mocks.runNow }) }))
vi.mock('@/src/hardware/pumpStallGuard', () => ({ shouldBlock: mocks.blocked }))
vi.mock('@/src/server/routers/app', () => ({ appRouter: { createCaller: () => ({ device: mocks.device, settings: mocks.settings }) } }))

import { remoteStatus, startRemoteRuntime, stopRemoteRuntime, subscribeRemote } from '../runtime'

describe('browser-independent remote runtime', () => {
  let events: Detection[]
  let sequence = 0
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1788768700000)
    vi.clearAllMocks()
    events = []
    mocks.read.mockReturnValue({ ...emptyConfig(), left: { 'top.single': { action: 'power.off' } } })
    mocks.action.mockResolvedValue('Completed')
    mocks.row.mockReturnValue({ targetTemperature: 70, isPowered: true, isAlarmVibrating: true, awayMode: false })
    mocks.blocked.mockReturnValue(false)
    subscribeRemote(e => events.push(e))
    startRemoteRuntime()
  })
  afterEach(async () => {
    await stopRemoteRuntime()
    vi.useRealTimers()
  })
  function click(side = 'left', count = 1) {
    mocks.frame?.({ type: 'buttonEvent', ts: Date.now() / 1000, remoteSource: `frame:${sequence++}`, [side]: { top: count } })
  }
  it('connects saved bindings to the real action executor and existing device APIs', async () => {
    const { executeRemoteAction } = await vi.importActual<{ executeRemoteAction: typeof ActionExecutor }>('../actions')
    mocks.action.mockImplementation(executeRemoteAction)
    const bindings = [
      { action: 'temp.up', deltaF: 2 }, { action: 'power.toggle' },
      { action: 'alarm.off' }, { action: 'alarm.snooze', durationSec: 540 },
      { action: 'away.toggle' }, { action: 'prime.start' },
      { action: 'automation.run', automationId: 42 },
    ]
    for (const binding of bindings) {
      mocks.read.mockReturnValue({ ...emptyConfig(), left: { 'top.single': binding } })
      click()
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(mocks.device.setTemperature).toHaveBeenCalledWith({ side: 'left', temperature: 72 })
    expect(mocks.device.setPower).toHaveBeenCalledWith({ side: 'left', powered: false })
    expect(mocks.device.clearAlarm).toHaveBeenCalledWith({ side: 'left' })
    expect(mocks.device.snoozeAlarm).toHaveBeenCalledWith({ side: 'left', duration: 540 })
    expect(mocks.settings.updateSide).toHaveBeenCalledWith({ side: 'left', awayMode: true })
    expect(mocks.device.startPriming).toHaveBeenCalledWith({})
    expect(mocks.runNow).toHaveBeenCalledWith(42)
  })
  it('reports missing state, deleted automation and priming interlocks without issuing commands', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { executeRemoteAction } = await vi.importActual<{ executeRemoteAction: typeof ActionExecutor }>('../actions')
    mocks.action.mockImplementation(executeRemoteAction)
    mocks.row.mockReturnValue(undefined)
    for (const [binding, message] of [
      [{ action: 'temp.up', deltaF: 1 }, 'Device state unavailable'],
      [{ action: 'away.toggle' }, 'Side settings unavailable'],
      [{ action: 'automation.run', automationId: 42 }, 'Automation no longer exists'],
    ] as const) {
      mocks.read.mockReturnValue({ ...emptyConfig(), left: { 'top.single': binding } })
      click()
      await vi.advanceTimersByTimeAsync(1000)
      expect(events.at(-1)?.outcome).toBe(`Failed: ${message}`)
    }
    mocks.read.mockReturnValue({ ...emptyConfig(), left: { 'top.single': { action: 'prime.start' } } })
    for (const side of ['left', 'right']) {
      mocks.blocked.mockImplementation(target => target === side)
      click()
      await vi.advanceTimersByTimeAsync(1000)
      expect(events.at(-1)?.outcome).toContain('Priming blocked')
    }
    expect(mocks.device.startPriming).not.toHaveBeenCalled()
    warning.mockRestore()
  })
  it('bounds a stalled queue and expires queued commands rather than releasing a burst', async () => {
    let release: ((value: string) => void) | undefined
    mocks.action.mockImplementationOnce(() => new Promise<string>((resolve) => {
      release = resolve
    }))
    for (let i = 0; i < 25; i++) click()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.action).toHaveBeenCalledTimes(1)
    expect(events.some(e => e.outcome === 'Skipped: command queue full')).toBe(true)
    await vi.advanceTimersByTimeAsync(6000)
    release?.('Completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.action).toHaveBeenCalledTimes(1)
    expect(events.at(-1)?.outcome).toBe('Skipped: stale detection')
  })
  it('shares running state and capture subscribers across independently loaded route modules', async () => {
    vi.resetModules()
    const routeRuntime = await import('../runtime')
    expect(routeRuntime.remoteStatus().running).toBe(true)
    const subscriber = vi.fn()
    const unsubscribe = routeRuntime.subscribeRemote(subscriber)
    click()
    await vi.advanceTimersByTimeAsync(1000)
    expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'Completed' }))
    unsubscribe()
  })
  it('dispatches exactly one saved action without requiring a capture subscriber', async () => {
    click()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.action).toHaveBeenCalledExactlyOnceWith({ action: 'power.off' }, 'left', expect.any(Object))
    expect(events.at(-1)?.outcome).toBe('Completed')
    expect(remoteStatus().running).toBe(true)
    startRemoteRuntime()
    await stopRemoteRuntime()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
    expect(remoteStatus().running).toBe(false)
  })
  it('leaves inherited and unsupported inputs alone', async () => {
    click('right')
    click('left', 3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.action).not.toHaveBeenCalled()
    expect(events.some(e => e.outcome === 'Firmware default (no software override)')).toBe(true)
    expect(events.some(e => e.outcome?.includes('Firmware count 3'))).toBe(true)
  })
  it('serializes commands and uses the current map when each command starts', async () => {
    let complete: ((value: string) => void) | undefined
    mocks.action.mockImplementationOnce(() => new Promise<string>((resolve) => {
      complete = resolve
    }))
    click()
    click()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.action).toHaveBeenCalledTimes(1)
    mocks.read.mockReturnValue(emptyConfig())
    complete?.('Completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.action).toHaveBeenCalledTimes(1)
    expect(events.at(-1)?.outcome).toContain('Firmware default')
  })
  it('surfaces action failure, continues processing, and cancels pending recognition on shutdown', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.action.mockRejectedValueOnce(new Error('Device disconnected'))
    click()
    await vi.advanceTimersByTimeAsync(1000)
    expect(remoteStatus().lastError).toBe('Device disconnected')
    expect(events.at(-1)?.outcome).toBe('Failed: Device disconnected')
    click()
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.at(-1)?.outcome).toBe('Completed')
    click()
    await stopRemoteRuntime()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.action).toHaveBeenCalledTimes(2)
    warning.mockRestore()
  })
})

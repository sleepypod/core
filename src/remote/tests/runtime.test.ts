// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyConfig, type Detection } from '../model'

const mocks = vi.hoisted(() => ({
  frame: undefined as ((frame: Record<string, unknown>) => void) | undefined,
  unsubscribe: vi.fn(), read: vi.fn(), action: vi.fn(),
}))
vi.mock('@/src/db', () => ({ db: {}, sqlite: {} }))
vi.mock('@/src/streaming/piezoStream', () => ({ onServerFrame: (fn: typeof mocks.frame) => {
  mocks.frame = fn
  return mocks.unsubscribe
} }))
vi.mock('../store', () => ({ RemoteStore: class { read = mocks.read } }))
vi.mock('../actions', () => ({ executeRemoteAction: mocks.action }))
vi.mock('@/src/automation', () => ({ getAutomationEngine: vi.fn() }))
vi.mock('@/src/hardware/pumpStallGuard', () => ({ shouldBlock: vi.fn() }))

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

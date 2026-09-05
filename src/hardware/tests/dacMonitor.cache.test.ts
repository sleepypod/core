import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DacMonitor } from '../dacMonitor'
import type { HardwareClient } from '../client'
import { parseDeviceStatus } from '../responseParser'
import { DEVICE_STATUS_POD4 } from './fixtures'
import { beginStatusChange } from '../statusRevision'

const status = parseDeviceStatus(DEVICE_STATUS_POD4)

describe('DacMonitor cached observations', () => {
  const client = {
    connect: vi.fn(), disconnect: vi.fn(), isConnected: vi.fn(), getDeviceStatus: vi.fn(),
  }
  let monitor: DacMonitor

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'))
    client.connect.mockResolvedValue(undefined)
    client.isConnected.mockReturnValue(true)
    client.getDeviceStatus.mockReset().mockResolvedValue(status)
    monitor = new DacMonitor({
      socketPath: '/unused', pollIntervalMs: 100,
      hardwareClient: client as unknown as HardwareClient,
    })
    monitor.on('error', () => {})
    await monitor.start()
  })

  afterEach(() => {
    monitor.stop()
    vi.useRealTimers()
  })

  it('only returns observations younger than the requested age', async () => {
    expect(monitor.getFreshStatus(2_000)).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    const observedAt = Date.now()
    expect(monitor.getFreshStatus(2_000)).toEqual(status)
    vi.setSystemTime(observedAt + 1_999)
    expect(monitor.getFreshStatus(2_000)).toEqual(status)
    vi.setSystemTime(observedAt + 2_000)
    expect(monitor.getFreshStatus(2_000)).toBeNull()
    vi.setSystemTime(observedAt - 1)
    expect(monitor.getFreshStatus(2_000)).toBeNull()
  })

  it('rejects snapshots while disconnected, degraded, stopped, or restarting', async () => {
    await vi.advanceTimersByTimeAsync(100)
    client.isConnected.mockReturnValue(false)
    expect(monitor.getFreshStatus(2_000)).toBeNull()
    client.isConnected.mockReturnValue(true)
    client.getDeviceStatus.mockRejectedValueOnce(new Error('socket lost'))
    await vi.advanceTimersByTimeAsync(100)
    expect(monitor.getFreshStatus(2_000)).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(monitor.getFreshStatus(2_000)).toEqual(status)
    monitor.stop()
    expect(monitor.getFreshStatus(2_000)).toBeNull()
    await monitor.start()
    expect(monitor.getFreshStatus(2_000)).toBeNull()
  })

  it('invalidates for overlapping writes and waits for a new observation afterwards', async () => {
    await vi.advanceTimersByTimeAsync(100)
    const finishFirst = beginStatusChange()
    const finishSecond = beginStatusChange()
    try {
      expect(monitor.getFreshStatus(2_000)).toBeNull()
      // A poll during a write is never a reusable snapshot.
      await vi.advanceTimersByTimeAsync(100)
      expect(monitor.getFreshStatus(2_000)).toBeNull()
    }
    finally {
      finishFirst()
      expect(monitor.getFreshStatus(2_000)).toBeNull()
      finishSecond()
    }
    expect(monitor.getFreshStatus(2_000)).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(monitor.getFreshStatus(2_000)).toEqual(status)
  })

  it('does not restamp a slow read that overlaps a completed write', async () => {
    let finishRead: (value: typeof status) => void = () => {}
    client.getDeviceStatus.mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = resolve
    }))
    await vi.advanceTimersByTimeAsync(100)
    beginStatusChange()()
    finishRead(status)
    await vi.advanceTimersByTimeAsync(0)
    expect(monitor.getFreshStatus(2_000)).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(monitor.getFreshStatus(2_000)).toEqual(status)
  })

  it('measures age from the beginning of a slow read', async () => {
    let finishRead: (value: typeof status) => void = () => {}
    client.getDeviceStatus.mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = resolve
    }))
    await vi.advanceTimersByTimeAsync(100)
    vi.setSystemTime(Date.now() + 2_000)
    finishRead(status)
    await vi.advanceTimersByTimeAsync(0)
    expect(monitor.getFreshStatus(2_000)).toBeNull()
  })
})

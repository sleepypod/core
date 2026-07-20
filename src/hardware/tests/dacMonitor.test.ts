import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DacMonitor } from '../dacMonitor'
import type { HardwareClient } from '../client'
import { HardwareCommand } from '../types'
import { parseDeviceStatus } from '../responseParser'
import {
  DEVICE_STATUS_POD3,
  DEVICE_STATUS_POD4,
} from './fixtures'
import { MockHardwareServer, createTestSocketPath } from './mockServer'
import { setupMockServer, sleep, waitFor } from './testUtils'

// Fast poll interval so tests don't take too long
const POLL_MS = 50

describe('DacMonitor', () => {
  const ctx = setupMockServer()
  const monitors: DacMonitor[] = []

  beforeEach(() => {
    monitors.length = 0
  })

  afterEach(() => {
    for (const m of monitors) m.stop()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const createMonitor = (pollIntervalMs = POLL_MS): DacMonitor => {
    const m = new DacMonitor({ socketPath: ctx.socketPath, pollIntervalMs })
    monitors.push(m)
    return m
  }

  test('starts and reaches running status', async () => {
    const monitor = createMonitor()
    await monitor.start()
    expect(monitor.getStatus()).toBe('running')
  })

  test('emits status:updated on each poll', async () => {
    const monitor = createMonitor()
    const updates: unknown[] = []
    monitor.on('status:updated', s => updates.push(s))

    await monitor.start()
    await waitFor(() => updates.length >= 2, 500)

    expect(updates.length).toBeGreaterThanOrEqual(2)
  })

  test('emits connection:established only for the initial connection while healthy', async () => {
    const monitor = createMonitor()
    const established = vi.fn()
    monitor.on('connection:established', established)

    await monitor.start()
    await waitFor(() => monitor.getLastStatus() !== null, 500)
    await sleep(POLL_MS * 2 + 20)

    expect(established).toHaveBeenCalledOnce()
  })

  test('does not emit gesture:detected on first poll (baseline)', async () => {
    const monitor = createMonitor()
    const gestures: unknown[] = []
    monitor.on('gesture:detected', e => gestures.push(e))

    await monitor.start()
    // Wait for first status update (baseline)
    await waitFor(() => monitor.getLastStatus() !== null, 500)
    // Give enough time for a second poll to fire if it would
    await sleep(POLL_MS + 20)

    expect(gestures).toHaveLength(0)
  })

  test('emits gesture:detected for left side doubleTap increment', async () => {
    const monitor = createMonitor()
    const gestures: Array<{ side: string, tapType: string }> = []
    monitor.on('gesture:detected', e => gestures.push(e))

    await monitor.start()
    // Wait for baseline
    await waitFor(() => monitor.getLastStatus() !== null, 500)

    // Increment doubleTap.l (baseline: l=0 → l=1)
    ctx.server.setCommandResponse(
      HardwareCommand.DEVICE_STATUS,
      DEVICE_STATUS_POD4.replace('"l":0,"r":1', '"l":1,"r":1')
    )

    await waitFor(() => gestures.length > 0, 500)
    expect(gestures).toEqual(
      expect.arrayContaining([expect.objectContaining({ side: 'left', tapType: 'doubleTap' })])
    )
  })

  test('emits gesture:detected for right side tripleTap increment', async () => {
    const monitor = createMonitor()
    const gestures: Array<{ side: string, tapType: string }> = []
    monitor.on('gesture:detected', e => gestures.push(e))

    await monitor.start()
    await waitFor(() => monitor.getLastStatus() !== null, 500)

    // tripleTap baseline: l=2, r=0 → increment r to 1
    ctx.server.setCommandResponse(
      HardwareCommand.DEVICE_STATUS,
      DEVICE_STATUS_POD4.replace('"l":2,"r":0', '"l":2,"r":1')
    )

    await waitFor(() => gestures.length > 0, 500)
    expect(gestures).toEqual(
      expect.arrayContaining([expect.objectContaining({ side: 'right', tapType: 'tripleTap' })])
    )
  })

  test('does not emit gestures for pod without gesture support', async () => {
    ctx.server.setCommandResponse(HardwareCommand.DEVICE_STATUS, DEVICE_STATUS_POD3)

    const monitor = createMonitor()
    const gestures: unknown[] = []
    const errors: unknown[] = []
    monitor.on('gesture:detected', e => gestures.push(e))
    monitor.on('error', e => errors.push(e))

    await monitor.start()
    await waitFor(() => monitor.getLastStatus() !== null, 500)
    await sleep(POLL_MS + 20)

    expect(gestures).toHaveLength(0)
    expect(errors).toHaveLength(0)
  })

  test('sets status to degraded on poll error', async () => {
    const monitor = createMonitor()
    monitor.on('error', () => {}) // prevent unhandled rejection on parse error
    await monitor.start()
    await waitFor(() => monitor.getLastStatus() !== null, 500)

    // Return an unparseable response to trigger a parse error on the next poll
    ctx.server.setCommandResponse(HardwareCommand.DEVICE_STATUS, 'GARBAGE\n\n')

    await waitFor(() => monitor.getStatus() === 'degraded', 500)
    expect(monitor.getStatus()).toBe('degraded')
  })

  test('emits connection:lost only once across consecutive failed polls', async () => {
    const monitor = createMonitor()
    monitor.on('error', () => {})
    const lost = vi.fn()
    monitor.on('connection:lost', lost)
    await monitor.start()
    await waitFor(() => monitor.getLastStatus() !== null, 500)

    ctx.server.setCommandResponse(HardwareCommand.DEVICE_STATUS, 'GARBAGE\n\n')
    await waitFor(() => monitor.getStatus() === 'degraded', 500)
    await sleep(POLL_MS * 2 + 20)

    expect(lost).toHaveBeenCalledOnce()
  })

  test('recovers from degraded on next successful poll', async () => {
    const monitor = createMonitor()
    monitor.on('error', () => {}) // prevent unhandled rejection on parse error
    await monitor.start()
    await waitFor(() => monitor.getLastStatus() !== null, 500)

    ctx.server.setCommandResponse(HardwareCommand.DEVICE_STATUS, 'GARBAGE\n\n')
    await waitFor(() => monitor.getStatus() === 'degraded', 500)

    // Restore valid response — next poll should succeed
    ctx.server.reset()
    await waitFor(() => monitor.getStatus() === 'running', 1000)
    expect(monitor.getStatus()).toBe('running')
  })

  test('does not replay gestures performed during an outage after recovery', async () => {
    const monitor = createMonitor()
    monitor.on('error', () => {}) // prevent unhandled rejection on parse error
    const gestures: Array<{ side: string, tapType: string }> = []
    monitor.on('gesture:detected', e => gestures.push(e))

    await monitor.start()
    await waitFor(() => monitor.getLastStatus() !== null, 500)

    // Outage begins
    ctx.server.setCommandResponse(HardwareCommand.DEVICE_STATUS, 'GARBAGE\n\n')
    await waitFor(() => monitor.getStatus() === 'degraded', 500)

    // During the outage the user taps 3× — counters advance unseen (l:0→3)
    ctx.server.setCommandResponse(
      HardwareCommand.DEVICE_STATUS,
      DEVICE_STATUS_POD4.replace('"l":0,"r":1', '"l":3,"r":1')
    )
    await waitFor(() => monitor.getStatus() === 'running', 1000)
    await sleep(POLL_MS * 2 + 20)

    // The missed taps must re-baseline silently, not fire as fresh events
    expect(gestures).toHaveLength(0)

    // A genuinely new tap after recovery emits exactly one event
    ctx.server.setCommandResponse(
      HardwareCommand.DEVICE_STATUS,
      DEVICE_STATUS_POD4.replace('"l":0,"r":1', '"l":4,"r":1')
    )
    await waitFor(() => gestures.length > 0, 500)
    expect(gestures).toHaveLength(1)
    expect(gestures[0]).toMatchObject({ side: 'left', tapType: 'doubleTap' })
  })

  test('stop clears interval and disconnects', async () => {
    const monitor = createMonitor()
    await monitor.start()
    expect(monitor.getStatus()).toBe('running')

    monitor.stop()
    expect(monitor.getStatus()).toBe('stopped')

    const updates: unknown[] = []
    monitor.on('status:updated', s => updates.push(s))
    await sleep(POLL_MS * 3)

    // No more polls after stop
    expect(updates).toHaveLength(0)
  })

  test('start is idempotent when already running', async () => {
    const monitor = createMonitor()
    await monitor.start()
    await monitor.start() // second call is no-op
    expect(monitor.getStatus()).toBe('running')
    expect(ctx.server.getClientCount()).toBe(1)
  })

  test('counter reset re-baselines without emitting a gesture', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const monitor = createMonitor()
    const gestures: unknown[] = []
    monitor.on('gesture:detected', e => gestures.push(e))

    await monitor.start()
    // Wait for baseline: doubleTap baseline r=1
    await waitFor(() => monitor.getLastStatus() !== null, 500)

    // Simulate pod firmware restart: r counter drops from 1 → 0
    ctx.server.setCommandResponse(
      HardwareCommand.DEVICE_STATUS,
      DEVICE_STATUS_POD4.replace('"l":0,"r":1', '"l":0,"r":0')
    )

    // Allow one poll with the reset counters
    await sleep(POLL_MS * 2 + 20)

    expect(gestures).toHaveLength(0)
    expect(warning).toHaveBeenCalledWith(
      '[DacMonitor] Gesture counter reset for doubleTap (l: 0→0, r: 1→0); re-baselining',
    )
    warning.mockRestore()
  })

  test('counter reset re-establishes baseline for subsequent increments', async () => {
    const monitor = createMonitor()
    const gestures: Array<{ side: string, tapType: string }> = []
    monitor.on('gesture:detected', e => gestures.push(e))

    await monitor.start()
    // Baseline: doubleTap r=1
    await waitFor(() => monitor.getLastStatus() !== null, 500)

    // Simulate pod restart: doubleTap.r drops from 1 → 0; monitor re-baselines to r=0
    ctx.server.setCommandResponse(
      HardwareCommand.DEVICE_STATUS,
      DEVICE_STATUS_POD4.replace('"l":0,"r":1', '"l":0,"r":0')
    )
    await sleep(POLL_MS * 2 + 20)
    expect(gestures).toHaveLength(0) // re-baseline, no gesture

    // Restore original response (doubleTap r=1 > new baseline 0) → gesture should fire
    ctx.server.reset()

    await waitFor(() => gestures.length > 0, 500)
    expect(gestures).toEqual(
      expect.arrayContaining([expect.objectContaining({ side: 'right', tapType: 'doubleTap' })])
    )
  })

  test('emits gesture:detected for both sides in same poll', async () => {
    const monitor = createMonitor()
    const gestures: Array<{ side: string, tapType: string }> = []
    monitor.on('gesture:detected', e => gestures.push(e))

    await monitor.start()
    await waitFor(() => monitor.getLastStatus() !== null, 500)

    // Increment both l and r on doubleTap in one poll (baseline: l=0, r=1 → l=1, r=2)
    ctx.server.setCommandResponse(
      HardwareCommand.DEVICE_STATUS,
      DEVICE_STATUS_POD4.replace('"l":0,"r":1', '"l":1,"r":2')
    )

    await waitFor(() => gestures.length >= 2, 500)
    expect(gestures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ side: 'left', tapType: 'doubleTap' }),
        expect.objectContaining({ side: 'right', tapType: 'doubleTap' }),
      ])
    )
  })

  test('setPollInterval is a no-op when given the current interval', async () => {
    const monitor = createMonitor(POLL_MS)
    await monitor.start()
    const updates: unknown[] = []
    monitor.on('status:updated', s => updates.push(s))
    await sleep(POLL_MS * 3 + 20)
    const before = updates.length

    monitor.setPollInterval(POLL_MS) // same value → early return
    updates.length = 0
    await sleep(POLL_MS * 3 + 20)

    // Cadence unchanged: roughly the same number of polls in the same window
    expect(updates.length).toBeGreaterThanOrEqual(before - 1)
    expect(updates.length).toBeLessThanOrEqual(before + 1)
  })

  test('does not install a poll timer when changing cadence while stopped', () => {
    vi.useFakeTimers()
    const monitor = createMonitor(POLL_MS)

    monitor.setPollInterval(POLL_MS + 1)

    expect(vi.getTimerCount()).toBe(0)
    expect(monitor.getStatus()).toBe('stopped')
  })

  test('does not restart the timer when cadence is unchanged', async () => {
    vi.useFakeTimers()
    const status = parseDeviceStatus(DEVICE_STATUS_POD4)
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      getDeviceStatus: vi.fn().mockResolvedValue(status),
    } as unknown as HardwareClient
    const monitor = new DacMonitor({ socketPath: '/unused', pollIntervalMs: 25, hardwareClient: client })
    monitors.push(monitor)
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    await monitor.start()

    monitor.setPollInterval(25)

    expect(setIntervalSpy).toHaveBeenCalledOnce()
    expect(clearIntervalSpy).not.toHaveBeenCalled()
  })

  test('never overlaps interval polls while a hardware read is unresolved', async () => {
    vi.useFakeTimers()
    let resolveStatus!: (status: ReturnType<typeof parseDeviceStatus>) => void
    const pending = new Promise<ReturnType<typeof parseDeviceStatus>>((resolve) => {
      resolveStatus = resolve
    })
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      getDeviceStatus: vi.fn().mockReturnValue(pending),
    } as unknown as HardwareClient
    const monitor = new DacMonitor({ socketPath: '/unused', pollIntervalMs: 10, hardwareClient: client })
    monitors.push(monitor)
    await monitor.start()

    await vi.advanceTimersByTimeAsync(100)
    expect(client.getDeviceStatus).toHaveBeenCalledOnce()

    resolveStatus(parseDeviceStatus(DEVICE_STATUS_POD4))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(client.getDeviceStatus).toHaveBeenCalledTimes(2)
  })

  test('discards a poll result that resolves after stop and disconnects once', async () => {
    vi.useFakeTimers()
    let resolveStatus!: (status: ReturnType<typeof parseDeviceStatus>) => void
    const pending = new Promise<ReturnType<typeof parseDeviceStatus>>((resolve) => {
      resolveStatus = resolve
    })
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      getDeviceStatus: vi.fn().mockReturnValue(pending),
    } as unknown as HardwareClient
    const monitor = new DacMonitor({ socketPath: '/unused', pollIntervalMs: 10, hardwareClient: client })
    monitors.push(monitor)
    const updated = vi.fn()
    monitor.on('status:updated', updated)
    await monitor.start()
    await vi.advanceTimersByTimeAsync(10)

    monitor.stop()
    resolveStatus(parseDeviceStatus(DEVICE_STATUS_POD4))
    await Promise.resolve()
    await Promise.resolve()

    expect(updated).not.toHaveBeenCalled()
    expect(monitor.getLastStatus()).toBeNull()
    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  test('setPollInterval restarts the interval timer at the new cadence', async () => {
    const monitor = createMonitor(200) // start slow
    await monitor.start()
    const updates: unknown[] = []
    monitor.on('status:updated', s => updates.push(s))

    monitor.setPollInterval(POLL_MS) // speed up to 50ms
    await sleep(POLL_MS * 5 + 50)

    // At 50ms cadence over ~300ms we should see at least 3 polls; at 200ms we'd see 1
    expect(updates.length).toBeGreaterThanOrEqual(3)
  })

  test('setActive / setIdle reconfigure pollIntervalMs without crashing', async () => {
    const monitor = createMonitor()
    await monitor.start()
    await waitFor(() => monitor.getLastStatus() !== null, 500)

    monitor.setActive()
    monitor.setIdle()
    monitor.setActive()

    expect(monitor.getStatus()).toBe('running')
  })

  test('setActive and setIdle select their exact documented cadences', () => {
    const monitor = createMonitor()
    const setPollInterval = vi.spyOn(monitor, 'setPollInterval')

    monitor.setActive()
    monitor.setIdle()

    expect(setPollInterval.mock.calls).toEqual([[1000], [5000]])
  })

  test('start marks status degraded when daemon is unreachable', async () => {
    const monitor = new DacMonitor({
      socketPath: '/tmp/sleepypod-test-nonexistent.sock',
      pollIntervalMs: POLL_MS,
    })
    monitors.push(monitor)
    const errors: unknown[] = []
    monitor.on('error', e => errors.push(e))

    await monitor.start()

    expect(monitor.getStatus()).toBe('degraded')
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })

  test('recovers when the daemon appears after an initially failed default-client connection', async () => {
    const socketPath = createTestSocketPath()
    const server = new MockHardwareServer(socketPath)
    const monitor = new DacMonitor({ socketPath, pollIntervalMs: 20 })
    monitors.push(monitor)
    monitor.on('error', () => {})

    await monitor.start()
    expect(monitor.getStatus()).toBe('degraded')
    await server.start()
    try {
      await waitFor(() => monitor.getStatus() === 'running', 1000)
      expect(monitor.getLastStatus()).toEqual(expect.objectContaining({ podVersion: 'I00' }))
    }
    finally {
      monitor.stop()
      await server.stop()
    }
  })

  test('gesture:detected event includes timestamp', async () => {
    const monitor = createMonitor()
    const gestures: Array<{ timestamp: unknown }> = []
    monitor.on('gesture:detected', e => gestures.push(e))

    await monitor.start()
    await waitFor(() => monitor.getLastStatus() !== null, 500)

    ctx.server.setCommandResponse(
      HardwareCommand.DEVICE_STATUS,
      DEVICE_STATUS_POD4.replace('"l":0,"r":0', '"l":1,"r":0') // quadTap.l increment
    )

    await waitFor(() => gestures.length > 0, 500)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(gestures[0]!.timestamp).toBeInstanceOf(Date)
  })
})

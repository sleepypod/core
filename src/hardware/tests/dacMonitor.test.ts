import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DacMonitor } from '../dacMonitor'
import { HardwareCommand } from '../types'
import {
  DEVICE_STATUS_POD3,
  DEVICE_STATUS_POD4,
} from './fixtures'
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
  })

  test('counter reset re-baselines without emitting a gesture', async () => {
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

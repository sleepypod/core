/**
 * Tests for useSensorStream and friends — covers the singleton WebSocket
 * lifecycle (open, subscribe, message dispatch), per-sensor frame
 * listeners, frame callbacks, and connection status snapshot.
 *
 * The global WebSocket constructor is replaced with a fake that captures
 * sent messages and exposes triggers for open/message events.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useOnSensorFrame,
  useSensorFrame,
  useSensorStream,
  useSensorStreamStatus,
} from '../useSensorStream'

const sensorSingleton = (globalThis as any).__sleepypod_sensorStream

interface FakeWS {
  url: string
  readyState: number
  sent: string[]
  onopen?: () => void
  onmessage?: (e: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  send: (data: string) => void
  close: () => void
  triggerOpen: () => void
  triggerMessage: (msg: any) => void
  triggerClose: () => void
}

const wsMock = vi.hoisted(() => {
  const sockets: any[] = []
  return { sockets }
})

beforeAll(() => {
  ;(globalThis as any).WebSocket = class {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSED = 3
    url: string
    readyState = 0
    sent: string[] = []
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onclose?: () => void
    onerror?: () => void
    constructor(url: string) {
      this.url = url
      wsMock.sockets.push(this)
    }

    send(data: string) {
      this.sent.push(data)
    }

    close() {
      this.readyState = 3
      this.onclose?.()
    }

    triggerOpen() {
      this.readyState = 1
      this.onopen?.()
    }

    triggerMessage(msg: any) {
      this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) })
    }

    triggerClose() {
      this.readyState = 3
      this.onclose?.()
    }
  } as any
  // jsdom doesn't set window.location.hostname uniformly; ensure ws URL builds
  Object.defineProperty(window, 'location', {
    value: { protocol: 'http:', hostname: 'localhost' },
    writable: true,
  })
})

beforeEach(() => {
  // The module owns a process-wide singleton. Keep the global reference
  // available for white-box lifecycle assertions and reset registries that
  // should be empty between independently rendered hooks.
  ;(globalThis as any).__sleepypod_sensorStream = sensorSingleton
  sensorSingleton.activeSubscriptions.clear()
  sensorSingleton.sensorListeners.clear()
  sensorSingleton.frameCallbacks.clear()
  sensorSingleton.timeRangeResolvers.length = 0
  sensorSingleton.pendingSubscription = null
  sensorSingleton.activeRefCount = 0
  sensorSingleton.intentionalClose = false
  sensorSingleton.reconnectAttempt = 0
  delete process.env.NEXT_PUBLIC_PIEZO_WS_PORT
  Object.defineProperty(window, 'location', {
    value: { protocol: 'http:', hostname: 'localhost' },
    writable: true,
  })
  wsMock.sockets.length = 0
})

afterEach(() => {
  // Best-effort: clear any open sockets so reconnect timers don't fire
  for (const ws of wsMock.sockets) {
    try {
      ws.triggerClose()
    }
    catch { /* noop */ }
  }
})

describe('useSensorStream', () => {
  it('opens a WebSocket on mount and reports connecting status', async () => {
    const { result, unmount } = renderHook(() => useSensorStream({ sensors: ['capSense'] }))
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    expect(result.current.status).toBe('connecting')
    unmount()
  })

  it('transitions to connected on open and sends merged subscription', async () => {
    const { result, unmount } = renderHook(() => useSensorStream({ sensors: ['capSense'] }))
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    expect(result.current.status).toBe('connected')
    const sent = ws.sent.map(s => JSON.parse(s))
    expect(sent.some(m => m.type === 'subscribe' && m.sensors.includes('capSense'))).toBe(true)
    unmount()
  })

  it('does not open when enabled=false', () => {
    renderHook(() => useSensorStream({ enabled: false }))
    expect(wsMock.sockets.length).toBe(0)
  })

  it('updates latestFrames when a sensor message arrives', async () => {
    const { result, unmount } = renderHook(() => useSensorStream({ sensors: ['capSense'] }))
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage({ type: 'capSense', ts: 1, left: 100, right: 200 }))
    await waitFor(() => expect(result.current.latestFrames.capSense).toBeDefined())
    expect((result.current.latestFrames.capSense as any).type).toBe('capSense')
    unmount()
  })

  it('records lastError and ignores non-frame error messages', async () => {
    const { result, unmount } = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage({ type: 'error', message: 'bad subscribe' }))
    await waitFor(() => expect(result.current.lastError).toBe('bad subscribe'))
    unmount()
  })

  it('records subscribed sensors from server confirmation', async () => {
    const { result, unmount } = renderHook(() => useSensorStream({ sensors: ['capSense'] }))
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage({ type: 'subscribed', sensors: ['capSense', 'bedTemp'] }))
    await waitFor(() => expect(result.current.subscribedSensors).toEqual(['capSense', 'bedTemp']))
    unmount()
  })

  it('records timeRange and resolves pending getTimeRange promise', async () => {
    const { result, unmount } = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    let resolved: any
    const pending = result.current.getTimeRange().then((r) => {
      resolved = r
    })
    act(() => ws.triggerMessage({ type: 'time_range', min: 100, max: 200, file: null }))
    await pending
    expect(resolved).toEqual({ min: 100, max: 200 })
    expect(result.current.timeRange).toEqual({ min: 100, max: 200 })
    unmount()
  })

  it('time_range with min=max=0 reports null range', async () => {
    const { result, unmount } = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage({ type: 'time_range', min: 0, max: 0, file: null }))
    await waitFor(() => expect(result.current.timeRange).toBeNull())
    unmount()
  })

  it('seek_complete clears isSeeking', async () => {
    const { result, unmount } = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    act(() => result.current.seek(123))
    expect(result.current.isSeeking).toBe(true)
    const lastSent = ws.sent.map(s => JSON.parse(s)).find(m => m.type === 'seek')
    expect(lastSent).toEqual({ type: 'seek', timestamp: 123 })
    act(() => ws.triggerMessage({ type: 'seek_complete' }))
    await waitFor(() => expect(result.current.isSeeking).toBe(false))
    unmount()
  })

  it('seek and getTimeRange no-op safely when socket is not open', async () => {
    const { result } = renderHook(() => useSensorStream({ enabled: false }))
    // No socket created, but the seek/getTimeRange functions still work
    act(() => result.current.seek(456))
    const range = await result.current.getTimeRange()
    expect(range).toBeNull()
  })

  it('disconnects when last consumer unmounts', async () => {
    const hook = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    hook.unmount()
    expect(ws.readyState).toBe(3)
  })

  it('ignores non-JSON messages without crashing', async () => {
    const { result, unmount } = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage('not json'))
    expect(result.current.status).toBe('connected')
    unmount()
  })
})

describe('useSensorFrame', () => {
  it('returns the latest frame for a specific sensor only', async () => {
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    const frame = renderHook(() => useSensorFrame('capSense'))
    expect(frame.result.current).toBeUndefined()
    act(() => ws.triggerMessage({ type: 'capSense', ts: 1, left: 1, right: 2 }))
    await waitFor(() => expect(frame.result.current).toBeDefined())
    expect(frame.result.current?.type).toBe('capSense')
    frame.unmount()
    stream.unmount()
  })
})

describe('useSensorStreamStatus', () => {
  it('returns disconnected initially and connected after open', async () => {
    const status = renderHook(() => useSensorStreamStatus())
    expect(status.result.current).toBe('disconnected')
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    await waitFor(() => expect(status.result.current).toBe('connected'))
    stream.unmount()
    status.unmount()
  })
})

describe('useOnSensorFrame', () => {
  it('invokes the callback for every frame', async () => {
    const cb = vi.fn()
    const cbHook = renderHook(() => useOnSensorFrame(cb))
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage({ type: 'capSense', ts: 1, left: 1, right: 2 }))
    act(() => ws.triggerMessage({ type: 'capSense', ts: 2, left: 3, right: 4 }))
    expect(cb).toHaveBeenCalledTimes(2)
    cbHook.unmount()
    stream.unmount()
  })

  it('swallows callback errors', async () => {
    const cb = vi.fn(() => {
      throw new Error('callback boom')
    })
    const cbHook = renderHook(() => useOnSensorFrame(cb))
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    expect(() => act(() => ws.triggerMessage({ type: 'capSense', ts: 1, left: 1, right: 2 }))).not.toThrow()
    cbHook.unmount()
    stream.unmount()
  })
})

describe('useSensorStream — reconnect + error paths', () => {
  it('schedules a reconnect after an unexpected close and reports reconnecting status', async () => {
    vi.useFakeTimers()
    try {
      const { result, unmount } = renderHook(() => useSensorStream())
      // mount effect needs to run
      await vi.advanceTimersByTimeAsync(0)
      expect(wsMock.sockets.length).toBe(1)
      const ws = wsMock.sockets[0] as FakeWS
      act(() => ws.triggerOpen())
      expect(result.current.status).toBe('connected')

      // Server-side close (not intentional) → should mark reconnecting and queue a retry
      act(() => ws.triggerClose())
      expect(result.current.status).toBe('reconnecting')

      // Advance past the base reconnect delay (1s) so the timer fires and a fresh socket is created
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500)
      })
      expect(wsMock.sockets.length).toBe(2)
      unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('sets lastError when onerror fires', async () => {
    const { result, unmount } = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as any
    act(() => ws.triggerOpen())
    act(() => ws.onerror?.())
    expect(result.current.lastError).toBe('WebSocket connection error')
    unmount()
  })

  it('records lastError and schedules reconnect if WebSocket constructor throws', async () => {
    const originalWs = (globalThis as any).WebSocket
    function ThrowingWebSocket() {
      throw new Error('boom')
    }
    ThrowingWebSocket.OPEN = 1
    ThrowingWebSocket.CONNECTING = 0
    ThrowingWebSocket.CLOSED = 3
    ;(globalThis as any).WebSocket = ThrowingWebSocket

    vi.useFakeTimers()
    try {
      const { result, unmount } = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      expect(result.current.lastError).toBe('Failed to create WebSocket')
      // scheduleReconnect runs after the throw → status becomes reconnecting
      expect(result.current.status).toBe('reconnecting')
      unmount()
    }
    finally {
      vi.useRealTimers()
      ;(globalThis as any).WebSocket = originalWs
    }
  })

  it('getTimeRange resolves to null when the server never answers within 5s', async () => {
    vi.useFakeTimers()
    try {
      const { result, unmount } = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      const ws = wsMock.sockets[0] as FakeWS
      act(() => ws.triggerOpen())
      let resolved: any = 'pending'
      const promise = result.current.getTimeRange().then((r) => {
        resolved = r
      })
      // Advance past the 5s timeout
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000)
      })
      await promise
      expect(resolved).toBeNull()
      unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('computes fps once enough frames have been received within the rolling window', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0))
      const { result, unmount } = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      const ws = wsMock.sockets[0] as FakeWS
      act(() => ws.triggerOpen())

      // Three frames spaced 500ms apart → ~2 fps over 1s
      act(() => ws.triggerMessage({ type: 'capSense', ts: 1, left: 1, right: 2 }))
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0, 500))
      act(() => ws.triggerMessage({ type: 'capSense', ts: 2, left: 1, right: 2 }))
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 1, 0))
      act(() => ws.triggerMessage({ type: 'capSense', ts: 3, left: 1, right: 2 }))

      // Advance the fps timer (interval=500ms) so it picks up the new value
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(result.current.fps).toBeGreaterThan(0)
      unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('merges multiple hook subscriptions and sends the union', async () => {
    const a = renderHook(() => useSensorStream({ sensors: ['capSense'] }))
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    // After open, the merged subscription is sent (only the first hook so far)
    const b = renderHook(() => useSensorStream({ sensors: ['bedTemp'] }))
    // Allow the second hook's subscription effect to flush
    await waitFor(() => {
      const merged = ws.sent.map(s => JSON.parse(s)).filter(m => m.type === 'subscribe')
      const lastMerged = merged[merged.length - 1]
      expect(lastMerged.sensors).toEqual(expect.arrayContaining(['capSense', 'bedTemp']))
    })
    a.unmount()
    b.unmount()
  })

  it('when a hook subscribes to all sensors, the merged subscription is the wildcard (empty)', async () => {
    const a = renderHook(() => useSensorStream({ sensors: ['capSense'] }))
    await waitFor(() => expect(wsMock.sockets.length).toBeGreaterThan(0))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    const b = renderHook(() => useSensorStream({ sensors: null }))
    await waitFor(() => {
      const merged = ws.sent.map(s => JSON.parse(s)).filter(m => m.type === 'subscribe')
      const lastMerged = merged[merged.length - 1]
      // null = subscribe to all → server payload is empty array
      expect(lastMerged.sensors).toEqual([])
    })
    a.unmount()
    b.unmount()
  })

  it('clears the pending reconnect timer if all consumers unmount before it fires', async () => {
    vi.useFakeTimers()
    try {
      const { unmount } = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      const ws = wsMock.sockets[0] as FakeWS
      act(() => ws.triggerOpen())
      act(() => ws.triggerClose()) // unexpected close → schedules reconnect
      const beforeCount = wsMock.sockets.length
      unmount()
      // Even after advancing past the backoff, no new socket should appear
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(wsMock.sockets.length).toBe(beforeCount)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('useSensorFrame returns undefined initially (server snapshot)', () => {
    const { result, unmount } = renderHook(() => useSensorFrame('capSense'))
    expect(result.current).toBeUndefined()
    unmount()
  })

  it('useSensorStreamStatus reports disconnected without any active stream consumer', () => {
    const { result, unmount } = renderHook(() => useSensorStreamStatus())
    expect(result.current).toBe('disconnected')
    unmount()
  })
})

describe('useSensorStream — mutation boundaries and lifecycle contracts', () => {
  it('trims frame timestamps strictly older than the FPS window', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const stream = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      const ws = wsMock.sockets[0] as FakeWS
      act(() => ws.triggerOpen())
      act(() => ws.triggerMessage({ type: 'capSense', ts: 1, left: 1, right: 2 }))
      vi.setSystemTime(2_501)
      act(() => ws.triggerMessage({ type: 'capSense', ts: 2, left: 1, right: 2 }))
      expect(sensorSingleton.fpsTimestamps).toEqual([2_501])
      stream.unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('retains a frame exactly on the FPS cutoff boundary', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const stream = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      const ws = wsMock.sockets[0] as FakeWS
      act(() => ws.triggerOpen())
      act(() => ws.triggerMessage({ type: 'capSense', ts: 1, left: 1, right: 2 }))
      vi.setSystemTime(2_000)
      act(() => ws.triggerMessage({ type: 'capSense', ts: 2, left: 1, right: 2 }))
      expect(sensorSingleton.fpsTimestamps).toEqual([0, 2_000])
      stream.unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('computes exact FPS from two frames', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { result, unmount } = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      act(() => (wsMock.sockets[0] as FakeWS).triggerOpen())
      sensorSingleton.fpsTimestamps.push(400, 500)
      await act(async () => vi.advanceTimersByTimeAsync(500))
      expect(result.current.fps).toBe(10)
      unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('filters timestamps outside the FPS window', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { result, unmount } = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      act(() => (wsMock.sockets[0] as FakeWS).triggerOpen())
      sensorSingleton.fpsTimestamps.push(-2_500, 0, 500)
      await act(async () => vi.advanceTimersByTimeAsync(500))
      expect(result.current.fps).toBe(2)
      unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('includes timestamps exactly on the compute cutoff', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { result, unmount } = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      act(() => (wsMock.sockets[0] as FakeWS).triggerOpen())
      sensorSingleton.fpsTimestamps.push(-1_500, 400, 500)
      await act(async () => vi.advanceTimersByTimeAsync(500))
      expect(result.current.fps).toBe(1)
      unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('returns zero FPS when duplicate timestamps have no elapsed time', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { result, unmount } = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      act(() => (wsMock.sockets[0] as FakeWS).triggerOpen())
      sensorSingleton.fpsTimestamps.push(500, 500)
      await act(async () => vi.advanceTimersByTimeAsync(500))
      expect(result.current.fps).toBe(0)
      unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('uses frames-per-elapsed-second arithmetic', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const { result, unmount } = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      act(() => (wsMock.sockets[0] as FakeWS).triggerOpen())
      sensorSingleton.fpsTimestamps.push(0, 250, 500)
      await act(async () => vi.advanceTimersByTimeAsync(500))
      expect(result.current.fps).toBe(4)
      unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('does not publish a new snapshot when FPS is unchanged', async () => {
    vi.useFakeTimers()
    try {
      let renders = 0
      const { unmount } = renderHook(() => {
        renders++
        return useSensorStream()
      })
      await vi.advanceTimersByTimeAsync(0)
      act(() => (wsMock.sockets[0] as FakeWS).triggerOpen())
      const rendersBeforeTick = renders
      await act(async () => vi.advanceTimersByTimeAsync(500))
      expect(renders).toBe(rendersBeforeTick)
      unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('stops the FPS timer and clears samples on disconnect', async () => {
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage({ type: 'capSense', ts: 1, left: 1, right: 2 }))
    expect(sensorSingleton.fpsTimestamps).toHaveLength(1)
    stream.unmount()
    expect(sensorSingleton.fpsUpdateTimer).toBeNull()
    expect(sensorSingleton.fpsTimestamps).toEqual([])
  })

  it('removes the main-store listener on unmount', () => {
    const listenersBefore = sensorSingleton.listeners.size
    const stream = renderHook(() => useSensorStream({ enabled: false }))
    expect(sensorSingleton.listeners.size).toBeGreaterThan(listenersBefore)
    stream.unmount()
    expect(sensorSingleton.listeners.size).toBe(listenersBefore)
  })

  it('uses the default WebSocket URL and port', async () => {
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    expect((wsMock.sockets[0] as FakeWS).url).toBe('ws://localhost:3001')
    stream.unmount()
  })

  it('uses a configured WebSocket port', async () => {
    process.env.NEXT_PUBLIC_PIEZO_WS_PORT = '4444'
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    expect((wsMock.sockets[0] as FakeWS).url).toBe('ws://localhost:4444')
    stream.unmount()
  })

  it('uses wss on an HTTPS page', async () => {
    Object.defineProperty(window, 'location', {
      value: { protocol: 'https:', hostname: 'pod.local' },
      writable: true,
    })
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    expect((wsMock.sockets[0] as FakeWS).url).toBe('wss://pod.local:3001')
    stream.unmount()
  })

  it('does not reconnect when a close arrives with no active consumers', async () => {
    vi.useFakeTimers()
    try {
      const { result, unmount } = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      const ws = wsMock.sockets[0] as FakeWS
      act(() => ws.triggerOpen())
      sensorSingleton.activeRefCount = 0
      sensorSingleton.intentionalClose = false
      act(() => ws.triggerClose())
      expect(result.current.status).toBe('connected')
      expect(sensorSingleton.reconnectTimeout).toBeNull()
      sensorSingleton.activeRefCount = 1
      unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('doubles the reconnect delay after each failed attempt', async () => {
    vi.useFakeTimers()
    try {
      const stream = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      act(() => (wsMock.sockets[0] as FakeWS).triggerClose())
      await act(async () => vi.advanceTimersByTimeAsync(1_000))
      expect(wsMock.sockets).toHaveLength(2)
      act(() => (wsMock.sockets[1] as FakeWS).triggerClose())
      await act(async () => vi.advanceTimersByTimeAsync(1_999))
      expect(wsMock.sockets).toHaveLength(2)
      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(wsMock.sockets).toHaveLength(3)
      stream.unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it.each([0, 1])('does not replace an existing readyState=%s socket on reconnect', async (readyState) => {
    vi.useFakeTimers()
    try {
      const stream = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      act(() => (wsMock.sockets[0] as FakeWS).triggerClose())
      sensorSingleton.ws = { readyState }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(wsMock.sockets).toHaveLength(1)
      sensorSingleton.ws = null
      stream.unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('preserves intentional-close state after disconnect', async () => {
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    stream.unmount()
    expect(sensorSingleton.intentionalClose).toBe(true)
  })

  it('resets seeking state on disconnect', async () => {
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    act(() => (wsMock.sockets[0] as FakeWS).triggerOpen())
    act(() => stream.result.current.seek(123))
    expect(stream.result.current.isSeeking).toBe(true)
    stream.unmount()
    const snapshot = renderHook(() => useSensorStream({ enabled: false }))
    expect(snapshot.result.current.isSeeking).toBe(false)
    snapshot.unmount()
  })

  it('deduplicates identical sensors across subscriptions', async () => {
    const a = renderHook(() => useSensorStream({ sensors: ['capSense'] }))
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    const b = renderHook(() => useSensorStream({ sensors: ['capSense'] }))
    await waitFor(() => {
      const subscriptions = ws.sent.map(s => JSON.parse(s)).filter(m => m.type === 'subscribe')
      expect(subscriptions.at(-1)?.sensors).toEqual(['capSense'])
    })
    a.unmount()
    b.unmount()
  })

  it('records an empty pending subscription when the final subscriber leaves', async () => {
    const stream = renderHook(() => useSensorStream({ sensors: ['capSense'] }))
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    stream.unmount()
    expect(sensorSingleton.pendingSubscription).toEqual([])
  })

  it('sends the exact get_time_range request', async () => {
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    void stream.result.current.getTimeRange()
    expect(ws.sent.map(s => JSON.parse(s))).toContainEqual({ type: 'get_time_range' })
    stream.unmount()
  })

  it('times out two concurrent time-range requests', async () => {
    vi.useFakeTimers()
    try {
      const stream = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      act(() => (wsMock.sockets[0] as FakeWS).triggerOpen())
      let first: any = 'pending'
      let second: any = 'pending'
      void stream.result.current.getTimeRange().then(value => first = value)
      void stream.result.current.getTimeRange().then(value => second = value)
      await vi.advanceTimersByTimeAsync(5_000)
      await Promise.resolve()
      expect(first).toBeNull()
      expect(second).toBeNull()
      stream.unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('does not let a completed request timeout remove a later time-range resolver', async () => {
    vi.useFakeTimers()
    try {
      const stream = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      const ws = wsMock.sockets[0] as FakeWS
      act(() => ws.triggerOpen())

      void stream.result.current.getTimeRange()
      act(() => ws.triggerMessage({ type: 'time_range', min: 100, max: 200 }))

      await vi.advanceTimersByTimeAsync(1_000)
      let later: any = 'pending'
      void stream.result.current.getTimeRange().then(value => later = value)

      // The first request's timer fires now. It must leave the later resolver intact.
      await vi.advanceTimersByTimeAsync(4_000)
      act(() => ws.triggerMessage({ type: 'time_range', min: 300, max: 400 }))
      await Promise.resolve()

      expect(later).toEqual({ min: 300, max: 400 })
      stream.unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('keeps a range when exactly one endpoint is zero', async () => {
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage({ type: 'time_range', min: 0, max: 200 }))
    expect(stream.result.current.timeRange).toEqual({ min: 0, max: 200 })
    act(() => ws.triggerMessage({ type: 'time_range', min: 100, max: 0 }))
    expect(stream.result.current.timeRange).toEqual({ min: 100, max: 0 })
    stream.unmount()
  })

  it('does not rerun the subscription effect when sensor order alone changes', async () => {
    const { rerender, unmount } = renderHook(
      ({ sensors }) => useSensorStream({ sensors }),
      { initialProps: { sensors: ['capSense', 'bedTemp'] as any } },
    )
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    const sendsBefore = ws.sent.length
    rerender({ sensors: ['bedTemp', 'capSense'] as any })
    expect(ws.sent).toHaveLength(sendsBefore)
    unmount()
  })

  it('distinguishes wildcard and empty subscriptions', async () => {
    const { rerender, unmount } = renderHook(
      ({ sensors }) => useSensorStream({ sensors }),
      { initialProps: { sensors: null as any } },
    )
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    expect(sensorSingleton.pendingSubscription).toBeNull()
    rerender({ sensors: [] as any })
    expect(sensorSingleton.pendingSubscription).toEqual([])
    unmount()
  })

  it('does not connect a second consumer before the scheduled reconnect', async () => {
    vi.useFakeTimers()
    try {
      const first = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      act(() => (wsMock.sockets[0] as FakeWS).triggerClose())
      const second = renderHook(() => useSensorStream())
      await vi.advanceTimersByTimeAsync(0)
      expect(wsMock.sockets).toHaveLength(1)
      second.unmount()
      first.unmount()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('keeps the shared socket open until the last enabled consumer unmounts', async () => {
    const first = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    const second = renderHook(() => useSensorStream())
    first.unmount()
    expect(ws.readyState).toBe(1)
    second.unmount()
    expect(ws.readyState).toBe(3)
  })

  it('disconnects when enabled changes from true to false', async () => {
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useSensorStream({ enabled }),
      { initialProps: { enabled: true } },
    )
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    rerender({ enabled: false })
    expect(ws.readyState).toBe(3)
    unmount()
  })

  it('does not register a disabled subscription', () => {
    const stream = renderHook(() => useSensorStream({ sensors: ['capSense'], enabled: false }))
    expect(sensorSingleton.activeSubscriptions.size).toBe(0)
    stream.unmount()
  })

  it('sends updated sensors after rerender', async () => {
    const { rerender, unmount } = renderHook(
      ({ sensors }) => useSensorStream({ sensors }),
      { initialProps: { sensors: ['capSense'] as any } },
    )
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    rerender({ sensors: ['bedTemp'] as any })
    const subscriptions = ws.sent.map(s => JSON.parse(s)).filter(m => m.type === 'subscribe')
    expect(subscriptions.at(-1)?.sensors).toEqual(['bedTemp'])
    unmount()
  })
})

describe('useSensorFrame — listener lifecycle and dependencies', () => {
  it('keeps both per-sensor listeners when two consumers use the same type', () => {
    const first = renderHook(() => useSensorFrame('capSense'))
    const second = renderHook(() => useSensorFrame('capSense'))
    expect(sensorSingleton.sensorListeners.get('capSense')?.size).toBe(2)
    first.unmount()
    second.unmount()
  })

  it('creates the per-sensor listener set for the first consumer', () => {
    const frame = renderHook(() => useSensorFrame('capSense'))
    expect(sensorSingleton.sensorListeners.has('capSense')).toBe(true)
    expect(sensorSingleton.sensorListeners.get('capSense')?.size).toBe(1)
    frame.unmount()
  })

  it('removes both main and per-sensor listeners on unmount', () => {
    const listenersBefore = sensorSingleton.listeners.size
    const frame = renderHook(() => useSensorFrame('capSense'))
    frame.unmount()
    expect(sensorSingleton.listeners.size).toBe(listenersBefore)
    expect(sensorSingleton.sensorListeners.get('capSense')?.size ?? 0).toBe(0)
  })

  it('resubscribes and reads the new sensor type after rerender', async () => {
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    const frame = renderHook(
      ({ sensor }) => useSensorFrame(sensor),
      { initialProps: { sensor: 'capSense' as any } },
    )
    frame.rerender({ sensor: 'bedTemp' as any })
    expect(sensorSingleton.sensorListeners.get('capSense')?.size ?? 0).toBe(0)
    expect(sensorSingleton.sensorListeners.get('bedTemp')?.size).toBe(1)
    act(() => ws.triggerMessage({ type: 'bedTemp', ts: 1 }))
    expect(frame.result.current?.type).toBe('bedTemp')
    frame.unmount()
    stream.unmount()
  })
})

describe('useOnSensorFrame — callback updates and cleanup', () => {
  it('uses the latest callback after rerender', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const callback = renderHook(
      ({ cb }) => useOnSensorFrame(cb),
      { initialProps: { cb: first } },
    )
    callback.rerender({ cb: second })
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage({ type: 'capSense', ts: 1, left: 1, right: 2 }))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    callback.unmount()
    stream.unmount()
  })

  it('does not invoke a callback after its hook unmounts', async () => {
    const cb = vi.fn()
    const callback = renderHook(() => useOnSensorFrame(cb))
    callback.unmount()
    const stream = renderHook(() => useSensorStream())
    await waitFor(() => expect(wsMock.sockets.length).toBe(1))
    const ws = wsMock.sockets[0] as FakeWS
    act(() => ws.triggerOpen())
    act(() => ws.triggerMessage({ type: 'capSense', ts: 1, left: 1, right: 2 }))
    expect(cb).not.toHaveBeenCalled()
    stream.unmount()
  })
})

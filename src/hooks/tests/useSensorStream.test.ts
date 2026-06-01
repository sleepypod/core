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
  // Reset singleton between tests
  delete (globalThis as any).__sleepypod_sensorStream
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

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

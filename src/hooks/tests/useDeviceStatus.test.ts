/**
 * Tests for useDeviceStatus — merges WebSocket-pushed deviceStatus frames
 * with a tRPC HTTP fallback. WS is preferred only while it is actually
 * delivering fresh frames on a connected socket; when the stream dies or
 * stalls, HTTP polling resumes at the fast cadence (regression: an earlier
 * version latched HTTP off after the first frame and froze the UI forever).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sensorMock = vi.hoisted(() => {
  const state: { frame: any, status: string } = { frame: undefined, status: 'connected' }
  return {
    state,
    useSensorStream: vi.fn(),
    useSensorFrame: vi.fn(() => state.frame),
    useSensorStreamStatus: vi.fn(() => state.status),
  }
})

const trpcMock = vi.hoisted(() => {
  const state: { http: any, isLoading: boolean } = { http: undefined, isLoading: false }
  const refetch = vi.fn(() => Promise.resolve('refetched'))
  return {
    state,
    refetch,
    trpc: {
      device: {
        getStatus: {
          useQuery: vi.fn((...args: [unknown, { refetchInterval?: number | false, staleTime?: number }?]) => {
            void args
            return {
              data: state.http,
              isLoading: state.isLoading,
              refetch,
            }
          }),
        },
      },
    },
  }
})

vi.mock('../useSensorStream', () => ({
  useSensorStream: sensorMock.useSensorStream,
  useSensorFrame: sensorMock.useSensorFrame,
  useSensorStreamStatus: sensorMock.useSensorStreamStatus,
}))

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))

import { useDeviceStatus } from '../useDeviceStatus'

beforeEach(() => {
  sensorMock.state.frame = undefined
  sensorMock.state.status = 'connected'
  trpcMock.state.http = undefined
  trpcMock.state.isLoading = false
  trpcMock.trpc.device.getStatus.useQuery.mockClear()
})

afterEach(() => {
  sensorMock.useSensorStream.mockClear()
  sensorMock.useSensorFrame.mockClear()
  trpcMock.refetch.mockClear()
})

const wsFrame = {
  type: 'deviceStatus' as const,
  ts: 1,
  leftSide: { currentTemperature: 20, targetTemperature: 22, currentLevel: 5, targetLevel: 6, isAlarmVibrating: false },
  rightSide: { currentTemperature: 21, targetTemperature: 22, currentLevel: 4, targetLevel: 5, isAlarmVibrating: false },
  waterLevel: 'ok' as const,
  isPriming: false,
  snooze: { left: null, right: null },
}

describe('useDeviceStatus', () => {
  it('opens a WebSocket subscription scoped to deviceStatus', () => {
    renderHook(() => useDeviceStatus())
    expect(sensorMock.useSensorStream).toHaveBeenCalledWith({ sensors: ['deviceStatus'], enabled: true })
  })

  it('returns HTTP status when no WS frame has arrived', () => {
    trpcMock.state.http = { fromHttp: true }
    const { result } = renderHook(() => useDeviceStatus())
    expect(result.current.status).toEqual({ fromHttp: true })
    expect(result.current.isStreaming).toBe(false)
  })

  it('reports loading from HTTP only until first WS frame', () => {
    trpcMock.state.isLoading = true
    const { result } = renderHook(() => useDeviceStatus())
    expect(result.current.isLoading).toBe(true)
  })

  it('returns merged WS frame data once received and reports streaming', () => {
    sensorMock.state.frame = wsFrame
    const { result } = renderHook(() => useDeviceStatus())
    expect(result.current.isStreaming).toBe(true)
    expect(result.current.status?.leftSide.currentTemperature).toBe(20)
    expect(result.current.status?.waterLevel).toBe('ok')
    expect(result.current.status?.isPriming).toBe(false)
  })

  it('normalizes primeCompletedNotification.timestamp to a Date for numeric input', () => {
    sensorMock.state.frame = { ...wsFrame, primeCompletedNotification: { timestamp: 1_700_000_000_000 } }
    const { result } = renderHook(() => useDeviceStatus())
    const ts = result.current.status?.primeCompletedNotification?.timestamp
    expect(ts).toBeInstanceOf(Date)
    expect((ts as Date).getTime()).toBe(1_700_000_000_000)
  })

  it('passes through an existing Date timestamp untouched', () => {
    const date = new Date('2026-01-01T00:00:00Z')
    sensorMock.state.frame = { ...wsFrame, primeCompletedNotification: { timestamp: date } }
    const { result } = renderHook(() => useDeviceStatus())
    expect(result.current.status?.primeCompletedNotification?.timestamp).toBe(date)
  })

  it('refetch invokes the underlying tRPC refetch', async () => {
    const { result } = renderHook(() => useDeviceStatus())
    await result.current.refetch()
    expect(trpcMock.refetch).toHaveBeenCalled()
  })

  it('keeps fast HTTP polling before any WS frame arrives', () => {
    renderHook(() => useDeviceStatus())
    const opts = trpcMock.trpc.device.getStatus.useQuery.mock.calls.at(-1)?.[1]
    expect(opts?.refetchInterval).toBe(7_000)
  })

  it('idles HTTP polling (but never disables it) while WS is live', () => {
    sensorMock.state.frame = wsFrame
    renderHook(() => useDeviceStatus())
    const opts = trpcMock.trpc.device.getStatus.useQuery.mock.calls.at(-1)?.[1]
    expect(opts?.refetchInterval).toBe(60_000)
    expect(opts?.refetchInterval).not.toBe(false)
  })

  it('falls back to HTTP status and fast polling when the WS disconnects after frames were received', () => {
    // Regression: the old sticky latch kept preferring the dead WS forever.
    sensorMock.state.frame = wsFrame
    trpcMock.state.http = { fromHttp: true }
    const { result, rerender } = renderHook(() => useDeviceStatus())
    expect(result.current.isStreaming).toBe(true)

    sensorMock.state.status = 'reconnecting'
    rerender()

    expect(result.current.isStreaming).toBe(false)
    expect(result.current.status).toEqual({ fromHttp: true })
    const opts = trpcMock.trpc.device.getStatus.useQuery.mock.calls.at(-1)?.[1]
    expect(opts?.refetchInterval).toBe(7_000)
  })

  it('treats a silently stalled stream (connected but no frames for 15s) as not live', () => {
    vi.useFakeTimers()
    try {
      sensorMock.state.frame = wsFrame
      trpcMock.state.http = { fromHttp: true }
      const { result, rerender } = renderHook(() => useDeviceStatus())
      expect(result.current.isStreaming).toBe(true)

      // Socket stays 'connected' but no new frame arrives for > WS_FRESH_MS
      vi.advanceTimersByTime(20_000)
      rerender()

      expect(result.current.isStreaming).toBe(false)
      expect(result.current.status).toEqual({ fromHttp: true })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('serves the last WS frame while disconnected if HTTP has no data yet', () => {
    sensorMock.state.frame = wsFrame
    sensorMock.state.status = 'disconnected'
    const { result } = renderHook(() => useDeviceStatus())
    expect(result.current.isStreaming).toBe(false)
    expect(result.current.status?.leftSide.currentTemperature).toBe(20)
  })
})

/**
 * Tests for useDeviceStatus — merges WebSocket-pushed deviceStatus frames
 * with a tRPC HTTP fallback. WS becomes "sticky" once a frame arrives:
 * subsequent transient WS gaps must not revert to HTTP polling.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sensorMock = vi.hoisted(() => {
  const state: { frame: any } = { frame: undefined }
  return {
    state,
    useSensorStream: vi.fn(),
    useSensorFrame: vi.fn(() => state.frame),
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
          useQuery: vi.fn(() => ({
            data: state.http,
            isLoading: state.isLoading,
            refetch,
          })),
        },
      },
    },
  }
})

vi.mock('../useSensorStream', () => ({
  useSensorStream: sensorMock.useSensorStream,
  useSensorFrame: sensorMock.useSensorFrame,
}))

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))

import { useDeviceStatus } from '../useDeviceStatus'

beforeEach(() => {
  sensorMock.state.frame = undefined
  trpcMock.state.http = undefined
  trpcMock.state.isLoading = false
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
})

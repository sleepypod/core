'use client'

import { useCallback, useRef } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSensorStream, useSensorFrame } from './useSensorStream'
import type { DeviceStatusFrame } from './useSensorStream'

/**
 * Device status via WebSocket with tRPC HTTP fallback.
 *
 * Primary: `deviceStatus` frames pushed by dacMonitor every ~2s over the
 * existing piezoStream WebSocket (port 3001).
 *
 * Fallback: `device.getStatus` tRPC query for initial load and when WS
 * is disconnected.
 */
export function useDeviceStatus() {
  // Start WS connection (ref-counted). Don't destructure — the full snapshot
  // changes on every frame which would cause unnecessary re-renders.
  useSensorStream({ sensors: ['deviceStatus'], enabled: true })

  // This only re-renders when a deviceStatus frame arrives (per-sensor listener)
  const wsFrame = useSensorFrame('deviceStatus') as DeviceStatusFrame | undefined

  // Once we've received a WS frame, stop HTTP polling. Use a ref so the
  // value is sticky (doesn't flip back to false between frames).
  const hasReceivedWs = useRef(false)
  if (wsFrame != null) hasReceivedWs.current = true

  // HTTP fallback — poll only until the first WS frame arrives
  const { data: httpStatus, isLoading, refetch } = trpc.device.getStatus.useQuery(
    {},
    {
      refetchInterval: hasReceivedWs.current ? false : 7_000,
      staleTime: 3_000,
    },
  )

  // Normalize primeCompletedNotification.timestamp to Date for both transports
  const normalizePrimeTimestamp = (ts: unknown): Date => {
    if (ts instanceof Date) return ts
    if (typeof ts === 'number') return new Date(ts)
    if (typeof ts === 'string') return new Date(ts)
    return new Date()
  }

  // Merge: prefer WS frame (fresher, ~2s cadence) over HTTP
  const status = hasReceivedWs.current && wsFrame
    ? {
        leftSide: wsFrame.leftSide,
        rightSide: wsFrame.rightSide,
        waterLevel: wsFrame.waterLevel,
        isPriming: wsFrame.isPriming,
        primeCompletedNotification: wsFrame.primeCompletedNotification
          ? { timestamp: normalizePrimeTimestamp(wsFrame.primeCompletedNotification.timestamp) }
          : undefined,
        snooze: wsFrame.snooze,
      }
    : httpStatus

  const refetchStatus = useCallback(() => {
    // Force an HTTP refetch (useful after mutations)
    return refetch()
  }, [refetch])

  return {
    status,
    isLoading: !hasReceivedWs.current && isLoading,
    refetch: refetchStatus,
    /** Whether device status is being received via WebSocket */
    isStreaming: hasReceivedWs.current,
  }
}

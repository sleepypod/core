'use client'

import { useCallback } from 'react'
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
 *
 * The WS frame shape matches the tRPC getStatus response so consumers
 * can use either transparently.
 */
export function useDeviceStatus() {
  // Ensure the WS stream is connected (ref-counted — safe if other hooks also connect)
  const { lastFrameTime } = useSensorStream({ sensors: ['deviceStatus'], enabled: true })

  const wsFrame = useSensorFrame('deviceStatus') as DeviceStatusFrame | undefined

  // Use the presence of a WS frame as the freshness signal.
  // lastFrameTime is set via setState so it's stable between renders (no Date.now() in render).
  const hasWsData = wsFrame != null && lastFrameTime != null

  // HTTP fallback — poll when WS hasn't delivered any frames
  const { data: httpStatus, isLoading, refetch } = trpc.device.getStatus.useQuery(
    {},
    {
      refetchInterval: hasWsData ? false : 7_000,
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
  const status = hasWsData && wsFrame
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
    isLoading: !hasWsData && isLoading,
    refetch: refetchStatus,
    /** Whether device status is being received via WebSocket */
    isStreaming: hasWsData,
  }
}

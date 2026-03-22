'use client'

import { useCallback } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSensorStream, useSensorFrame } from './useSensorStream'
import type { DeviceStatusFrame } from './useSensorStream'

/** If no WS frame arrives within this window, fall back to HTTP polling. */
const WS_STALE_MS = 10_000

/**
 * Device status via WebSocket with tRPC HTTP fallback.
 *
 * Primary: `deviceStatus` frames pushed by dacMonitor every ~2s over the
 * existing piezoStream WebSocket (port 3001).
 *
 * Fallback: `device.getStatus` tRPC query for initial load and when WS
 * is disconnected. Polling resumes if WS frames stop arriving for 10s.
 *
 * The WS frame shape matches the tRPC getStatus response so consumers
 * can use either transparently.
 */
export function useDeviceStatus() {
  // Ensure the WS stream is connected (ref-counted — safe if other hooks also connect)
  useSensorStream({ sensors: ['deviceStatus'], enabled: true })

  const wsFrame = useSensorFrame('deviceStatus') as DeviceStatusFrame | undefined

  // Determine whether WS data is fresh (received within the stale window).
  // If WS disconnects or stops sending, this becomes false and HTTP polling resumes.
  const wsIsFresh = wsFrame != null && (Date.now() - wsFrame.ts) < WS_STALE_MS

  // HTTP fallback — poll when WS hasn't delivered recently
  const { data: httpStatus, isLoading, refetch } = trpc.device.getStatus.useQuery(
    {},
    {
      refetchInterval: wsIsFresh ? false : 7_000,
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
  const status = wsIsFresh && wsFrame
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
    isLoading: !wsIsFresh && isLoading,
    refetch: refetchStatus,
    /** Whether device status is being received via WebSocket */
    isStreaming: wsIsFresh,
  }
}

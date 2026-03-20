'use client'

import { useCallback, useRef } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSensorFrame } from './useSensorStream'
import type { DeviceStatusFrame } from './useSensorStream'

/**
 * Device status via WebSocket with tRPC HTTP fallback.
 *
 * Primary: `deviceStatus` frames pushed by dacMonitor every ~2s over the
 * existing piezoStream WebSocket (port 3001).
 *
 * Fallback: `device.getStatus` tRPC query for initial load and when WS
 * is disconnected. Polling is disabled once WS frames arrive.
 *
 * The WS frame shape matches the tRPC getStatus response so consumers
 * can use either transparently.
 */
export function useDeviceStatus() {
  const wsFrame = useSensorFrame('deviceStatus') as DeviceStatusFrame | undefined
  const hasReceivedWsRef = useRef(false)

  if (wsFrame) hasReceivedWsRef.current = true

  // HTTP fallback — poll only when WS hasn't delivered yet
  const { data: httpStatus, isLoading, refetch } = trpc.device.getStatus.useQuery(
    {},
    {
      refetchInterval: hasReceivedWsRef.current ? false : 7_000,
      staleTime: 3_000,
    },
  )

  // Merge: prefer WS frame (fresher, ~2s cadence) over HTTP
  const status = wsFrame
    ? {
        leftSide: wsFrame.leftSide,
        rightSide: wsFrame.rightSide,
        waterLevel: wsFrame.waterLevel,
        isPriming: wsFrame.isPriming,
        primeCompletedNotification: wsFrame.primeCompletedNotification
          ? { timestamp: new Date(wsFrame.primeCompletedNotification.timestamp) }
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
    isLoading: !wsFrame && isLoading,
    refetch: refetchStatus,
    /** Whether device status is being received via WebSocket */
    isStreaming: hasReceivedWsRef.current,
  }
}

'use client'

import { useCallback, useRef } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSensorStream, useSensorFrame, useSensorStreamStatus } from './useSensorStream'
import type { DeviceStatusFrame } from './useSensorStream'

/** A WS frame older than this is stale — the stream has silently stalled. */
const WS_FRESH_MS = 15_000
/** HTTP poll cadence while the WS stream is not delivering. */
const HTTP_POLL_MS = 7_000
/** Idle HTTP cadence while WS is live — kept alive (not disabled) so each
 * poll re-renders the hook and re-evaluates WS freshness. A WS that dies
 * without a close event re-enables the fast cadence within one idle cycle. */
const HTTP_IDLE_POLL_MS = 60_000

/**
 * Device status via WebSocket with tRPC HTTP fallback.
 *
 * Primary: `deviceStatus` frames pushed by dacMonitor on its adaptive poll
 * (1–5s), plus immediate mutation overlays, over the existing piezoStream
 * WebSocket (port 3001).
 *
 * Fallback: `device.getStatus` tRPC query for initial load and whenever the
 * WS stream is disconnected or has stopped delivering frames. (An earlier
 * version latched off HTTP polling permanently after the first WS frame; a
 * dying WS server then froze temps/pump-stall/alarm/water-level forever.)
 */
export function useDeviceStatus() {
  // Start WS connection (ref-counted). Don't destructure — the full snapshot
  // changes on every frame which would cause unnecessary re-renders.
  useSensorStream({ sensors: ['deviceStatus'], enabled: true })

  // This only re-renders when a deviceStatus frame arrives (per-sensor listener)
  const wsFrame = useSensorFrame('deviceStatus') as DeviceStatusFrame | undefined
  // Re-renders on connection state changes (disconnected/reconnecting/...)
  const wsStatus = useSensorStreamStatus()

  // Track when the last deviceStatus frame arrived (client clock). Frame
  // identity comparison in render is safe: new frames re-render this hook
  // via the per-sensor listener. Date.now() impurity is intentional: the
  // freshness check re-evaluates on every render, and renders are driven by
  // frames, status changes, and the idle HTTP poll.
  /* eslint-disable react-hooks/refs, react-hooks/purity */
  const lastWsFrameAt = useRef<number | null>(null)
  const prevWsFrame = useRef<DeviceStatusFrame | undefined>(undefined)
  if (wsFrame != null && wsFrame !== prevWsFrame.current) {
    prevWsFrame.current = wsFrame
    lastWsFrameAt.current = Date.now()
  }

  // Trust WS only while connected AND actually delivering recent frames —
  // a half-open socket keeps status 'connected' but stops producing.
  const wsLive = wsStatus === 'connected'
    && lastWsFrameAt.current !== null
    && Date.now() - lastWsFrameAt.current < WS_FRESH_MS

  const { data: httpStatus, isLoading, refetch } = trpc.device.getStatus.useQuery(
    {},
    {
      refetchInterval: wsLive ? HTTP_IDLE_POLL_MS : HTTP_POLL_MS,
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

  const wsToStatus = (frame: DeviceStatusFrame) => ({
    leftSide: frame.leftSide,
    rightSide: frame.rightSide,
    waterLevel: frame.waterLevel,
    isPriming: frame.isPriming,
    primeCompletedNotification: frame.primeCompletedNotification
      ? { timestamp: normalizePrimeTimestamp(frame.primeCompletedNotification.timestamp) }
      : undefined,
    pumpStallNotifications: frame.pumpStallNotifications,
    snooze: frame.snooze,
  })

  // Prefer the live WS frame; otherwise HTTP. A stale WS frame is better
  // than nothing while the HTTP fallback is still loading.
  const status = wsLive && wsFrame
    ? wsToStatus(wsFrame)
    : httpStatus ?? (wsFrame ? wsToStatus(wsFrame) : undefined)

  const refetchStatus = useCallback(() => {
    // Force an HTTP refetch (useful after mutations)
    return refetch()
  }, [refetch])

  return {
    status,
    isLoading: wsFrame == null && isLoading,
    refetch: refetchStatus,
    /** Whether device status is being received live via WebSocket */
    isStreaming: wsLive,
  }
  /* eslint-enable react-hooks/refs, react-hooks/purity */
}

'use client'

import { useEffect, useState } from 'react'
import { type ConnectionStatus } from '@/src/hooks/useSensorStream'
import { Loader2 } from 'lucide-react'

interface ConnectionStatusBarProps {
  status: ConnectionStatus
  fps: number
  lastError: string | null
  subscribedSensors: string[] | null
  lastFrameTime: number | null
}

const STATUS_CONFIG: Record<ConnectionStatus, {
  label: string
  color: string
  bg: string
  dotColor: string
  borderColor: string
}> = {
  connected: {
    label: 'Live',
    color: 'text-emerald-400',
    bg: 'bg-[#0a0a14]',
    dotColor: 'bg-emerald-400',
    borderColor: 'border-emerald-400/20',
  },
  connecting: {
    label: 'Connecting',
    color: 'text-amber-400',
    bg: 'bg-[#0a0a14]',
    dotColor: 'bg-amber-400',
    borderColor: 'border-amber-400/20',
  },
  reconnecting: {
    label: 'Reconnecting',
    color: 'text-amber-400',
    bg: 'bg-[#0a0a14]',
    dotColor: 'bg-amber-400',
    borderColor: 'border-amber-400/20',
  },
  disconnected: {
    label: 'Disconnected',
    color: 'text-red-400',
    bg: 'bg-[#0a0a14]',
    dotColor: 'bg-red-400',
    borderColor: 'border-red-400/20',
  },
}

/** Format relative time ago string. */
function useRelativeTime(timestamp: number | null): string {
  const [text, setText] = useState('')

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!timestamp) {
      setText('')
      return
    }

    function update() {
      const diff = Math.floor((Date.now() - (timestamp ?? 0)) / 1000)
      if (diff < 2) setText('just now')
      else if (diff < 60) setText(`${diff}s ago`)
      else setText(`${Math.floor(diff / 60)}m ago`)
    }

    update()
    /* eslint-enable react-hooks/set-state-in-effect */
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [timestamp])

  return text
}

/**
 * Connection status indicator bar matching iOS BedSensorScreen connectionBar.
 * Shows live pulse dot, status label, FPS counter, and relative time.
 */
export function ConnectionStatusBar({
  status,
  fps,
  lastError,
  subscribedSensors,
  lastFrameTime,
}: ConnectionStatusBarProps) {
  const config = STATUS_CONFIG[status]
  const isConnected = status === 'connected'
  const isLoading = status === 'connecting' || status === 'reconnecting'
  const relativeTime = useRelativeTime(lastFrameTime)

  return (
    <div className={`flex items-center justify-between rounded-xl border ${config.borderColor} ${config.bg} px-3 py-2`}>
      <div className="flex items-center gap-2">
        {/* Live pulse dot */}
        {isLoading
          ? (
              <Loader2 size={12} className={`animate-spin ${config.color}`} />
            )
          : (
              <span className="relative flex h-[7px] w-[7px]">
                {isConnected && (
                  <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${config.dotColor} opacity-60`} />
                )}
                <span className={`relative inline-flex h-[7px] w-[7px] rounded-full ${config.dotColor}`} />
              </span>
            )}

        {/* Status label */}
        <span className={`text-xs font-semibold ${config.color}`}>
          {lastError && !isConnected ? lastError : config.label}
        </span>
      </div>

      <div className="flex items-center gap-3">
        {/* Subscribed sensor count */}
        {subscribedSensors && (
          <span className="text-[9px] text-zinc-600">
            {subscribedSensors.length}
            {' '}
            sensors
          </span>
        )}

        {/* FPS counter */}
        {isConnected && fps > 0 && (
          <span className="font-mono text-[9px] text-zinc-500">
            {fps}
            {' '}
            fps
          </span>
        )}

        {/* Relative time since last frame */}
        {relativeTime && (
          <span className="text-[9px] text-zinc-600">
            {relativeTime}
          </span>
        )}
      </div>
    </div>
  )
}

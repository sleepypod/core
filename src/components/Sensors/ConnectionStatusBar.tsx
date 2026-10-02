'use client'

import { useEffect, useState } from 'react'
import { type ConnectionStatus } from '@/src/hooks/useSensorStream'
import { cn } from '@/lib/utils'

interface ConnectionStatusBarProps {
  status: ConnectionStatus
  fps: number
  lastError: string | null
  /** Number of distinct sensor types currently streaming. */
  sensorCount: number
  lastFrameTime: number | null
  /** Stream toggled off by the user (Stop). */
  paused: boolean
  onToggle: () => void
  className?: string
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: 'LIVE',
  connecting: 'CONNECTING',
  reconnecting: 'RECONNECTING',
  disconnected: 'OFFLINE',
}

const STATUS_TONE: Record<ConnectionStatus, { text: string, dot: string }> = {
  connected: { text: 'text-ok', dot: 'bg-ok' },
  connecting: { text: 'text-warn', dot: 'bg-warn' },
  reconnecting: { text: 'text-warn', dot: 'bg-warn' },
  disconnected: { text: 'text-danger', dot: 'bg-danger' },
}

/** Seconds since the last frame, re-rendered every second. */
function useFrameAge(timestamp: number | null) {
  const [age, setAge] = useState({ text: '', fresh: false })

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!timestamp) {
      setAge({ text: '', fresh: false })
      return
    }

    function update() {
      const diff = Math.max(0, (Date.now() - (timestamp ?? 0)) / 1000)
      setAge({ text: diff < 60 ? `${diff.toFixed(1)}s` : `${Math.floor(diff / 60)}m`, fresh: diff <= 10 })
    }

    update()
    /* eslint-enable react-hooks/set-state-in-effect */
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [timestamp])

  return age
}

/**
 * Live sensor-stream bar for the System header:
 * `● LIVE · 30 fps · 6 sensors · last frame 0.1s  [Stop]`.
 * Phones get the compact `● LIVE · 30 FPS` form.
 */
export function ConnectionStatusBar({
  status,
  fps,
  lastError,
  sensorCount,
  lastFrameTime,
  paused,
  onToggle,
  className,
}: ConnectionStatusBarProps) {
  const { text: age, fresh } = useFrameAge(paused ? null : lastFrameTime)
  const connected = !paused && status === 'connected'
  const label = paused ? 'PAUSED' : connected && !fresh ? (lastFrameTime ? 'STALE' : 'WAITING') : STATUS_LABEL[status]
  const tone = connected && !fresh ? { text: 'text-warn', dot: 'bg-warn' } : paused ? { text: 'text-fg-3', dot: 'bg-fg-3' } : STATUS_TONE[status]
  const title = !paused && status !== 'connected' && lastError ? lastError : undefined

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 font-mono text-xs text-fg-2 min-[900px]:gap-3.5 min-[900px]:rounded-ctl min-[900px]:border min-[900px]:border-line min-[900px]:py-1.5 min-[900px]:pl-3 min-[900px]:pr-1.5',
        className,
      )}
      title={title}
    >
      <span className={cn('flex items-center gap-1.5 whitespace-nowrap', tone.text)} data-testid="stream-status">
        <span className={cn('block size-1.5 shrink-0 rounded-full', tone.dot)} />
        {label}
        {connected && fps > 0 && (
          <span className="min-[900px]:hidden">{`· ${fps} FPS`}</span>
        )}
      </span>
      {connected && (
        <>
          <span className="hidden whitespace-nowrap min-[900px]:inline">{`${fps} fps`}</span>
          <span className="hidden whitespace-nowrap min-[900px]:inline">{`${sensorCount} sensors`}</span>
          {age && <span className="hidden whitespace-nowrap @min-[900px]:inline">{`sensor age ${age}`}</span>}
        </>
      )}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'cursor-pointer rounded-thumb border bg-transparent px-2.5 py-1 font-sans text-xs transition-colors hover:bg-active',
          paused ? 'border-line-2 text-fg' : 'border-danger-line text-danger',
        )}
      >
        {paused ? 'Start' : 'Stop'}
      </button>
    </div>
  )
}

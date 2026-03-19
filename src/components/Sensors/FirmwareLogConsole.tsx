'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOnSensorFrame, type LogFrame, type SensorFrame } from '@/src/hooks/useSensorStream'
import { Terminal, Trash2 } from 'lucide-react'

const MAX_LOG_ENTRIES = 50

const LEVEL_COLORS: Record<string, string> = {
  DEBUG: 'text-zinc-500',
  INFO: 'text-sky-400',
  WARN: 'text-amber-400',
  WARNING: 'text-amber-400',
  ERROR: 'text-red-400',
  CRITICAL: 'text-red-500',
}

function getLevelColor(level: string): string {
  return LEVEL_COLORS[level.toUpperCase()] ?? 'text-zinc-400'
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000)
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * Real-time firmware log console.
 * Terminal-style display of live firmware debug messages from the pod.
 * Auto-scrolls to latest entries, color-coded by log level.
 */
export function FirmwareLogConsole() {
  const [logs, setLogs] = useState<LogFrame[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  // Receive log frames
  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    if (frame.type !== 'log') return
    setLogs(prev => {
      const next = [...prev, frame as LogFrame]
      return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next
    })
  }, []))

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs.length])

  // Detect user scroll (disable auto-scroll when user scrolls up)
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20
    autoScrollRef.current = isAtBottom
  }, [])

  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Terminal size={14} className="text-zinc-400" />
          <h3 className="text-sm font-semibold text-zinc-200">Firmware Logs</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-600">
            {logs.length} / {MAX_LOG_ENTRIES}
          </span>
          <button
            onClick={clearLogs}
            className="rounded-md p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-400"
            title="Clear logs"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-48 overflow-y-auto rounded-xl bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed"
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-zinc-600">Waiting for firmware logs...</span>
          </div>
        ) : (
          logs.map((log, i) => (
            <div key={`${log.ts}-${i}`} className="flex gap-2">
              <span className="shrink-0 text-zinc-600">
                {formatTimestamp(log.ts)}
              </span>
              <span className={`shrink-0 w-12 text-right font-semibold ${getLevelColor(log.level)}`}>
                {log.level.toUpperCase().slice(0, 5)}
              </span>
              <span className="text-zinc-300 break-all">
                {log.msg}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOnSensorFrame, type LogFrame, type GestureFrame, type SensorFrame } from '@/src/hooks/useSensorStream'
import { Trash2, Pause, Play } from 'lucide-react'
import { GhostIcon, Pill, SegmentedControl } from '@/src/components/ds'

const MAX_ENTRIES = 100

const LEVEL_COLORS: Record<string, string> = {
  DEBUG: 'text-fg-3',
  INFO: 'text-fg-2',
  WARN: 'text-warn',
  WARNING: 'text-warn',
  ERROR: 'text-danger',
  CRITICAL: 'text-danger',
}

function getLevelColor(level: string): string {
  return LEVEL_COLORS[level.toUpperCase()] ?? 'text-fg-2'
}

function formatTime(ts: number): string {
  const date = new Date(ts < 1e12 ? ts * 1000 : ts)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

type ViewMode = 'logs' | 'frames'

interface RawEntry {
  ts: number
  type: string
  json: string
}

/**
 * Unified diagnostic console — firmware logs (default) + raw frame inspector. Terminal-style with auto-scroll, pause, type
 * filtering, and expandable frames.
 */
export function FirmwareLogConsole() {
  const [mode, setMode] = useState<ViewMode>('logs')
  const [logs, setLogs] = useState<LogFrame[]>([])
  const [frames, setFrames] = useState<RawEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const framesRef = useRef<RawEntry[]>([])
  const typesSeenRef = useRef(new Set<string>())
  const [typesSeen, setTypesSeen] = useState<string[]>([])

  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    if (frame.type === 'log') {
      if (!paused) {
        setLogs((prev) => {
          const next = [...prev, frame as LogFrame]
          return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next
        })
      }
    }

    // Surface gesture events as log entries
    if (frame.type === 'gesture') {
      if (!paused) {
        const gf = frame as GestureFrame
        const gestureLog: LogFrame = {
          type: 'log',
          ts: gf.ts,
          level: 'INFO',
          msg: `[TAP] ${gf.side} ${gf.tapType}`,
        }
        setLogs((prev) => {
          const next = [...prev, gestureLog]
          return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next
        })
      }
    }

    // Always buffer raw frames (even when viewing logs)
    const entry: RawEntry = {
      ts: Date.now(),
      type: frame.type,
      json: JSON.stringify(frame, null, 2),
    }
    framesRef.current = [entry, ...framesRef.current].slice(0, MAX_ENTRIES * 3)

    if (!typesSeenRef.current.has(frame.type)) {
      typesSeenRef.current.add(frame.type)
      setTypesSeen([...typesSeenRef.current])
    }

    if (mode === 'frames' && !paused) {
      setFrames([...framesRef.current])
    }
  }, [mode, paused]))

  // Auto-scroll
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs.length])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 20
  }, [])

  const handleClear = () => {
    if (mode === 'logs') setLogs([])
    else {
      framesRef.current = []
      setFrames([])
    }
  }

  const handleModeSwitch = (m: ViewMode) => {
    setMode(m)
    setExpandedIdx(null)
    if (m === 'frames') setFrames([...framesRef.current])
  }

  const filteredFrames = typeFilter
    ? frames.filter(f => f.type === typeFilter).slice(0, MAX_ENTRIES)
    : frames.slice(0, MAX_ENTRIES)

  const entryCount = mode === 'logs' ? logs.length : filteredFrames.length

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <SegmentedControl
          size="sm"
          ariaLabel="Console view"
          options={[{ value: 'logs', label: 'Logs' }, { value: 'frames', label: 'Frames' }]}
          value={mode}
          onChange={handleModeSwitch}
        />
        <span className="ml-auto font-mono text-xs text-fg-2">{`${entryCount} entries`}</span>
        <GhostIcon
          icon={paused ? Play : Pause}
          label={paused ? 'Resume' : 'Pause'}
          size={14}
          onClick={() => setPaused(p => !p)}
          className={paused ? 'text-warn' : undefined}
        />
        <GhostIcon icon={Trash2} label="Clear" size={14} onClick={handleClear} />
      </div>

      {/* Type filter (frames mode only) */}
      {mode === 'frames' && typesSeen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Pill selected={typeFilter === null} onClick={() => setTypeFilter(null)} className="px-2.5 py-1 font-mono text-xs">All</Pill>
          {typesSeen.map(type => (
            <Pill key={type} selected={typeFilter === type} onClick={() => setTypeFilter(type)} className="px-2.5 py-1 font-mono text-xs">{type}</Pill>
          ))}
        </div>
      )}

      {/* Console body */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-[min(420px,55dvh)] overflow-y-auto rounded-ctl border border-line bg-code px-3 py-2.5 font-mono text-xs leading-[1.7]"
      >
        {mode === 'logs'
          ? (
              logs.length === 0
                ? (
                    <Empty text="Waiting for firmware logs" />
                  )
                : (
                    logs.map((log, i) => (
                      <div key={`${log.ts}-${i}`} className="grid grid-cols-[64px_44px_minmax(0,1fr)] gap-2">
                        <span className="text-fg-3">{formatTime(log.ts)}</span>
                        <span className={getLevelColor(log.level)}>{log.level.toUpperCase().slice(0, 5)}</span>
                        <span className="break-all text-fg">{log.msg}</span>
                      </div>
                    ))
                  )
            )
          : (
              filteredFrames.length === 0
                ? (
                    <Empty text="Waiting for frames" />
                  )
                : (
                    filteredFrames.map((entry, i) => {
                      const isExpanded = expandedIdx === i
                      // eslint-disable-next-line react-hooks/purity
                      const age = ((Date.now() - entry.ts) / 1000).toFixed(1)
                      return (
                        <div key={`${entry.ts}-${i}`}>
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedIdx(isExpanded ? null : i)
                              if (!paused) setPaused(true)
                            }}
                            className={`flex w-full cursor-pointer items-center gap-2 rounded-tag border-0 px-1 text-left font-mono text-xs ${
                              isExpanded ? 'bg-active' : 'bg-transparent hover:bg-active'
                            }`}
                          >
                            <span className="shrink-0 text-fg-3">{formatTime(entry.ts)}</span>
                            <span className="shrink-0 text-fg">{entry.type}</span>
                            <span className="flex-1" />
                            <span className="text-fg-3">{`${age}s`}</span>
                          </button>
                          {isExpanded && (
                            <pre className="ml-4 max-h-48 overflow-auto py-1 text-[11px] text-fg-2">
                              {entry.json}
                            </pre>
                          )}
                        </div>
                      )
                    })
                  )
            )}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <span className="font-sans text-[13px] text-fg-3">{text}</span>
    </div>
  )
}

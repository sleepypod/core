'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Terminal, ChevronDown, ChevronUp, RefreshCw, Loader2 } from 'lucide-react'
import clsx from 'clsx'

const PRIORITIES = [
  { label: 'All', value: undefined },
  { label: 'Errors', value: 'err' },
  { label: 'Warn', value: 'warning' },
  { label: 'Debug', value: 'debug' },
] as const

const LEVEL_COLORS: Record<string, string> = {
  emerg: 'text-red-500',
  alert: 'text-red-500',
  crit: 'text-red-500',
  err: 'text-red-400',
  warning: 'text-amber-400',
  notice: 'text-sky-400',
  info: 'text-zinc-300',
  debug: 'text-zinc-500',
}

/**
 * SystemLogViewer — browse journalctl logs from systemd services.
 * Matches iOS LogsView with service selection and priority filtering.
 *
 * Wires into:
 * - system.getLogSources → list available systemd services
 * - system.getLogs → read log lines with filters
 */
export function SystemLogViewer() {
  const [isExpanded, setIsExpanded] = useState(false)
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null)
  const [priority, setPriority] = useState<'alert' | 'warning' | 'emerg' | 'crit' | 'err' | 'notice' | 'info' | 'debug' | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { data: sources } = trpc.system.getLogSources.useQuery(
    {},
    { refetchInterval: 30_000 },
  )

  const { data: logs, isLoading: logsLoading, refetch: refetchLogs } = trpc.system.getLogs.useQuery(
    {
      unit: selectedUnit ?? (sources?.sources?.[0]?.unit ?? ''),
      lines: 100,
      priority,
    },
    {
      enabled: isExpanded && (selectedUnit !== null || (sources?.sources?.length ?? 0) > 0),
    },
  )

  // Auto-select first source when data loads
  useEffect(() => {
    if (!selectedUnit && sources?.sources?.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedUnit(sources.sources[0].unit)
    }
  }, [sources, selectedUnit])

  // Auto-scroll to bottom of logs
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs])

  const handleRefresh = useCallback(() => {
    refetchLogs()
  }, [refetchLogs])

  // getLogs returns plain strings from journalctl output
  const logLines = logs?.lines ?? []

  return (
    <div className="rounded-2xl bg-zinc-900/80 overflow-hidden">
      {/* Toggle header */}
      <button
        onClick={() => setIsExpanded(v => !v)}
        className="flex w-full items-center justify-between p-3 sm:p-4"
      >
        <div className="flex items-center gap-2">
          <Terminal size={16} className="text-zinc-400" />
          <span className="text-sm font-medium text-white">System Logs</span>
        </div>
        {isExpanded
          ? (
              <ChevronUp size={16} className="text-zinc-500" />
            )
          : (
              <ChevronDown size={16} className="text-zinc-500" />
            )}
      </button>

      {isExpanded && (
        <div className="border-t border-zinc-800 px-3 pb-3 pt-2 space-y-2 sm:px-4 sm:pb-4 sm:pt-3 sm:space-y-3">
          {/* Service selector */}
          <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
            {(sources?.sources ?? []).map((src: { name: string, unit: string, active: boolean }) => (
              <button
                key={src.unit}
                onClick={() => setSelectedUnit(src.unit)}
                className={clsx(
                  'whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors',
                  selectedUnit === src.unit
                    ? 'bg-sky-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 active:bg-zinc-700',
                  !src.active && 'opacity-50',
                )}
              >
                {src.name}
              </button>
            ))}
          </div>

          {/* Priority filter */}
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              {PRIORITIES.map(p => (
                <button
                  key={p.label}
                  onClick={() => setPriority(p.value)}
                  className={clsx(
                    'rounded-md px-2 py-1 text-[10px] font-medium transition-colors',
                    priority === p.value
                      ? 'bg-zinc-700 text-white'
                      : 'text-zinc-500 active:bg-zinc-800',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <button
              onClick={handleRefresh}
              disabled={logsLoading}
              className="ml-auto rounded-md p-1 text-zinc-500 active:bg-zinc-800"
            >
              {logsLoading
                ? (
                    <Loader2 size={12} className="animate-spin" />
                  )
                : (
                    <RefreshCw size={12} />
                  )}
            </button>
          </div>

          {/* Log output */}
          <div
            ref={scrollRef}
            className="h-60 overflow-y-auto rounded-xl bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed"
          >
            {logsLoading && logLines.length === 0
              ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 size={16} className="animate-spin text-zinc-600" />
                  </div>
                )
              : logLines.length === 0
                ? (
                    <div className="flex h-full items-center justify-center text-zinc-600">
                      No logs found
                    </div>
                  )
                : (
                    logLines.map((line, i) => {
                      // Detect priority level from journalctl output for color-coding
                      const levelMatch = line.match(/\b(emerg|alert|crit|err|warning|notice|info|debug)\b/i)
                      const level = levelMatch?.[1]?.toLowerCase() ?? ''
                      const color = LEVEL_COLORS[level] ?? 'text-zinc-400'

                      return (
                        <div key={i} className="py-0.5">
                          <span className={clsx('break-all', color)}>{line}</span>
                        </div>
                      )
                    })
                  )}
          </div>
        </div>
      )}
    </div>
  )
}

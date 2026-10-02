'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Clipboard, ClipboardCheck, Download, RefreshCw, Search, SquareTerminal } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, GhostIcon, InlineError, Modal, SectionLabel, SegmentedControl, Skeleton, StatusDot, Toggle } from '@/src/components/ds'
import { FirmwareLogConsole } from '@/src/components/Sensors/FirmwareLogConsole'
import { cn } from '@/lib/utils'

type Priority = 'emerg' | 'alert' | 'crit' | 'err' | 'warning' | 'notice' | 'info' | 'debug'
type LevelFilter = 'all' | 'info' | 'warn' | 'error'

/** Level filter → journalctl priority ceiling (`-p`, shows that level and worse). */
const LEVEL_PRIORITY: Record<LevelFilter, Priority | undefined> = {
  all: undefined,
  info: 'info',
  warn: 'warning',
  error: 'err',
}

const LEVEL_OPTIONS = [
  { value: 'all' as const, label: 'All' },
  { value: 'info' as const, label: 'Info' },
  { value: 'warn' as const, label: 'Warn' },
  { value: 'error' as const, label: 'Error' },
]

const FOLLOW_INTERVAL_MS = 5_000

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'

export interface ParsedLogLine {
  time: string
  level: LogLevel
  service: string
  message: string
  raw: string
}

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\S*)\s+\S+\s+([^\s:[]+)(?:\[\d+\])?:\s?(.*)$/

/** Guess a level from the message text; falls back to the priority floor. */
export function detectLevel(message: string, floor: LevelFilter = 'all'): LogLevel {
  if (/\b(error|err|fatal|crit(ical)?|emerg|alert|exception)\b/i.test(message)) return 'ERROR'
  if (/\bwarn(ing)?\b/i.test(message)) return 'WARN'
  if (/\bdebug\b/i.test(message)) return 'DEBUG'
  if (floor === 'error') return 'ERROR'
  if (floor === 'warn') return 'WARN'
  return 'INFO'
}

/**
 * Parse a `journalctl --output short-iso` line
 * (`2026-09-28T23:39:02+0000 host unit[pid]: message`) into columns.
 * Unrecognized lines keep the raw text as the message.
 */
export function parseLogLine(raw: string, floor: LevelFilter = 'all'): ParsedLogLine {
  const m = LINE_RE.exec(raw)
  if (!m) return { time: '', level: detectLevel(raw, floor), service: '', message: raw, raw }
  const service = m[3].replace(/^sleepypod-?/, '').replace(/\.service$/, '') || 'sleepypod'
  return { time: m[2], level: detectLevel(m[4], floor), service, message: m[4], raw }
}

const LEVEL_CLASS: Record<LogLevel, string> = {
  ERROR: 'text-danger',
  WARN: 'text-warn',
  INFO: 'text-fg-2',
  DEBUG: 'text-fg-3',
}

/**
 * System → Logs: systemd sources list, the firmware console,
 * and a journalctl viewer with level filter, text filter, Follow (auto-refresh
 * + keep newest in view), Copy and Download.
 *
 * Wires into:
 * - system.getLogSources → list available systemd services
 * - system.getLogs → read log lines with filters
 */
export function SystemLogViewer() {
  // ?unit= preselects a source (System → Health links a fix to its logs).
  const initialUnit = useSearchParams().get('unit')
  const [selectedUnit, setSelectedUnit] = useState<string | null>(initialUnit)
  const [level, setLevel] = useState<LevelFilter>('all')
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const sourcesQuery = trpc.system.getLogSources.useQuery(
    {},
    { refetchInterval: 30_000 },
  )
  const sources = sourcesQuery.data?.sources ?? []
  const unit = selectedUnit ?? sources[0]?.unit ?? null

  const logsQuery = trpc.system.getLogs.useQuery(
    {
      unit: unit ?? '',
      lines: 200,
      priority: LEVEL_PRIORITY[level],
    },
    {
      enabled: unit !== null,
      refetchInterval: follow ? FOLLOW_INTERVAL_MS : false,
    },
  )

  // getLogs returns journalctl lines newest-first
  const lines = useMemo(() => {
    const parsed = (logsQuery.data?.lines ?? []).map(l => parseLogLine(l, level))
    const q = query.trim().toLowerCase()
    return q ? parsed.filter(l => l.raw.toLowerCase().includes(q)) : parsed
  }, [logsQuery.data, level, query])

  // Follow keeps the newest line (top) in view as new data arrives
  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = 0
  }, [follow, logsQuery.data])

  const text = useMemo(() => lines.map(l => l.raw).join('\n'), [lines])

  const handleDownload = useCallback(() => {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(unit ?? 'logs').replace(/\.service$/, '')}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log`
    a.click()
    URL.revokeObjectURL(url)
  }, [text, unit])

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }, [text])

  return (
    <div className="grid items-start gap-3.5 @min-[900px]:grid-cols-[240px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3.5">
        <Card>
          <SectionLabel>Sources</SectionLabel>
          {sourcesQuery.isLoading && <Skeleton className="h-32 border-0" />}
          {sourcesQuery.error && <InlineError>{sourcesQuery.error.message}</InlineError>}
          <div className="-mx-2 flex flex-col gap-0.5" role="listbox" aria-label="Log sources">
            {sources.map(src => (
              <button
                key={src.unit}
                type="button"
                role="option"
                aria-selected={src.unit === unit}
                onClick={() => setSelectedUnit(src.unit)}
                className={cn(
                  'flex min-w-0 cursor-pointer items-center gap-2.5 rounded-ctl border-0 px-2.5 py-2 text-left transition-colors',
                  src.unit === unit ? 'bg-active' : 'bg-transparent hover:bg-active',
                )}
              >
                <StatusDot tone={src.active ? 'ok' : 'muted'} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm text-fg">{src.name}</span>
                  <span className="truncate font-mono text-[11px] text-fg-2">{src.unit}</span>
                </span>
              </button>
            ))}
          </div>
        </Card>

        <Card>
          <SectionLabel>Firmware console</SectionLabel>
          <span className="text-[13px] text-fg-2">Raw output from the pod firmware.</span>
          <Button icon={SquareTerminal} onClick={() => setConsoleOpen(true)}>Open console</Button>
        </Card>
      </div>

      <Card className="min-h-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <SegmentedControl ariaLabel="Log level" options={LEVEL_OPTIONS} value={level} onChange={setLevel} />
          <label className="flex min-w-[140px] flex-1 items-center gap-2 rounded-ctl border border-line-2 bg-field px-2.5 py-[7px] text-[13px] text-fg-3 focus-within:border-fg-3">
            <Search size={14} className="shrink-0" />
            <input
              type="search"
              aria-label="Filter log lines"
              placeholder="Filter"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[13px] text-fg outline-none placeholder:font-sans placeholder:text-fg-3"
            />
          </label>
          <span className="flex items-center gap-2 text-[13px] text-fg-2">
            Follow
            <Toggle on={follow} onChange={setFollow} label="Follow logs" />
          </span>
          <div className="flex items-center gap-1.5">
            <GhostIcon
              icon={RefreshCw}
              label="Refresh logs"
              size={15}
              onClick={() => void logsQuery.refetch()}
              disabled={logsQuery.isFetching || unit === null}
              className={logsQuery.isFetching ? '[&_svg]:animate-spin' : undefined}
            />
            <Button icon={copied ? ClipboardCheck : Clipboard} onClick={handleCopy} disabled={!text} className="max-[899px]:hidden">
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button icon={Download} onClick={handleDownload} disabled={!text}>Download</Button>
          </div>
        </div>

        <div
          ref={scrollRef}
          className="h-[min(560px,60dvh)] overflow-y-auto rounded-ctl border border-line bg-code px-3 py-2.5 font-mono text-xs leading-[1.7]"
          data-testid="log-lines"
        >
          {logsQuery.isLoading && unit !== null
            ? <p className="text-fg-3">Loading…</p>
            : logsQuery.error
              ? <InlineError>{logsQuery.error.message}</InlineError>
              : lines.length === 0
                ? <p className="text-fg-3">{query ? 'No lines match the filter' : 'No logs found'}</p>
                : lines.map((l, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[64px_44px_minmax(0,1fr)] gap-2 @min-[640px]:grid-cols-[76px_52px_96px_minmax(0,1fr)]"
                    >
                      <span className="text-fg-3">{l.time}</span>
                      <span className={LEVEL_CLASS[l.level]}>{l.level}</span>
                      <span className="hidden truncate text-fg-2 @min-[640px]:block">{l.service}</span>
                      <span className="break-words text-fg">{l.message}</span>
                    </div>
                  ))}
        </div>
      </Card>

      <Modal open={consoleOpen} onClose={() => setConsoleOpen(false)} title="Firmware console" icon={SquareTerminal} width={760}>
        <FirmwareLogConsole />
      </Modal>
    </div>
  )
}

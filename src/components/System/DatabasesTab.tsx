'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, Download, ShieldCheck, X } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, GhostIcon, InlineError, Skeleton, StatusDot } from '@/src/components/ds'
import { formatBytes } from '@/src/components/status/SystemInfoCard'
import { cn } from '@/lib/utils'
import {
  fmtAgo, fmtLastWrite, fmtRetention, fmtRowTime, growthKind, isStalled, migrationNote, outlookSentence, projectOutlook,
  stripCells, toCsv, dailyGrowth, isUnprunedGrowth, type GrowthKind, type Outlook,
} from './databasesLogic'

type Overview = inferRouterOutputs<AppRouter>['databases']['overview']
type Db = Overview['databases'][number]
type Table = Db['tables'][number]

const DB_META: Record<Db['key'], { file: string, about: string, color: string }> = {
  sleepypod: { file: 'sleepypod.db', about: 'settings, schedules, automations', color: 'var(--chart-vital-hrv)' },
  biometrics: { file: 'biometrics.db', about: 'sensor time series', color: 'var(--chart-vital-br)' },
}

const KIND_COLOR: Record<GrowthKind, string> = {
  retained: 'var(--chart-vital-br)',
  growing: 'var(--status-warn)',
  static: 'var(--chart-vital-hrv)',
}

const PAGE = 10

/** "1.2 MB/day" with a sign, or "flat". */
function perDay(bytes: number): string {
  return bytes < 512 ? 'flat' : `+${formatBytes(bytes)}/day`
}

/**
 * System → Databases: both SQLite files side by side. A storage outlook
 * projects them against free disk, each database gets integrity, WAL, free
 * pages, migrations and a 24-hour write strip per table, then a read-only
 * row browser and backup.
 */
export function DatabasesTab() {
  const utils = trpc.useUtils()
  const overview = trpc.databases.overview.useQuery({ fresh: false }, { refetchInterval: 5 * 60_000 })
  const check = trpc.databases.checkIntegrity.useMutation({
    onSettled: () => void utils.databases.overview.invalidate(),
  })

  if (overview.isPending) {
    return (
      <>
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-[300px]" />
        <div className="grid gap-3.5 @min-[960px]:grid-cols-2">
          <Skeleton className="h-[480px]" />
          <Skeleton className="h-[480px]" />
        </div>
      </>
    )
  }
  if (overview.error || !overview.data) {
    return <Card tone="danger"><InlineError>{overview.error?.message ?? 'Database info unavailable'}</InlineError></Card>
  }

  const d = overview.data
  const onDisk = d.databases.reduce((s, db) => s + db.fileBytes + db.walBytes, 0)

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <span className="font-mono text-xs text-fg-2">
          {`${d.databases.length} databases · ${formatBytes(onDisk)} with WAL · ${d.dataDir}`}
        </span>
        <div className="flex flex-wrap gap-2 @min-[760px]:ml-auto">
          <Button icon={ShieldCheck} disabled={check.isPending} onClick={() => check.mutate({})}>
            {check.isPending ? 'Checking…' : 'Run integrity check'}
          </Button>
          <BackupLink primary onDone={() => void utils.databases.overview.invalidate()} />
        </div>
      </div>
      {check.error && <Card tone="danger"><InlineError>{check.error.message}</InlineError></Card>}

      <StorageOutlook data={d} />

      <div className="grid items-start gap-3.5 @min-[960px]:grid-cols-2">
        {d.databases.map(db => <DatabaseCard key={db.key} db={db} data={d} />)}
      </div>

      <RowBrowser databases={d.databases} />

      <Card className="flex-row flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-[320px] flex-col gap-1">
          <span className="flex items-baseline gap-2.5">
            <span className="text-[15px] font-medium">Backup</span>
            <span className="font-mono text-xs text-fg-2">{`last downloaded: ${d.lastBackupAt ? fmtAgo(d.lastBackupAt, d.at) : 'never'}`}</span>
          </span>
          <span className="text-[13px] leading-[1.45] text-fg-2 text-pretty">
            {`Download backup copies both databases with SQLite’s online backup, so the pod keeps running. To restore, stop sleepypod and copy each .db back into ${d.dataDir}.`}
          </span>
        </div>
        <BackupLink onDone={() => void utils.databases.overview.invalidate()} />
      </Card>
    </>
  )
}

function BackupLink({ primary, onDone }: { primary?: boolean, onDone: () => void }) {
  return (
    <a
      href="/api/db-backup"
      download
      onClick={() => setTimeout(onDone, 15_000)}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl border px-3.5 py-2 text-[13px] no-underline transition-colors hover:no-underline',
        primary ? 'border-transparent bg-fg font-medium text-inverse' : 'border-line-2 text-fg hover:bg-active',
      )}
    >
      <Download size={14} />
      Download backup
    </a>
  )
}

// ── Storage outlook ──────────────────────────────────────────────────────────

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof ResizeObserver === 'undefined') {
      setWidth(el.clientWidth || 640)
      return
    }
    const ro = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

function StorageOutlook({ data }: { data: Overview }) {
  const tables = useMemo(() => data.databases.flatMap(db => db.tables), [data])
  const outlook = useMemo(() => projectOutlook(tables, data.disk?.availableBytes ?? null), [tables, data.disk])
  const counts = { retained: 0, growing: 0, static: 0 }
  for (const t of tables) counts[growthKind(t)]++

  return (
    <Card data-testid="storage-outlook">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <span className="text-[15px] font-medium">Storage outlook</span>
        <span className="font-mono text-xs text-fg-2">both databases · projected at the last 24 h’s growth</span>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[11px] text-fg-2 @min-[900px]:ml-auto">
          {([['retained', `${counts.retained} retained`], ['growing', `${counts.growing} not pruned`], ['static', `${counts.static} not growing`]] as const).map(([k, label]) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px]" style={{ background: KIND_COLOR[k] }} />
              {label}
            </span>
          ))}
        </div>
      </div>
      <p className="text-sm leading-[1.5] text-pretty">{outlookSentence(outlook, data.at, formatBytes)}</p>
      <OutlookChart outlook={outlook} now={data.at} />
    </Card>
  )
}

function OutlookChart({ outlook, now }: { outlook: Outlook, now: number }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hoverX, setHoverX] = useState<number | null>(null)
  const height = 220
  const left = 52
  const bottom = 20
  const plotW = Math.max(0, width - left - 8)
  const plotH = height - bottom - 16
  const { samples, horizonDays, limit, fillDays } = outlook
  const totals = samples.map(s => s.retained + s.growing + s.static)
  const showLimit = limit != null && fillDays != null
  const yMax = Math.max(showLimit ? (limit as number) * 1.04 : 0, Math.max(...totals) * 1.15, 1)
  const X = (day: number) => left + (day / horizonDays) * plotW
  const Y = (b: number) => 16 + plotH - (b / yMax) * plotH

  const band = (lo: (i: number) => number, hi: (i: number) => number) => {
    const top = samples.map((s, i) => `${X(s.day)},${Y(hi(i))}`)
    const base = samples.map((s, i) => `${X(s.day)},${Y(lo(i))}`).reverse()
    return `M${top.join(' L')} L${base.join(' L')} Z`
  }
  const r = (i: number) => samples[i].retained
  const rs = (i: number) => samples[i].retained + samples[i].static
  const all = (i: number) => totals[i]

  // Y ticks at round byte values.
  const MiB = 1024 * 1024
  const step = [1, 2, 5].flatMap(m => [1, 10, 100, 1000, 10_000].map(e => m * e * MiB)).sort((a, b) => a - b).find(s => yMax / s <= 4) ?? 10_000 * MiB
  const yTicks: number[] = []
  for (let v = 0; v <= yMax; v += step) yTicks.push(v)

  // X ticks at month starts, thinned to fit.
  const xTicks: number[] = []
  const d = new Date(now)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  const monthsTotal = Math.ceil(horizonDays / 30)
  const every = Math.max(1, Math.ceil(monthsTotal / Math.max(1, Math.floor(plotW / 70))))
  for (let m = 1; m <= monthsTotal; m++) {
    const t = new Date(d)
    t.setMonth(d.getMonth() + m)
    if (m % every === 0 && (t.getTime() - now) / 86_400_000 <= horizonDays) xTicks.push(t.getTime())
  }
  const fmtTick = (ms: number) => {
    const dt = new Date(ms)
    return dt.getMonth() === 0 ? String(dt.getFullYear()) : dt.toLocaleDateString([], { month: 'short' })
  }

  // Hover: the nearest projected day and what it adds up to.
  let hover: { x: number, label: string } | null = null
  if (hoverX !== null && plotW > 0 && samples.length > 0) {
    const day = Math.max(0, Math.min(horizonDays, ((hoverX - left) / plotW) * horizonDays))
    let i = 0
    for (let k = 1; k < samples.length; k++) if (Math.abs(samples[k].day - day) < Math.abs(samples[i].day - day)) i = k
    const date = new Date(now + samples[i].day * 86_400_000).toLocaleDateString([], { month: 'short', day: 'numeric' })
    hover = { x: X(samples[i].day), label: `${date} · ${formatBytes(totals[i])}` }
  }

  return (
    <div ref={ref} style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          className="block overflow-visible"
          role="img"
          aria-label="Projected database size"
          onPointerMove={(e) => {
            const x = e.clientX - e.currentTarget.getBoundingClientRect().left
            setHoverX(x < left || x > left + plotW ? null : x)
          }}
          onPointerLeave={() => setHoverX(null)}
        >
          {yTicks.map(v => (
            <g key={v}>
              <line x1={left} x2={width - 8} y1={Y(v)} y2={Y(v)} stroke="var(--border-grid)" />
              <text x={left - 8} y={Y(v) + 3} textAnchor="end" fill="var(--text-3)" fontSize="10" className="font-mono">{formatBytes(v)}</text>
            </g>
          ))}
          {xTicks.map(t => (
            <text key={t} x={X((t - now) / 86_400_000)} y={height - 4} textAnchor="middle" fill="var(--text-3)" fontSize="10" className="font-mono">{fmtTick(t)}</text>
          ))}
          <path d={band(() => 0, r)} fill={KIND_COLOR.retained} fillOpacity="0.35" />
          <path d={band(r, rs)} fill={KIND_COLOR.static} fillOpacity="0.3" />
          <path d={band(rs, all)} fill={KIND_COLOR.growing} fillOpacity="0.3" />
          <path d={`M${samples.map((s, i) => `${X(s.day)},${Y(totals[i])}`).join(' L')}`} fill="none" stroke="var(--text-1)" strokeOpacity="0.6" strokeDasharray="3 3" />
          <line x1={X(0)} x2={X(0)} y1={12} y2={16 + plotH} stroke="var(--text-2)" />
          <text x={X(0) + 5} y={10} fill="var(--text-1)" fontSize="10" className="font-mono">{`today · ${formatBytes(totals[0])}`}</text>
          {showLimit && (
            <g data-testid="disk-limit">
              <line x1={left} x2={width - 8} y1={Y(limit as number)} y2={Y(limit as number)} stroke="var(--status-danger)" strokeDasharray="2 3" />
              <text x={width - 8} y={Y(limit as number) - 5} textAnchor="end" fill="var(--status-danger)" fontSize="10" className="font-mono">{`disk full · ${formatBytes(limit as number)}`}</text>
              <line x1={X(fillDays as number)} x2={X(fillDays as number)} y1={Y(limit as number)} y2={16 + plotH} stroke="var(--status-danger)" strokeOpacity="0.6" />
            </g>
          )}
          {hover && (
            <g data-testid="outlook-hover" pointerEvents="none">
              <line x1={hover.x} x2={hover.x} y1={12} y2={16 + plotH} stroke="var(--text-1)" strokeOpacity="0.35" />
              <text
                x={hover.x > width / 2 ? hover.x - 6 : hover.x + 6}
                y={16 + plotH - 8}
                textAnchor={hover.x > width / 2 ? 'end' : 'start'}
                fill="var(--text-1)"
                fontSize="10"
                className="font-mono"
              >
                {hover.label}
              </text>
            </g>
          )}
        </svg>
      )}
    </div>
  )
}

// ── Database cards ───────────────────────────────────────────────────────────

function Fact({ label, value, sub, tone }: { label: string, value: string, sub: string, tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
      <span className="text-xs text-fg-2">{label}</span>
      <span className={cn('flex items-center gap-1.5 font-mono text-sm', tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-fg')}>
        {tone && <StatusDot tone={tone} />}
        {value}
      </span>
      <span className="font-mono text-[11px] leading-snug text-fg-3">{sub}</span>
    </div>
  )
}

function integrityFact(db: Db, now: number): { value: string, sub: string, tone: 'ok' | 'warn' | 'danger' } {
  const { scheduled, manual } = db.integrity
  const latest = [scheduled, manual]
    .filter((r): r is NonNullable<typeof r> => r != null && r.checkedAt != null)
    .sort((a, b) => Date.parse(b.checkedAt as string) - Date.parse(a.checkedAt as string))[0]
  if (latest) {
    const how = latest === manual ? 'manual' : 'hourly'
    return latest.status === 'ok'
      ? { value: 'OK', sub: `quick_check · ${how} · ${fmtAgo(Date.parse(latest.checkedAt as string), now)} · ${latest.latencyMs} ms`, tone: 'ok' }
      : { value: 'Failed', sub: latest.error ?? 'quick_check reported errors', tone: 'danger' }
  }
  return { value: 'Pending', sub: 'hourly check runs 30 s after start', tone: 'warn' }
}

function DatabaseCard({ db, data }: { db: Db, data: Overview }) {
  const meta = DB_META[db.key]
  const occupied = useMemo(() => new Set(data.occupiedHours), [data.occupiedHours])
  const tables = [...db.tables].sort((a, b) => b.bytes - a.bytes)
  const growth = db.tables.reduce((s, t) => s + (t.retention ? 0 : dailyGrowth(t)), 0)
  const integrity = integrityFact(db, data.at)
  const mig = migrationNote(db.migrations)

  return (
    <Card data-testid={`db-${db.key}`}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="size-2.5 rounded-[3px]" style={{ background: meta.color }} />
        <span className="font-mono text-[15px]">{meta.file}</span>
        <span className="truncate text-xs text-fg-2">{meta.about}</span>
        <span className="ml-auto flex items-baseline gap-1.5">
          <span className="font-mono text-lg font-light">{formatBytes(db.fileBytes)}</span>
          <span className="font-mono text-[11px] text-fg-2">{perDay(growth)}</span>
        </span>
      </div>
      {db.error && <InlineError>{db.error}</InlineError>}
      <div className="grid grid-cols-2 overflow-hidden rounded-[10px] border border-line [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(odd)]:border-r [&>*]:border-line">
        <Fact label="Integrity" {...integrity} />
        <Fact label="WAL" value={formatBytes(db.walBytes)} sub={`checkpoints every ${db.walAutocheckpoint} pages`} />
        <Fact label="Free pages" value={formatBytes(db.freePages * db.pageSize)} sub={`${db.freePages.toLocaleString()} pages, reused before the file grows`} />
        <Fact label="Migrations" value={`${db.migrations.applied} / ${db.migrations.known}`} sub={mig.text} tone={mig.warn ? 'warn' : undefined} />
      </div>
      <div className="flex flex-col">
        <div className="grid grid-cols-[minmax(0,1fr)_60px_52px] @min-[480px]:grid-cols-[minmax(0,1fr)_minmax(96px,140px)_64px] items-center gap-3 pb-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-fg-3">
          <span>{`Table · ${tables.length}`}</span>
          <span className="flex justify-between">
            <span>Writes</span>
            <span>24 h</span>
          </span>
          <span className="text-right">Size</span>
        </div>
        {tables.map(t => <TableRow key={t.name} table={t} occupied={occupied} now={data.at} color={meta.color} />)}
      </div>
    </Card>
  )
}

function TableRow({ table: t, occupied, now, color }: { table: Table, occupied: ReadonlySet<number>, now: number, color: string }) {
  const cells = stripCells(t, occupied)
  const stalled = isStalled(cells)
  const unpruned = isUnprunedGrowth(t)
  const meta = [
    `${t.rows.toLocaleString()} rows`,
    t.lastWriteAt ? `last ${fmtLastWrite(t.lastWriteAt, now)}` : t.timeColumn ? 'empty' : 'no time column',
    ...(stalled ? ['pod occupied'] : []),
  ].join(' · ')

  return (
    <div
      data-testid={`table-${t.name}`}
      className={cn('-mx-2 grid grid-cols-[minmax(0,1fr)_60px_52px] @min-[480px]:grid-cols-[minmax(0,1fr)_minmax(96px,140px)_64px] items-center gap-3 rounded-[8px] px-2 py-1.5', stalled && 'bg-active')}
    >
      <div className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[13px]">{t.name}</span>
          {unpruned && <span className="shrink-0 rounded-tag border border-warn-line px-1 font-mono text-[10px] text-warn">not pruned</span>}
          {t.retention && (
            <span className="shrink-0 font-mono text-[10px] text-fg-3" title={`Pruned by the ${t.retention.by}`}>{fmtRetention(t.retention.days)}</span>
          )}
        </span>
        <span className={cn('truncate font-mono text-[11px]', stalled ? 'text-warn' : 'text-fg-3')}>{meta}</span>
      </div>
      <div className="flex h-4 items-stretch gap-px" role="img" aria-label={`${t.rows24h.toLocaleString()} rows written in the last 24 hours`}>
        {cells.map((c, i) => (
          <span
            key={i}
            title={`${t.hourly[i]} rows`}
            className={cn('flex-1 rounded-[1px]', c === 'idle' && 'bg-active')}
            style={c === 'write'
              ? { background: color }
              : c === 'missing'
                ? { background: 'repeating-linear-gradient(135deg, var(--status-warn) 0 1.5px, transparent 1.5px 4px)' }
                : undefined}
          />
        ))}
      </div>
      <span className="text-right font-mono text-xs text-fg-2">{formatBytes(t.bytes)}</span>
    </div>
  )
}

// ── Row browser ──────────────────────────────────────────────────────────────

function RowBrowser({ databases }: { databases: Db[] }) {
  const first = databases.find(d => d.key === 'biometrics' && d.tables.some(t => t.name === 'vitals'))
    ? { db: 'biometrics' as const, table: 'vitals' }
    : { db: databases[0]?.key ?? 'sleepypod', table: databases[0]?.tables[0]?.name ?? '' }
  const [source, setSource] = useState<{ db: Db['key'], table: string }>(first)
  const [filter, setFilter] = useState<{ column: string, value: string } | null>(null)
  const [draft, setDraft] = useState<{ column: string, value: string } | null>(null)
  const [offset, setOffset] = useState(0)
  const [copied, setCopied] = useState(false)

  const rows = trpc.databases.rows.useQuery(
    { db: source.db, table: source.table, offset, limit: PAGE, ...(filter && { column: filter.column, value: filter.value }) },
    { enabled: !!source.table, placeholderData: prev => prev },
  )
  const r = rows.data

  const choose = (value: string) => {
    const [db, table] = value.split('/') as [Db['key'], string]
    setSource({ db, table })
    setFilter(null)
    setDraft(null)
    setOffset(0)
  }
  const copyCsv = async () => {
    if (!r) return
    try {
      await navigator.clipboard.writeText(toCsv(r.columns, r.rows))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
    catch { /* clipboard unavailable over plain http */ }
  }
  const renderCell = (col: string, v: string | number | null) => {
    if (v == null) return <span className="text-fg-3">null</span>
    if (col === r?.timeColumn && typeof v === 'number') return fmtRowTime(v, v > 1e11)
    // Display only; Copy CSV keeps full precision.
    if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 100) / 100)
    return String(v)
  }

  return (
    <Card data-testid="row-browser">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[15px] font-medium">Rows</span>
        <select
          aria-label="Table"
          value={`${source.db}/${source.table}`}
          onChange={e => choose(e.target.value)}
          className="rounded-ctl border border-line-2 bg-field px-2.5 py-1.5 font-mono text-xs text-fg"
        >
          {databases.map(db => (
            <optgroup key={db.key} label={DB_META[db.key].file}>
              {[...db.tables].sort((a, b) => a.name.localeCompare(b.name)).map(t => (
                <option key={t.name} value={`${db.key}/${t.name}`}>{`${DB_META[db.key].file} / ${t.name}`}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="rounded-tag border border-line-2 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.06em] text-fg-2">READ-ONLY</span>
        {filter
          ? (
              <span className="flex items-center gap-1 rounded-tag border border-line-2 bg-active py-0.5 pl-2 pr-0.5 font-mono text-xs">
                {`${filter.column} = ${filter.value}`}
                <GhostIcon
                  icon={X}
                  size={12}
                  label="Clear filter"
                  onClick={() => {
                    setFilter(null)
                    setOffset(0)
                  }}
                />
              </span>
            )
          : draft
            ? (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (draft.value !== '') {
                      setFilter(draft)
                      setOffset(0)
                    }
                    setDraft(null)
                  }}
                >
                  <select
                    aria-label="Filter column"
                    value={draft.column}
                    onChange={e => setDraft({ ...draft, column: e.target.value })}
                    className="rounded-ctl border border-line-2 bg-field px-2 py-1 font-mono text-xs text-fg"
                  >
                    {(r?.columns ?? []).map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <span className="font-mono text-xs text-fg-2">=</span>
                  <input
                    aria-label="Filter value"
                    autoFocus
                    value={draft.value}
                    onChange={e => setDraft({ ...draft, value: e.target.value })}
                    className="w-28 rounded-ctl border border-line-2 bg-field px-2 py-1 font-mono text-xs text-fg"
                  />
                  <Button size="sm" type="submit">Apply</Button>
                </form>
              )
            : r && r.columns.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setDraft({ column: r.columns.includes('side') ? 'side' : r.columns[0], value: '' })}>
                Filter
              </Button>
            )}
        <span className="ml-auto font-mono text-xs text-fg-2">newest first</span>
        <Button size="sm" icon={Copy} disabled={!r || r.rows.length === 0} onClick={() => void copyCsv()}>{copied ? 'Copied' : 'Copy CSV'}</Button>
      </div>
      {rows.error && <InlineError>{rows.error.message}</InlineError>}
      <div className="-mx-[18px] overflow-x-auto px-[18px]">
        <table className="w-full min-w-max border-collapse text-[13px]">
          <thead>
            <tr>
              {(r?.columns ?? []).map(c => (
                <th key={c} className="whitespace-nowrap border-b border-line py-1.5 pr-5 text-left font-mono text-[11px] font-normal text-fg-3">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r?.rows.map((row, i) => (
              <tr key={i} className="border-b border-line last:border-b-0">
                {row.map((v, j) => (
                  <td key={j} className={cn('max-w-[320px] truncate whitespace-nowrap py-1.5 pr-5 font-mono text-xs', typeof v === 'number' && 'tabular-nums')}>
                    {renderCell(r.columns[j], v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {r && r.rows.length === 0 && <p className="py-6 text-center text-sm text-fg-3">No rows.</p>}
        {!r && rows.isLoading && <Skeleton className="h-40 border-0" />}
      </div>
      {r && r.total > 0 && (
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs text-fg-2">{`${(offset + 1).toLocaleString()}–${Math.min(offset + PAGE, r.total).toLocaleString()} of ${r.total.toLocaleString()}`}</span>
          <div className="flex gap-1.5">
            <GhostIcon icon={ChevronLeft} label="Newer rows" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} />
            <GhostIcon icon={ChevronRight} label="Older rows" disabled={offset + PAGE >= r.total} onClick={() => setOffset(offset + PAGE)} />
          </div>
        </div>
      )}
    </Card>
  )
}

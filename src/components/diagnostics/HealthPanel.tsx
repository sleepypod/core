'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowDown, ArrowRight, CircleCheck, RotateCw, ScrollText, TriangleAlert, X } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, SectionLabel, Skeleton, StatusDot } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { STAGES, type NodeId } from '@/src/lib/dataPath'
import { LiveStreamTable } from '@/src/components/Sensors/LiveStreamTable'
import { RawFrameDrawer } from '@/src/components/Sensors/RawFrameDrawer'
import { OccupancyCheck } from './OccupancyCheck'
import {
  MAP, STATUS_FILL, STATUS_TONE, STATUS_WORD,
  condenseChecks, edgePath, fitMetric, fmtClockMs, incidentLines, layoutMap, nodeFromSlug, nodeSlug,
} from './healthLogic'
import type { DiagSection } from './DiagnosticsConsole'

type DataPath = inferRouterOutputs<AppRouter>['health']['dataPath']
type DataNode = DataPath['nodes'][number]
type Fix = NonNullable<DataPath['verdict']['fix']>
type History = inferRouterOutputs<AppRouter>['health']['history']

/**
 * System → Health: does data actually move from the sensors to what you see?
 * A one-line verdict with its fix, the data-path map, 24 hours of history per
 * check with incidents in words.
 */
export function HealthPanel({ onJump }: { onJump: (s: DiagSection) => void }) {
  const dataPath = trpc.health.dataPath.useQuery({}, { refetchInterval: 10_000 })
  const history = trpc.health.history.useQuery({}, { refetchInterval: 60_000 })
  const [selected, setSelected] = useSelectedNode()
  const data = dataPath.data
  const cause = data?.verdict.nodeId ?? null
  const inspected = selected && data?.nodes.find(n => n.id === selected)

  return (
    <>
      {dataPath.error && <Card><InlineError>{dataPath.error.message}</InlineError></Card>}
      {data ? <VerdictCard data={data} onJump={onJump} /> : <Skeleton className="h-[74px]" />}

      <Card>
        <CardHeader
          title="Data path"
          subtitle="Sensors to outputs. Select a stage to see what passes through it."
          right={data && <span className="font-mono text-[11px] text-fg-3">{`checked ${fmtClockMs(data.at)}`}</span>}
        />
        {data
          ? <DataPathMap data={data} selected={selected} onSelect={id => setSelected(id === selected ? null : id)} />
          : <Skeleton className="h-[300px] border-0" />}
        {inspected
          ? <NodeInspector node={inspected} isCause={inspected.id === cause} onClose={() => setSelected(null)} />
          : data && cause && <NodeDetail node={data.nodes.find(n => n.id === cause)} isCause />}
      </Card>

      <HistoryCard history={history.data} error={history.error?.message} loading={history.isLoading} />
    </>
  )
}

/** The inspected stage lives in the URL (`node=live-stream`) so links can open it. */
function useSelectedNode() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const selected = nodeFromSlug(searchParams.get('node'))
  const setSelected = useCallback((id: NodeId | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (id) params.set('node', nodeSlug(id))
    else params.delete('node')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])
  return [selected, setSelected] as const
}

// ── Verdict ─────────────────────────────────────────────────────────────────

function VerdictCard({ data, onJump }: { data: DataPath, onJump: (s: DiagSection) => void }) {
  const { verdict } = data
  const Icon = verdict.tone === 'ok' ? CircleCheck : TriangleAlert
  return (
    <Card
      tone={verdict.tone === 'ok' ? undefined : verdict.tone}
      className="flex-row flex-wrap items-center gap-x-4 gap-y-3 py-3.5"
      role="status"
      data-testid="health-verdict"
    >
      <Icon size={18} className={cn('shrink-0', verdict.tone === 'ok' ? 'text-ok' : verdict.tone === 'warn' ? 'text-warn' : 'text-danger')} />
      <div className="flex min-w-0 flex-1 basis-[260px] flex-col gap-0.5">
        <span className="text-[14px] leading-snug text-pretty">{verdict.headline}</span>
        {verdict.also.length > 0 && <span className="text-xs text-fg-2">{`Also: ${verdict.also.join(' · ')}`}</span>}
      </div>
      {verdict.fix && <FixAction fix={verdict.fix} onJump={onJump} />}
    </Card>
  )
}

function FixAction({ fix, onJump }: { fix: Fix, onJump: (s: DiagSection) => void }) {
  const lang = langFromPath(usePathname())
  const router = useRouter()
  const utils = trpc.useUtils()
  const restart = trpc.health.restartService.useMutation({
    onSuccess: () => {
      // Give the module a moment to write before re-checking.
      setTimeout(() => void utils.health.dataPath.invalidate(), 5000)
    },
  })
  const openLogs = (unit: string) => router.push(`/${lang}/system?tab=logs&unit=${encodeURIComponent(unit)}`)

  if (fix.kind === 'link') {
    return <Button icon={ArrowRight} onClick={() => onJump(fix.tab)}>{fix.label}</Button>
  }
  if (fix.kind === 'occupancy') {
    return <OccupancyCheck sides={fix.sides} unit={fix.unit} />
  }
  if (fix.kind === 'logs') {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button icon={ScrollText} onClick={() => openLogs(fix.unit)}>{fix.label}</Button>
        {fix.hint && <span className="font-mono text-[11px] text-fg-2">{fix.hint}</span>}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" icon={ScrollText} onClick={() => openLogs(fix.unit)}>Logs</Button>
        <Button variant="primary" icon={RotateCw} disabled={restart.isPending} onClick={() => restart.mutate({ unit: fix.unit })}>
          {restart.isPending ? 'Restarting…' : fix.label}
        </Button>
      </div>
      {restart.data && (
        <span className={cn('max-w-[420px] text-right text-xs', restart.data.ok ? 'text-ok' : 'font-mono text-warn')}>
          {restart.data.ok ? 'Restarted. Checking again in a few seconds…' : restart.data.message}
        </span>
      )}
      {restart.error && <InlineError className="text-xs">{restart.error.message}</InlineError>}
    </div>
  )
}

// ── Map ─────────────────────────────────────────────────────────────────────

const reducedMotionQuery = '(prefers-reduced-motion: reduce)'
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(reducedMotionQuery)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(reducedMotionQuery).matches,
    () => true,
  )
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

const EDGE_STROKE = { flowing: 'var(--status-ok)', idle: 'var(--border-2)', stalled: 'var(--status-warn)' } as const
const NODE_STROKE = { ok: 'var(--border-2)', idle: 'var(--border-2)', unknown: 'var(--border-2)', stale: 'var(--status-warn)', down: 'var(--status-danger)' } as const
const DOT_FILL = { ok: 'var(--status-ok)', idle: 'var(--text-3)', unknown: 'var(--text-3)', stale: 'var(--status-warn)', down: 'var(--status-danger)' } as const

interface MapProps { data: DataPath, selected: NodeId | null, onSelect: (id: NodeId) => void }

function DataPathMap(props: MapProps) {
  const [ref, width] = useWidth<HTMLDivElement>()
  return (
    <div ref={ref} className="min-w-0">
      {width === 0 ? null : width >= 720 ? <MapSvg {...props} /> : <StackedPath {...props} />}
    </div>
  )
}

function MapSvg({ data, selected, onSelect }: MapProps) {
  const reduced = useReducedMotion()
  const layout = useMemo(() => layoutMap(data.nodes), [data.nodes])
  const at = new Map(layout.placed.map(p => [p.id, p]))
  const byId = new Map(data.nodes.map(n => [n.id, n]))
  const { nodeId: cause, lastGoodId } = data.verdict

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className="block h-auto w-full select-none"
      role="img"
      aria-label={`Data path. ${data.verdict.headline}`}
      data-testid="data-path-map"
    >
      <defs>
        <clipPath id="node-text">
          <rect x={0} y={0} width={MAP.nodeW - 4} height={MAP.nodeH} />
        </clipPath>
      </defs>
      {layout.stageX.map(s => (
        <text key={s.id} x={s.x + 2} y={12} className="fill-fg-2 font-mono text-[10px] uppercase" style={{ letterSpacing: '0.06em' }}>
          {s.label}
        </text>
      ))}

      {data.edges.map((e) => {
        const a = at.get(e.from)
        const b = at.get(e.to)
        if (!a || !b) return null
        const d = edgePath(a, b, layout.laneY)
        const key = `${e.from}-${e.to}`
        const into = selected != null && e.to === selected
        return (
          <g key={key} data-edge={key} data-state={e.state} data-into-selected={into || undefined} opacity={selected && !into ? 0.6 : undefined}>
            <path
              d={d}
              fill="none"
              stroke={EDGE_STROKE[e.state]}
              strokeOpacity={into ? 1 : e.state === 'flowing' ? 0.45 : e.state === 'stalled' ? 0.9 : 1}
              strokeWidth={into ? 2.2 : e.state === 'idle' ? 1 : 1.5}
              strokeDasharray={e.state === 'stalled' ? '4 4' : undefined}
            />
            {e.state === 'flowing' && !reduced && [0, 1].map(k => (
              <circle key={k} r={2.6} fill="var(--status-ok)">
                <animateMotion dur="2.4s" begin={`${-k * 1.2}s`} repeatCount="indefinite" path={d} />
              </circle>
            ))}
          </g>
        )
      })}

      {layout.placed.map((p) => {
        const n = byId.get(p.id)
        if (!n) return null
        const isSelected = p.id === selected
        const isCause = p.id === cause
        return (
          <g
            key={p.id}
            transform={`translate(${p.x},${p.y})`}
            className="cursor-pointer outline-none"
            role="button"
            tabIndex={0}
            aria-label={`${n.label}: ${STATUS_WORD[n.status]}, ${n.metric}`}
            aria-pressed={isSelected}
            onClick={() => onSelect(p.id)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault()
                onSelect(p.id)
              }
            }}
            data-node={p.id}
            data-status={n.status}
          >
            <title>{`${n.label} — ${n.detail}`}</title>
            <rect
              width={MAP.nodeW}
              height={MAP.nodeH}
              rx={8}
              fill="var(--surface-app)"
              stroke={isSelected ? 'var(--text-1)' : NODE_STROKE[n.status]}
              strokeWidth={isSelected ? 1.5 : isCause ? 1.75 : 1}
            />
            <circle cx={13} cy={18} r={3.5} fill={DOT_FILL[n.status]} />
            <g clipPath="url(#node-text)">
              <text x={MAP.textX} y={22} className="fill-fg text-[13px]">{n.label}</text>
              <text x={MAP.textX} y={39} className={cn('font-mono text-[11px]', n.status === 'stale' ? 'fill-warn' : n.status === 'down' ? 'fill-danger' : 'fill-fg-2')}>
                {fitMetric(n.metric)}
              </text>
            </g>
            {p.id === lastGoodId && (
              <text x={MAP.nodeW} y={-5} textAnchor="end" className="fill-fg-3 font-mono text-[9px] uppercase" style={{ letterSpacing: '0.06em' }}>
                last with data
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** Phones: the same stages top to bottom. */
function StackedPath({ data, selected, onSelect }: MapProps) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="data-path-list">
      {STAGES.map((s, i) => (
        <div key={s.id} className="flex flex-col gap-1.5">
          <SectionLabel>{s.label}</SectionLabel>
          {data.nodes.filter(n => n.stage === s.id).map(n => (
            <button
              key={n.id}
              type="button"
              onClick={() => onSelect(n.id)}
              aria-pressed={n.id === selected}
              className={cn(
                'flex min-w-0 cursor-pointer items-center gap-2.5 rounded-ctl border bg-app px-3 py-2 text-left',
                n.status === 'stale' ? 'border-warn-line' : n.status === 'down' ? 'border-danger-line' : n.id === selected ? 'border-fg' : 'border-line-2',
              )}
            >
              <StatusDot tone={STATUS_TONE[n.status]} />
              <span className="min-w-0 flex-1 truncate text-[13px]">{n.label}</span>
              <span className={cn('shrink-0 font-mono text-[11px]', n.status === 'stale' ? 'text-warn' : n.status === 'down' ? 'text-danger' : 'text-fg-2')}>{n.metric}</span>
            </button>
          ))}
          {i < STAGES.length - 1 && <ArrowDown size={13} className="self-center text-fg-3" />}
        </div>
      ))}
    </div>
  )
}

function NodeDetail({ node, isCause }: { node: DataNode | undefined, isCause: boolean }) {
  if (!node) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-[13px]" data-testid="node-detail">
      <StatusDot tone={STATUS_TONE[node.status]} label={STATUS_WORD[node.status].toUpperCase()} mono />
      <span className="font-medium">{node.label}</span>
      <span className="min-w-0 text-fg-2">{node.detail}</span>
      {isCause && <span className="ml-auto font-mono text-[11px] text-fg-3">where the chain breaks</span>}
    </div>
  )
}

/** The selected stage, under the map in place of the "where the chain breaks" line. */
function NodeInspector({ node, isCause, onClose }: { node: DataNode, isCause: boolean, onClose: () => void }) {
  const lang = langFromPath(usePathname())
  const router = useRouter()
  const live = node.id === 'out-live'
  const path = node.path && !node.metric.includes(node.path) ? node.path : null
  const meta = live ? node.path : [STATUS_WORD[node.status], node.metric, path].filter(Boolean).join(' · ')
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4" data-testid="node-inspector" data-node={node.id}>
      <div className="flex items-center gap-2.5">
        <StatusDot tone={STATUS_TONE[node.status]} />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="text-[15px] font-medium">{node.label}</span>
          {meta && <span className="min-w-0 truncate font-mono text-xs text-fg-2">{meta}</span>}
        </div>
        {live && <RawFrameDrawer />}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-ctl border border-line-2 bg-transparent p-0 text-icon hover:bg-active"
        >
          <X size={15} />
        </button>
      </div>
      <p className="text-[13px] text-icon">
        {live ? 'Frames sent to open pages. Changes made on a page go back through tRPC :3000 to the DAC socket.' : node.detail}
      </p>
      {live
        ? <LiveStreamTable />
        : (
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="ghost" icon={ScrollText} onClick={() => router.push(`/${lang}/system?tab=logs&unit=${encodeURIComponent(node.unit ?? 'sleepypod.service')}`)}>
                Logs
              </Button>
              {isCause && <span className="ml-auto font-mono text-[11px] text-fg-3">where the chain breaks</span>}
            </div>
          )}
    </div>
  )
}

// ── History ─────────────────────────────────────────────────────────────────

const LEGEND = [
  { fill: STATUS_FILL.ok, label: 'flowing' },
  { fill: STATUS_FILL.idle, label: 'idle' },
  { fill: STATUS_FILL.stale, label: 'stalled' },
  { fill: STATUS_FILL.down, label: 'down' },
  { fill: 'bg-active ring-1 ring-inset ring-line-2', label: 'not recorded' },
]

function HistoryCard({ history, error, loading }: { history: History | undefined, error?: string, loading: boolean }) {
  const [hover, setHover] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  if (loading) return <Skeleton className="h-[420px]" />
  return (
    <Card data-testid="health-history">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-medium">Last 24 hours</span>
        <span className="text-[13px] text-fg-2">
          {`Each check sampled once a minute.${history?.recordedSince != null ? ` Recording started ${fmtClockMs(history.recordedSince)}.` : ''}`}
        </span>
      </div>
      {error && <InlineError>{error}</InlineError>}
      {history && <HistoryStrips history={history} all={all} onHover={setHover} />}
      <p className="min-h-[18px] font-mono text-[11px] text-fg-2" aria-live="polite">{hover ?? ''}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[11px] text-fg-2">
        {LEGEND.map(l => (
          <span key={l.label} className="flex items-center gap-1.5">
            <span className={cn('block h-2 w-3.5 rounded-[2px]', l.fill)} />
            {l.label}
          </span>
        ))}
        {history && history.checks.length > 1 && (
          <LinkButton className="ml-auto" onClick={() => setAll(v => !v)}>
            {all ? 'Show fewer' : `Show all ${history.checks.length} checks`}
          </LinkButton>
        )}
      </div>
      {history && <IncidentList history={history} />}
    </Card>
  )
}

function LinkButton({ className, ...props }: React.ComponentProps<'button'>) {
  return <button type="button" className={cn('cursor-pointer border-0 bg-transparent p-0 font-sans text-[13px] text-link hover:underline', className)} {...props} />
}

function HistoryStrips({ history, all, onHover }: { history: History, all: boolean, onHover: (s: string | null) => void }) {
  const span = history.to - history.from
  const pct = (t: number) => `${((t - history.from) / span) * 100}%`
  const ticks = [0, 6, 12, 18].map(h => history.from + h * 3_600_000)
  const rows = condenseChecks(history.checks, all)

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(c => (
        <div key={c.key} className="grid grid-cols-[minmax(0,104px)_minmax(0,1fr)_32px] @min-[640px]:grid-cols-[minmax(0,168px)_minmax(0,1fr)_40px] items-center gap-3" data-testid={`history-${c.key}`}>
          <span className={cn('truncate text-xs', c.rest ? 'text-fg-3' : 'text-fg-2')} title={c.label}>{c.label}</span>
          <div className={cn('relative h-2.5 overflow-hidden rounded-[3px] bg-active', c.rest && 'opacity-55')} onMouseLeave={() => onHover(null)}>
            {c.runs.map(r => (
              <span
                key={r.start}
                className={cn('absolute inset-y-0 border-r-2 border-surface last:border-r-0', STATUS_FILL[r.status])}
                style={{ left: pct(r.start), width: `max(2px, calc(${pct(r.end)} - ${pct(r.start)}))` }}
                onMouseEnter={() => onHover(`${c.label} · ${STATUS_WORD[r.status]} · ${fmtClockMs(r.start)} – ${r.end >= history.to - 90_000 ? 'now' : fmtClockMs(r.end)}`)}
              />
            ))}
          </div>
          <span className={cn('text-right font-mono text-[11px]', c.incidents > 0 ? 'text-warn' : 'text-fg-3')}>
            {c.rest ? '0×' : c.healthyShare == null ? '—' : c.incidents > 0 ? `${c.incidents}×` : `${Math.floor(c.healthyShare * 100)}%`}
          </span>
        </div>
      ))}
      <div className="grid grid-cols-[minmax(0,104px)_minmax(0,1fr)_32px] @min-[640px]:grid-cols-[minmax(0,168px)_minmax(0,1fr)_40px] gap-3">
        <span />
        <div className="relative h-4 font-mono text-[10px] text-fg-3">
          {ticks.map((t, i) => (
            <span key={t} className={cn('absolute whitespace-nowrap', i > 0 && '-translate-x-1/2', i % 2 === 1 && 'hidden @min-[640px]:inline')} style={{ left: pct(t) }}>{fmtClockMs(t)}</span>
          ))}
          <span className="absolute right-0">now</span>
        </div>
        <span />
      </div>
    </div>
  )
}

const RECENT_INCIDENTS = 3

function IncidentList({ history }: { history: History }) {
  const [all, setAll] = useState(false)
  const lines = incidentLines(history, history.to)
  const earlier = lines.length - RECENT_INCIDENTS
  const shown = all ? lines : lines.slice(0, RECENT_INCIDENTS)
  return (
    <div className="flex flex-col border-t border-line pt-3" data-testid="incidents">
      <SectionLabel
        className="pb-1.5"
        right={earlier > 0 && <LinkButton onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show ${earlier} earlier`}</LinkButton>}
      >
        Incidents
      </SectionLabel>
      {lines.length === 0
        ? <p className="text-[13px] text-fg-2">No incidents in the last 24 hours.</p>
        : shown.map(l => (
            <div key={l.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-line py-2 first-of-type:border-t-0">
              <StatusDot tone={l.tone} className="self-center" />
              <span className="text-[13px] font-medium">{l.title}</span>
              <span className="font-mono text-[11px] text-fg-2">{l.when}</span>
              {l.tag && (
                <span className={cn('rounded-tag border px-1.5 font-mono text-[10px] uppercase', l.tag === 'blip' ? 'border-line-2 text-fg-2' : 'border-warn-line text-warn')}>
                  {l.tag}
                </span>
              )}
              {l.detail && <span className="basis-full pl-4 text-xs text-fg-2">{l.detail}</span>}
            </div>
          ))}
    </div>
  )
}

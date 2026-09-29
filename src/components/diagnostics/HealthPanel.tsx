'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ArrowDown, ArrowRight, CircleCheck, RotateCw, ScrollText, TriangleAlert } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { Button, Card, CardHeader, InlineError, SectionLabel, Skeleton, StatusDot } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { STAGES, type NodeId } from '@/src/lib/dataPath'
import { OccupancyCheck } from './OccupancyCheck'
import {
  MAP, STATUS_FILL, STATUS_TONE, STATUS_WORD,
  edgePath, fmtClockMs, incidentLines, layoutMap,
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
  const [selected, setSelected] = useState<NodeId | null>(null)
  const data = dataPath.data
  const focus = selected ?? data?.verdict.nodeId ?? null

  return (
    <>
      {dataPath.error && <Card><InlineError>{dataPath.error.message}</InlineError></Card>}
      {data ? <VerdictCard data={data} onJump={onJump} /> : <Skeleton className="h-[74px]" />}

      <Card>
        <CardHeader
          title="Data path"
          subtitle="Sensors to outputs. A moving link means data passed through it in the last few minutes."
          right={data && <span className="font-mono text-[11px] text-fg-3">{`checked ${fmtClockMs(data.at)}`}</span>}
        />
        {data ? <DataPathMap data={data} focus={focus} onSelect={setSelected} /> : <Skeleton className="h-[300px] border-0" />}
        {data && focus && <NodeDetail node={data.nodes.find(n => n.id === focus)} isCause={focus === data.verdict.nodeId} />}
      </Card>

      <HistoryCard history={history.data} error={history.error?.message} loading={history.isLoading} />
    </>
  )
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

function DataPathMap({ data, focus, onSelect }: { data: DataPath, focus: NodeId | null, onSelect: (id: NodeId) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  return (
    <div ref={ref} className="min-w-0">
      {width === 0 ? null : width >= 720 ? <MapSvg data={data} focus={focus} onSelect={onSelect} /> : <StackedPath data={data} focus={focus} onSelect={onSelect} />}
    </div>
  )
}

function MapSvg({ data, focus, onSelect }: { data: DataPath, focus: NodeId | null, onSelect: (id: NodeId) => void }) {
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
        return (
          <g key={key} data-edge={key} data-state={e.state}>
            <path
              d={d}
              fill="none"
              stroke={EDGE_STROKE[e.state]}
              strokeOpacity={e.state === 'flowing' ? 0.45 : e.state === 'stalled' ? 0.9 : 1}
              strokeWidth={e.state === 'idle' ? 1 : 1.5}
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
        const isFocus = p.id === focus
        const isCause = p.id === cause
        return (
          <g
            key={p.id}
            transform={`translate(${p.x},${p.y})`}
            className="cursor-pointer outline-none"
            role="button"
            tabIndex={0}
            aria-label={`${n.label}: ${STATUS_WORD[n.status]}, ${n.metric}`}
            aria-pressed={isFocus}
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
              stroke={isFocus && !isCause ? 'var(--text-2)' : NODE_STROKE[n.status]}
              strokeWidth={isCause || isFocus ? 1.75 : 1}
            />
            <circle cx={14} cy={18} r={3.5} fill={DOT_FILL[n.status]} />
            <text x={25} y={22} className="fill-fg text-[13px]">{n.label}</text>
            <text x={12} y={39} className={cn('font-mono text-[11px]', n.status === 'stale' ? 'fill-warn' : n.status === 'down' ? 'fill-danger' : 'fill-fg-2')}>
              {n.metric.length > 22 ? `${n.metric.slice(0, 21)}…` : n.metric}
            </text>
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
function StackedPath({ data, focus, onSelect }: { data: DataPath, focus: NodeId | null, onSelect: (id: NodeId) => void }) {
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
              aria-pressed={n.id === focus}
              className={cn(
                'flex min-w-0 cursor-pointer items-center gap-2.5 rounded-ctl border bg-app px-3 py-2 text-left',
                n.status === 'stale' ? 'border-warn-line' : n.status === 'down' ? 'border-danger-line' : n.id === focus ? 'border-fg-3' : 'border-line-2',
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
  if (loading) return <Skeleton className="h-[420px]" />
  return (
    <Card data-testid="health-history">
      <CardHeader
        title="Last 24 hours"
        subtitle="Each check sampled once a minute. A short blip and a problem that keeps coming back look different here."
      />
      {error && <InlineError>{error}</InlineError>}
      {history && <HistoryStrips history={history} onHover={setHover} />}
      <p className="min-h-[18px] font-mono text-[11px] text-fg-2" aria-live="polite">{hover ?? ''}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 font-mono text-[11px] text-fg-2">
        {LEGEND.map(l => (
          <span key={l.label} className="flex items-center gap-1.5">
            <span className={cn('block h-2 w-3.5 rounded-[2px]', l.fill)} />
            {l.label}
          </span>
        ))}
      </div>
      {history && <IncidentList history={history} />}
    </Card>
  )
}

function HistoryStrips({ history, onHover }: { history: History, onHover: (s: string | null) => void }) {
  const span = history.to - history.from
  const pct = (t: number) => `${((t - history.from) / span) * 100}%`
  const ticks = [0, 6, 12, 18].map(h => history.from + h * 3_600_000)
  const late = history.recordedSince != null && history.recordedSince > history.from + 10 * 60_000

  return (
    <div className="flex flex-col gap-1.5">
      {late && (
        <p className="text-xs text-fg-2">{`Recording started ${fmtClockMs(history.recordedSince as number)}; earlier hours have no history yet.`}</p>
      )}
      {history.checks.map(c => (
        <div key={c.id} className="grid grid-cols-[minmax(0,128px)_minmax(0,1fr)_52px] items-center gap-3" data-testid={`history-${c.id}`}>
          <span className="truncate text-xs text-fg-2">{c.label}</span>
          <div className="relative h-2.5 overflow-hidden rounded-[3px] bg-active" onMouseLeave={() => onHover(null)}>
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
            {c.healthyShare == null ? '—' : c.incidents > 0 ? `${c.incidents}×` : `${Math.floor(c.healthyShare * 100)}%`}
          </span>
        </div>
      ))}
      <div className="grid grid-cols-[minmax(0,128px)_minmax(0,1fr)_52px] gap-3">
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

function IncidentList({ history }: { history: History }) {
  const lines = incidentLines(history, history.to)
  return (
    <div className="flex flex-col border-t border-line pt-3" data-testid="incidents">
      <SectionLabel className="pb-1.5">Incidents</SectionLabel>
      {lines.length === 0
        ? <p className="text-[13px] text-fg-2">No incidents in the last 24 hours.</p>
        : lines.map(l => (
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

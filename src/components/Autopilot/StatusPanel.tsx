/**
 * Diagnostics / status panel — live Autopilot state and the audit trail. Global
 * kill-switch, then one card per rule: mode (Off / Dry-run / Live), the rule in
 * plain English, four stats that keep "last evaluated" apart from "fired", a
 * last-3-hours strip with one tick per minute, and today's run log with
 * repeats collapsed — the transparency Eight Sleep's black box lacks.
 */
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMemo, useState } from 'react'
import type { Action, Condition, Trigger } from '@/src/automation/types'
import { HoverMark, SegmentedControl, useHoverFraction } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { Icon } from './icons'
import { Card, SideBadge, Toggle } from './primitives'
import { buildSentence, fromAST, SIGNALS } from './builderModel'
import {
  buildStrip, cadenceText, filterCounts, filterOf, groupLog, lastVerdict, missingTicks, thresholds, toMs,
  type EvalRun, type LogFilter, type LogGroup, type Strip, type TickKind,
} from './evaluationStrip'

/** Hours of history the strip shows. */
export const STRIP_HOURS = 3

export type RuleMode = 'off' | 'dryrun' | 'live'

export interface DiagRule {
  id: number
  name: string
  enabled: boolean
  dryRun: boolean
  side: 'left' | 'right' | null
  priority: number
  cooldownMin: number | null
  trigger: Trigger
  conditions: Condition
  actions: Action[]
  runs: EvalRun[]
  /** Live value of each signal the condition reads (null = unavailable). */
  signals: Record<string, number | null>
}

export interface Diagnostics {
  now: Date | string
  startOfDay: Date | string
  globalEnabled: boolean
  rules: DiagRule[]
}

function ago(ms: number | null, now: number): string {
  if (ms == null) return 'never'
  const d = now - ms
  if (d < 60_000) return 'just now'
  const m = Math.floor(d / 60_000)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function hhmm(ms: number): string {
  const x = new Date(ms)
  return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`
}

function ruleMode(r: Pick<DiagRule, 'enabled' | 'dryRun'>): RuleMode {
  if (!r.enabled) return 'off'
  return r.dryRun ? 'dryrun' : 'live'
}

function signalMeta(key: string): { label: string, unit: string } {
  const templ = key.replace(/^(left|right)\./, '{side}.')
  const def = SIGNALS.find(s => s.id === templ || s.id === key)
  const side = /^(left|right)\./.exec(key)?.[1]
  const label = (def?.label ?? key).toLowerCase()
  return { label: side ? `${side} ${label}` : label, unit: def?.unit ?? '' }
}

function fmtVal(v: number, unit: string): string {
  const n = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10
  return `${n}${unit}`
}

/** "ambient temp 72.3°F now, needs > 75°F" — live reading beside the threshold it's checked against. */
function conditionDetail(r: DiagRule): string {
  const [t] = thresholds(r.conditions)
  if (!t) return 'no threshold'
  const { label, unit } = signalMeta(t.signal)
  const live = r.signals[t.signal]
  const needs = `needs ${t.op} ${fmtVal(t.value, unit)}${t.window ? ` (${t.window.lastMin}-min ${t.window.fn})` : ''}`
  return `${label} ${live == null ? 'unavailable' : `${fmtVal(live, unit)} now`}, ${needs}`
}

// ── Strip ────────────────────────────────────────────────────────────────────

const TICK_CLASS: Record<TickKind, string> = {
  none: '',
  skipped: 'bg-fg-3/45',
  cooldown: '',
  would: 'bg-warn',
  fired: 'bg-ok',
  error: 'bg-danger',
  missing: 'border border-danger',
}

const TICK_LABEL: Record<TickKind, string> = {
  none: 'no tick',
  skipped: 'skipped',
  cooldown: 'cooldown',
  would: 'would fire (dry-run)',
  fired: 'fired',
  error: 'error',
  missing: 'no evaluation logged',
}

function EvaluationStrip({ strip, nowMs, cooldownMin }: { strip: Strip, nowMs: number, cooldownMin: number | null }) {
  const span = strip.endMs - strip.startMs
  const pct = (ms: number) => `${((ms - strip.startMs) / span) * 100}%`
  const n = strip.ticks.length
  const hover = useHoverFraction()
  const hoverIdx = hover.frac === null || n === 0 ? null : Math.min(n - 1, Math.floor(hover.frac * n))

  const hours: number[] = []
  const first = new Date(strip.startMs)
  first.setMinutes(0, 0, 0)
  for (let t = first.getTime() + 3_600_000; t < strip.endMs; t += 3_600_000) hours.push(t)

  // Label the most recent action the strip shows.
  let marker: { i: number, kind: 'would' | 'fired' } | null = null
  for (let i = n - 1; i >= 0; i--) {
    const k = strip.ticks[i]
    if (k === 'would' || k === 'fired') {
      marker = { i, kind: k }
      break
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative h-4 font-mono text-[11px]">
        {marker && (
          <span
            className={cn('absolute bottom-0 -translate-x-1/2 whitespace-nowrap', marker.kind === 'fired' ? 'text-ok' : 'text-warn')}
            style={{ left: `${((marker.i + 0.5) / n) * 100}%` }}
          >
            {marker.kind === 'fired' ? 'fired' : 'would fire'}
            {' · '}
            {clock(strip.startMs + marker.i * 60_000)}
          </span>
        )}
        <span className="absolute right-0 bottom-0 text-fg-2">now</span>
      </div>
      <div
        className="relative h-7"
        role="img"
        aria-label={`Evaluations over the last ${STRIP_HOURS} hours`}
        data-testid="evaluation-strip"
        onPointerMove={hover.onPointerMove}
        onPointerLeave={hover.onPointerLeave}
      >
        <div className="absolute inset-0 flex">
          {strip.ticks.map((k, i) => (
            <div key={i} className="flex h-full min-w-0 flex-1 justify-center">
              {k !== 'none' && k !== 'cooldown' && (
                <div className={cn('h-full w-[60%] max-w-[3px] min-w-px rounded-[1px]', TICK_CLASS[k])} />
              )}
            </div>
          ))}
        </div>
        {strip.cooldowns.map(([a, b]) => {
          const mins = b - a + 1
          return (
            <div
              key={a}
              className="absolute inset-y-0 flex items-center overflow-hidden rounded-[2px] bg-active px-2 font-mono text-[11px] whitespace-nowrap text-fg-3"
              style={{ left: `${(a / n) * 100}%`, width: `${(mins / n) * 100}%` }}
              title={`cooldown ${mins} min`}
            >
              {`cooldown ${cooldownMin ?? mins} min`}
            </div>
          )
        })}
        <div className="absolute -top-1 -bottom-1 w-px bg-fg-2" style={{ left: pct(nowMs) }} />
        {hoverIdx !== null && (
          <HoverMark
            pct={((hoverIdx + 0.5) / n) * 100}
            label={`${clock(strip.startMs + hoverIdx * 60_000)} · ${TICK_LABEL[strip.ticks[hoverIdx]]}`}
            className="-top-1 -bottom-1"
          />
        )}
      </div>
      <div className="relative h-4 font-mono text-[11px] text-fg-3">
        {hours.map(t => (
          <span key={t} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: pct(t) }}>
            {new Date(t).toLocaleTimeString([], { hour: 'numeric' })}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-fg-2">
        <Legend swatch="bg-fg-3/45">skipped</Legend>
        <Legend swatch="bg-warn">would fire (dry-run)</Legend>
        <Legend swatch="bg-ok">fired</Legend>
        <Legend swatch="bg-active w-3">cooldown</Legend>
        <Legend swatch="border border-danger">no evaluation logged</Legend>
      </div>
    </div>
  )
}

function Legend({ swatch, children }: { swatch: string, children: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('h-3 w-[3px] rounded-[1px]', swatch)} />
      {children}
    </span>
  )
}

// ── Stats ────────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, tone }: { label: string, value: string, sub: string, tone?: 'muted' | 'warn' | 'ok' | 'danger' }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px] text-fg-2">{label}</span>
      <span className={cn(
        'font-mono text-[17px] leading-6',
        tone === 'muted' ? 'text-fg-2' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-fg',
      )}
      >
        {value}
      </span>
      <span className="truncate font-mono text-[11px] text-fg-3" title={sub}>{sub}</span>
    </div>
  )
}

// ── Run log ──────────────────────────────────────────────────────────────────

const LOG_BADGE: Record<LogGroup['kind'], { text: string, cls: string }> = {
  skipped: { text: 'SKIPPED', cls: 'border-line-2 text-fg-2' },
  cooldown: { text: 'COOLDOWN', cls: 'border-line-2 text-fg-2' },
  would: { text: 'WOULD FIRE', cls: 'border-warn-line text-warn' },
  fired: { text: 'FIRED', cls: 'border-ok-line text-ok' },
  error: { text: 'ERROR', cls: 'border-danger-line text-danger' },
  missing: { text: 'MISSING', cls: 'border-danger-line text-danger' },
}

function groupTime(g: LogGroup): string {
  if (g.count === 1) return hhmm(g.firstMs)
  if (g.count === 2) return `${hhmm(g.firstMs)}, ${hhmm(g.lastMs)}`
  return `${hhmm(g.firstMs)} – ${hhmm(g.lastMs)}`
}

function groupText(g: LogGroup, cooldownMin: number | null): string {
  switch (g.kind) {
    case 'missing': return 'no evaluation logged'
    case 'cooldown': return `condition true, held by the ${cooldownMin ?? '?'} min cooldown`
    case 'would': return 'dry run · would have acted'
    case 'fired': return g.sent ? `${g.sent} live action${g.sent === 1 ? '' : 's'} sent` : 'fired · no command needed'
    case 'error': return (g.reason ?? 'error').replace(/-/g, ' ')
    default: return (g.reason ?? 'actions gated out').replace(/-/g, ' ')
  }
}

const FILTERS: Array<{ id: LogFilter, label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'would', label: 'Would fire' },
  { id: 'fired', label: 'Fired' },
  { id: 'skipped', label: 'Skipped' },
  { id: 'missing', label: 'Missing' },
]

function RunLog({ groups, cooldownMin }: { groups: LogGroup[], cooldownMin: number | null }) {
  const [filter, setFilter] = useState<LogFilter>('all')
  const counts = filterCounts(groups)
  const shown = filter === 'all' ? groups : groups.filter(g => filterOf(g.kind) === filter)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[15px] font-medium text-fg">Run log</span>
        <span className="font-mono text-[12px] text-fg-3">today · repeats grouped</span>
        <div className="flex flex-wrap gap-1.5 min-[640px]:ml-auto" role="group" aria-label="Filter run log">
          {FILTERS.map(f => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-ctl border px-2.5 py-1 text-[12px] transition-colors',
                filter === f.id ? 'border-line-2 bg-active text-fg' : 'border-line text-fg-2 hover:bg-active',
              )}
            >
              {f.label}
              <span className="font-mono text-fg-3">{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[360px] overflow-auto">
        {shown.length === 0 && <div className="py-6 text-center text-[13px] text-fg-3">Nothing logged today.</div>}
        {shown.map(g => (
          <div key={`${g.kind}-${g.lastMs}`} className="grid grid-cols-[minmax(96px,auto)_auto_1fr] items-center gap-x-3 border-t border-line py-2.5 min-[640px]:grid-cols-[140px_170px_1fr]">
            <span className="font-mono text-[12px] text-fg">{groupTime(g)}</span>
            <span className="flex items-center gap-2">
              <span className={cn('rounded-tag border px-1.5 font-mono text-[11px] leading-[18px] tracking-[0.06em]', LOG_BADGE[g.kind].cls)}>{LOG_BADGE[g.kind].text}</span>
              {g.count > 1 && (
                <span className="font-mono text-[12px] text-fg-3">
                  ×
                  {g.count}
                </span>
              )}
            </span>
            <span className="col-span-3 truncate font-mono text-[12px] text-fg-2 min-[640px]:col-span-1">{groupText(g, cooldownMin)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Rule card ────────────────────────────────────────────────────────────────

function RuleDiagCard({ r, nowMs, startOfDayMs, globalEnabled, onMode }: {
  r: DiagRule
  nowMs: number
  startOfDayMs: number
  globalEnabled: boolean
  onMode: (id: number, mode: RuleMode) => void
}) {
  const lang = usePathname()?.split('/')[1] || 'en'
  const mode = ruleMode(r)
  const expectMissing = r.enabled && globalEnabled

  const derived = useMemo(() => {
    const strip = buildStrip(r.runs, r.trigger, nowMs, STRIP_HOURS, expectMissing)
    const today = r.runs.filter(x => toMs(x.t) >= startOfDayMs)
    const missing = expectMissing ? missingTicks(r.runs, r.trigger, startOfDayMs, nowMs) : []
    const groups = groupLog(today, missing)
    const last = r.runs.at(-1)
    const would = today.filter(x => x.outcome === 'dry_run')
    const fired = today.filter(x => x.outcome === 'fired' || x.outcome === 'clamped')
    return {
      strip,
      groups,
      last,
      wouldCount: would.length,
      lastWould: would.at(-1),
      firedCount: fired.length,
      sentCount: today.filter(x => x.sent).length,
    }
  }, [r.runs, r.trigger, nowMs, startOfDayMs, expectMissing])

  const sentence = useMemo(() => buildSentence(fromAST(r)), [r])
  const verdict = lastVerdict(derived.last)
  const lastMs = derived.last ? toMs(derived.last.t) : null

  return (
    <Card className="flex flex-col gap-4 px-[18px] py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href={`/${lang}/autopilot/${r.id}`} className="truncate text-[15px] font-medium text-fg no-underline hover:underline">
          {r.name}
        </Link>
        <SideBadge side={r.side} />
        <div className="ml-auto flex items-center gap-2.5">
          <span className="text-[12px] text-fg-2">Mode</span>
          <SegmentedControl
            ariaLabel={`${r.name} mode`}
            size="sm"
            value={mode}
            onChange={m => onMode(r.id, m)}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'dryrun', label: <span className={mode === 'dryrun' ? 'text-warn' : undefined}>Dry-run</span> },
              { value: 'live', label: <span className={mode === 'live' ? 'text-ok' : undefined}>Live</span> },
            ]}
          />
        </div>
      </div>

      <p className="text-[13px] leading-5 text-fg-2">
        {sentence.map((c, i) => (
          <span key={i} className={cn(c.hot && 'font-mono text-fg')}>{c.text}</span>
        ))}
      </p>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-line py-3.5 min-[760px]:grid-cols-4">
        <Stat
          label="Last evaluated"
          value={ago(lastMs, nowMs)}
          sub={`${lastMs != null ? `${clock(lastMs)} · ` : ''}${cadenceText(r.trigger)}`}
          tone={lastMs == null ? 'muted' : undefined}
        />
        <Stat
          label="Condition"
          value={verdict ?? '—'}
          sub={conditionDetail(r)}
          tone={verdict === 'true' ? 'ok' : verdict === 'error' ? 'danger' : 'muted'}
        />
        <Stat
          label="Would have fired today"
          value={String(derived.wouldCount)}
          sub={derived.lastWould ? `${clock(toMs(derived.lastWould.t))} · dry-run` : 'dry-run'}
          tone={derived.wouldCount ? 'warn' : undefined}
        />
        <Stat
          label="Fired today"
          value={String(derived.firedCount)}
          sub={`${derived.sentCount} live action${derived.sentCount === 1 ? '' : 's'} sent`}
          tone={derived.firedCount ? 'ok' : undefined}
        />
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[14px] font-medium text-fg">Evaluations</span>
          <span className="font-mono text-[12px] text-fg-3">
            {`last ${STRIP_HOURS} hours · one tick per minute`}
          </span>
        </div>
        <EvaluationStrip strip={derived.strip} nowMs={nowMs} cooldownMin={r.cooldownMin} />
      </div>

      <RunLog groups={derived.groups} cooldownMin={r.cooldownMin} />
    </Card>
  )
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function StatusPanel({ data, loading, onKill, onMode }: {
  data: Diagnostics | undefined
  loading: boolean
  onKill: (enabled: boolean) => void
  onMode: (id: number, mode: RuleMode) => void
}) {
  const globalEnabled = data?.globalEnabled ?? true
  const killed = !globalEnabled
  const nowMs = data ? toMs(data.now) : 0
  const startOfDayMs = data ? toMs(data.startOfDay) : 0
  const dry = data?.rules.filter(r => r.enabled && r.dryRun).length ?? 0

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card className={cn('flex items-center gap-3 px-[18px] py-3.5', killed && 'border-danger-line')}>
        <Icon.Power size={16} className={killed ? 'text-danger' : 'text-icon'} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{killed ? 'Autopilot halted' : 'Autopilot running'}</div>
          <div className={cn('font-mono text-[12px]', killed ? 'text-fg-2' : 'text-ok')}>
            {killed ? 'all rules suspended' : `running · ${dry} rule${dry === 1 ? '' : 's'} in dry-run`}
          </div>
        </div>
        <Toggle size="md" label="Autopilot enabled" checked={!killed} onChange={() => onKill(killed)} />
      </Card>

      {killed && (
        <div className="flex items-center gap-2 rounded-ctl border border-danger-line px-4 py-2.5 text-[13px] text-danger">
          <Icon.AlertTri size={15} className="shrink-0" />
          Kill-switch engaged — no rule will command hardware. Manual control only.
        </div>
      )}
      {loading || !data
        ? <div className="py-16 text-center text-[13px] text-fg-3">Loading status…</div>
        : data.rules.length === 0
          ? <div className="py-16 text-center text-[13px] text-fg-3">No automations yet.</div>
          : data.rules.map(r => (
              <RuleDiagCard
                key={r.id}
                r={r}
                nowMs={nowMs}
                startOfDayMs={startOfDayMs}
                globalEnabled={globalEnabled}
                onMode={onMode}
              />
            ))}
    </div>
  )
}

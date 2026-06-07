/**
 * Diagnostics / status panel — live Autopilot state and the audit trail. Global
 * kill-switch, a per-rule card (status, last fire, fires today, dry-run toggle),
 * and the run log: every evaluation that mattered, which is the transparency
 * Eight Sleep's black box lacks.
 */
'use client'

import { Icon } from './icons'
import { Badge, Card, SideBadge, StatusBadge, Toggle } from './primitives'

export interface RuleStatus {
  id: number
  name: string
  enabled: boolean
  dryRun: boolean
  side: 'left' | 'right' | null
  cooldownMin: number | null
  lastOutcome: string | null
  lastFiredAt: Date | string | null
  firesToday: number
}

export interface RunRow {
  id: number
  automationId: number
  ruleName: string | null
  firedAt: Date | string
  outcome: 'fired' | 'skipped' | 'clamped' | 'dry_run' | 'error'
  detail: unknown
}

function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d)
}

function ago(d: Date | string | null): string {
  if (!d) return 'never'
  const ms = Date.now() - toDate(d).getTime()
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function hhmm(d: Date | string): string {
  const x = toDate(d)
  return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`
}

function statusMode(r: RuleStatus): 'active' | 'dryrun' | 'paused' {
  if (!r.enabled) return 'paused'
  return r.dryRun ? 'dryrun' : 'active'
}

function verdictTone(v: RunRow['outcome']): 'red' | 'zinc' | 'amber' {
  if (v === 'fired' || v === 'clamped') return 'red'
  if (v === 'dry_run') return 'amber'
  return 'zinc'
}

interface ActionDetail { kind?: string, side?: string, temp?: number, on?: boolean, sent?: boolean, dryRun?: boolean, clamped?: boolean, antiThrash?: boolean, skipped?: string, notified?: boolean }
function actionText(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return ''
  const d = detail as { actions?: ActionDetail[], reason?: string }
  if (d.reason) return d.reason.replace(/-/g, ' ')
  const a = d.actions?.[0]
  if (!a) return ''
  if (a.kind === 'notify') return 'notify'
  if (a.kind === 'setPower') return `power ${a.on ? 'on' : 'off'}`
  if (a.kind === 'setTemperature') {
    if (a.skipped) return a.skipped.replace(/-/g, ' ')
    const verb = a.sent ? 'set' : a.dryRun ? 'would set' : a.antiThrash ? 'held' : 'set'
    return a.temp != null ? `${verb} ${Math.round(a.temp)}°F${a.clamped ? ' (clamped)' : ''}` : verb
  }
  return a.kind ?? ''
}

function RuleStatusCard({ a, onDry }: { a: RuleStatus, onDry: (id: number, dryRun: boolean) => void }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-zinc-100">{a.name}</span>
            <SideBadge side={a.side} />
          </div>
          <div className="mt-1"><StatusBadge mode={statusMode(a)} /></div>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-zinc-500 shrink-0">
          <Toggle size="sm" checked={a.dryRun} onChange={() => onDry(a.id, !a.dryRun)} />
          dry-run
        </label>
      </div>

      <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/50 p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] uppercase tracking-[0.1em] text-zinc-500">Last outcome</span>
          <span className="mono text-[13px] text-zinc-300">{a.lastOutcome ?? '—'}</span>
        </div>
        <div className="mt-1 text-[11px] text-zinc-500">{a.cooldownMin ? `cooldown ${a.cooldownMin}m` : 'no cooldown'}</div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 text-[12px]">
        <div>
          <div className="text-[10px] uppercase tracking-[0.1em] text-zinc-600">Last fired</div>
          <div className="mono text-zinc-300">{ago(a.lastFiredAt)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.1em] text-zinc-600">Today</div>
          <div className="mono text-zinc-300">
            {a.firesToday}
            {' '}
            fire
            {a.firesToday === 1 ? '' : 's'}
          </div>
        </div>
      </div>
    </Card>
  )
}

function RunLog({ runs }: { runs: RunRow[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon.List size={14} className="text-zinc-500" />
          <span className="text-[13px] font-medium text-zinc-200">Run log</span>
          <span className="text-[11px] text-zinc-600">every evaluation that mattered</span>
        </div>
        <Badge tone="zinc">audit trail</Badge>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-zinc-950/90 backdrop-blur">
            <tr className="text-[10px] uppercase tracking-[0.1em] text-zinc-600">
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-2 py-2 font-medium">Rule</th>
              <th className="px-2 py-2 font-medium">Verdict</th>
              <th className="px-4 py-2 font-medium">Action / reason</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-[12px] text-zinc-600">No evaluations recorded yet.</td></tr>
            )}
            {runs.map(r => (
              <tr key={r.id} className="border-t border-zinc-800/50 hover:bg-zinc-900/40">
                <td className="px-4 py-2.5 mono text-[12px] text-zinc-400 whitespace-nowrap">{hhmm(r.firedAt)}</td>
                <td className="px-2 py-2.5 text-[12px] text-zinc-200">{r.ruleName ?? `#${r.automationId}`}</td>
                <td className="px-2 py-2.5"><Badge tone={verdictTone(r.outcome)} dot={r.outcome === 'fired'}>{r.outcome.replace('_', '-')}</Badge></td>
                <td className="px-4 py-2.5 mono text-[12px] whitespace-nowrap" style={{ color: r.outcome === 'fired' ? 'var(--accent)' : '#71717a' }}>{actionText(r.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export function StatusPanel({ globalEnabled, onKill, rules, runs, loading, onDry }: {
  globalEnabled: boolean
  onKill: (enabled: boolean) => void
  rules: RuleStatus[]
  runs: RunRow[]
  loading: boolean
  onDry: (id: number, dryRun: boolean) => void
}) {
  const killed = !globalEnabled
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-zinc-800 px-5 py-4">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight text-zinc-100">Diagnostics</h1>
          <p className="text-[12px] text-zinc-500 mt-0.5">Live Autopilot state &amp; audit trail</p>
        </div>
        <div className={`flex items-center gap-3 rounded-xl border px-3.5 py-2 ${killed ? 'border-red-500/40 bg-red-500/10' : 'border-zinc-800 bg-zinc-900/50'}`}>
          <Icon.Power size={16} className={killed ? 'text-red-400' : 'text-zinc-400'} />
          <div className="leading-tight">
            <div className="text-[12px] font-medium text-zinc-200">{killed ? 'Autopilot halted' : 'Autopilot running'}</div>
            <div className="text-[10px] text-zinc-500">{killed ? 'all rules suspended' : 'global kill-switch'}</div>
          </div>
          <Toggle checked={!killed} onChange={() => onKill(killed)} tone={killed ? 'red' : 'accent'} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-6xl">
          {killed && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-[13px] text-red-300">
              <Icon.AlertTri size={15} />
              Kill-switch engaged — no rule will command hardware. Manual control only.
            </div>
          )}
          {loading
            ? <div className="py-16 text-center text-[13px] text-zinc-600">Loading status…</div>
            : (
                <>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 mb-5">
                    {rules.map(a => <RuleStatusCard key={a.id} a={a} onDry={onDry} />)}
                  </div>
                  <RunLog runs={runs} />
                </>
              )}
        </div>
      </div>
    </div>
  )
}

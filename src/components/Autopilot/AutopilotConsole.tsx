/** Autopilot's automation editor, live engine state, and audit trail. */
'use client'

import { useMemo, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { AutomationsList, type ListItem } from './AutomationsList'
import { RuleEditor } from './RuleEditor'
import { RuleStatusCard, RunLog } from './StatusPanel'
import { Button } from './primitives'
import { Icon } from './icons'
import { type BuilderRule, blankRule, fromAST, toAST } from './builderModel'

const ACCENT = '#0c87c2'

// Scoped styles ported from the design HTML: mono face, slim scrollbars, the
// modal fade, and the accent default — confined to `.ap-console`.
const SCOPED_CSS = `
.ap-console { --accent: ${ACCENT}; }
.ap-console .mono { font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace; font-feature-settings: 'tnum'; }
.ap-console .tabular-nums { font-variant-numeric: tabular-nums; }
.ap-console *::-webkit-scrollbar { width: 10px; height: 10px; }
.ap-console *::-webkit-scrollbar-track { background: transparent; }
.ap-console *::-webkit-scrollbar-thumb { background: #27272a; border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
.ap-console input::placeholder { color: #52525b; }
@keyframes apFade { from { opacity: 0; transform: scale(0.99); } to { opacity: 1; transform: none; } }
`

/** Combine automation editing, live engine state, and the audit trail in one page. */
export function AutopilotConsole() {
  const utils = trpc.useUtils()
  const [tab, setTab] = useState<'Rules' | 'Live' | 'Activity'>('Rules')
  const [editing, setEditing] = useState<BuilderRule | null>(null)

  const listQ = trpc.automations.list.useQuery({})
  const statusQ = trpc.automations.status.useQuery({}, { refetchInterval: 15000 })
  const runsQ = trpc.automations.runs.useQuery({ limit: 100 }, { refetchInterval: 15000 })

  const invalidate = () => {
    void utils.automations.list.invalidate()
    void utils.automations.status.invalidate()
    void utils.automations.runs.invalidate()
  }

  const createM = trpc.automations.create.useMutation({ onSuccess: invalidate })
  const updateM = trpc.automations.update.useMutation({ onSuccess: invalidate })
  const setEnabledM = trpc.automations.setEnabled.useMutation({ onSuccess: invalidate })
  const setDryRunM = trpc.automations.setDryRun.useMutation({ onSuccess: invalidate })
  const killM = trpc.automations.setKillSwitch.useMutation({ onSuccess: () => {
    void utils.automations.status.invalidate()
    void utils.automations.getKillSwitch.invalidate()
  } })

  // Build list items from the rule rows + the status map (last-fired/today).
  const items: ListItem[] = useMemo(() => {
    const rows = listQ.data ?? []
    const statusById = new Map((statusQ.data?.rules ?? []).map(s => [s.id, s]))
    return rows.map((row) => {
      const builder = fromAST(row)
      const s = statusById.get(row.id)
      const lastFired = s?.lastFiredAt ? agoShort(s.lastFiredAt) : 'never'
      return {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        mode: row.dryRun ? 'dryrun' : 'active',
        side: (row.side ?? 'both') as ListItem['side'],
        builder,
        lastFired,
        firesToday: s?.firesToday ?? 0,
        live: s?.live,
        lastOutcome: s?.lastOutcome,
      }
    })
  }, [listQ.data, statusQ.data])

  const saving = createM.isPending || updateM.isPending

  const save = (rule: BuilderRule) => {
    const ast = toAST(rule)
    if (rule.id != null) updateM.mutate({ id: rule.id, ...ast }, { onSuccess: () => setEditing(null) })
    else createM.mutate(ast, { onSuccess: () => setEditing(null) })
  }

  const globalEnabled = statusQ.data?.globalEnabled
  const activeCount = items.filter(a => a.enabled && a.mode === 'active').length
  const dryCount = items.filter(a => a.enabled && a.mode === 'dryrun').length

  return (
    <div className="ap-console w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60 text-zinc-100" style={{ ['--accent' as string]: ACCENT }}>
      <style dangerouslySetInnerHTML={{ __html: SCOPED_CSS }} />
      <header className="flex flex-wrap items-center justify-between gap-4 px-5 py-5">
        <div>
          <h1 className="text-xl font-semibold">Autopilot</h1>
          <p className="mt-1 text-xs text-zinc-500">
            {activeCount}
            {' '}
            active ·
            {' '}
            {dryCount}
            {' '}
            in dry-run ·
            {' '}
            {items.length}
            {' '}
            total
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="accent" size="md" onClick={() => setEditing(blankRule())}>
            <Icon.Plus size={15} />
            New automation
          </Button>
          <div className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-2">
            <Icon.Power size={18} className={globalEnabled === false ? 'text-red-400' : 'text-zinc-400'} />
            <div className="text-xs">
              <div>{globalEnabled === undefined ? 'Autopilot status unavailable' : globalEnabled ? 'Autopilot running' : 'Autopilot halted'}</div>
              <div className="text-[10px] text-zinc-500">global kill-switch</div>
            </div>
            <button type="button" role="switch" aria-label="Autopilot running" aria-checked={globalEnabled ?? false} disabled={globalEnabled === undefined || killM.isPending} onClick={() => killM.mutate({ enabled: !globalEnabled })} className="relative h-6 w-11 rounded-full bg-zinc-700 disabled:opacity-50" style={globalEnabled ? { background: 'var(--accent)' } : undefined}>
              <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${globalEnabled ? 'left-6' : 'left-1'}`} />
            </button>
          </div>
        </div>
      </header>
      <nav aria-label="Autopilot views" className="flex gap-6 border-b border-zinc-800 px-5">
        {(['Rules', 'Live', 'Activity'] as const).map(view => (
          <button key={view} type="button" aria-pressed={tab === view} onClick={() => setTab(view)} className={`border-b-2 py-3 text-sm ${tab === view ? 'border-sky-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
            {view}
            {view === 'Rules' && <span className="ml-2 text-xs text-zinc-500">{items.length}</span>}
          </button>
        ))}
      </nav>
      {globalEnabled === false && <p role="status" className="m-5 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">Autopilot halted — all rules are suspended. Manual controls remain available.</p>}
      {tab === 'Rules' && <AutomationsList items={items} loading={listQ.isLoading} onToggle={(id, enabled) => setEnabledM.mutate({ id, enabled })} onOpen={a => setEditing(a.builder)} />}
      {tab === 'Live' && (
        <section aria-label="Live rule state" className="p-5">
          {statusQ.isLoading
            ? <p>Loading status…</p>
            : !statusQ.data
                ? <p>Status unavailable.</p>
                : statusQ.data.rules.length === 0
                  ? <p className="text-sm text-zinc-500">No automations yet.</p>
                  : (
                      <div className="grid gap-4 lg:grid-cols-2">{statusQ.data.rules.map(a => <RuleStatusCard key={a.id} a={a} onDry={(id, dryRun) => setDryRunM.mutate({ id, dryRun })} />)}</div>
                    )}
        </section>
      )}
      {tab === 'Activity' && <section aria-label="Automation activity" className="p-5">{runsQ.isLoading ? <p>Loading activity…</p> : !runsQ.data ? <p>Activity unavailable.</p> : <RunLog runs={runsQ.data} />}</section>}
      {editing && <RuleEditor automation={editing} onClose={() => setEditing(null)} onSave={save} saving={saving} />}
    </div>
  )
}

function agoShort(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d)
  const ms = Date.now() - date.getTime()
  if (ms < 60_000) return 'now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

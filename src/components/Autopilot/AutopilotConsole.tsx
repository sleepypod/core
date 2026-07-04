/**
 * Autopilot console — the full-bleed desktop surface that hosts the Automations
 * list, the Rule editor (modal), and the Diagnostics/status panel behind a
 * left side-nav. Breaks out of the app's mobile `max-w-md` shell the same way
 * the diagnostics console does. Owns all tRPC data + mutations.
 */
'use client'

import { useMemo, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Icon, type IconName } from './icons'
import { AutomationsList, type ListItem } from './AutomationsList'
import { RuleEditor } from './RuleEditor'
import { StatusPanel } from './StatusPanel'
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

function NavItem({ icon, label, active, badge, onClick }: { icon: IconName, label: string, active: boolean, badge?: number, onClick: () => void }) {
  const I = Icon[icon]
  return (
    <button
      type="button"
      onClick={onClick}
      style={active ? { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' } : undefined}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${active ? '' : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'}`}
    >
      <I size={17} />
      <span className="flex-1 text-left">{label}</span>
      {badge != null && <span className="mono text-[11px] text-zinc-500">{badge}</span>}
    </button>
  )
}

export function AutopilotConsole() {
  const utils = trpc.useUtils()
  const [screen, setScreen] = useState<'list' | 'status'>('list')
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
      }
    })
  }, [listQ.data, statusQ.data])

  const saving = createM.isPending || updateM.isPending

  const save = (rule: BuilderRule) => {
    const ast = toAST(rule)
    if (rule.id != null) updateM.mutate({ id: rule.id, ...ast }, { onSuccess: () => setEditing(null) })
    else createM.mutate(ast, { onSuccess: () => setEditing(null) })
  }

  const killed = statusQ.data ? !statusQ.data.globalEnabled : false
  const activeCount = items.filter(i => i.enabled && i.mode === 'active').length

  return (
    <div className="ap-console mx-[calc(50%-50vw)] w-screen px-4 text-zinc-100" style={{ ['--accent' as string]: ACCENT }}>
      <style dangerouslySetInnerHTML={{ __html: SCOPED_CSS }} />
      <div className="mx-auto flex max-w-[1500px] gap-4">
        {/* side nav */}
        <aside className="flex w-[212px] shrink-0 flex-col self-start rounded-xl border border-zinc-800 bg-zinc-950/80">
          <div className="flex items-center gap-2.5 px-4 py-4">
            <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' }}>
              <Icon.Sliders size={17} />
            </span>
            <div className="leading-tight">
              <div className="text-[14px] font-semibold text-zinc-100">Autopilot</div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-600">sleepypod</div>
            </div>
          </div>
          <nav className="flex flex-col gap-1 px-3 py-2">
            <NavItem icon="List" label="Automations" badge={items.length} active={screen === 'list'} onClick={() => setScreen('list')} />
            <NavItem icon="Pulse" label="Diagnostics" active={screen === 'status'} onClick={() => setScreen('status')} />
          </nav>
          <div className="mt-auto p-3">
            <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${killed ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-zinc-800 bg-zinc-900/40 text-zinc-400'}`}>
              <span className={`h-2 w-2 rounded-full ${killed ? 'bg-red-400' : 'bg-emerald-400'}`} style={killed ? undefined : { boxShadow: '0 0 0 3px rgba(52,211,153,0.18)' }} />
              {killed ? 'Halted' : 'Running'}
              <span className="ml-auto text-zinc-600">
                {activeCount}
                {' '}
                active
              </span>
            </div>
          </div>
        </aside>

        {/* content */}
        <main className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden" style={{ minHeight: 'calc(100dvh - 7rem)' }}>
          {screen === 'list' && (
            <AutomationsList
              items={items}
              loading={listQ.isLoading}
              onToggle={(id, enabled) => setEnabledM.mutate({ id, enabled })}
              onOpen={a => setEditing(a.builder)}
              onNew={() => setEditing(blankRule())}
            />
          )}
          {screen === 'status' && (
            <StatusPanel
              globalEnabled={statusQ.data?.globalEnabled ?? true}
              onKill={enabled => killM.mutate({ enabled })}
              rules={statusQ.data?.rules ?? []}
              runs={runsQ.data ?? []}
              loading={statusQ.isLoading}
              onDry={(id, dryRun) => setDryRunM.mutate({ id, dryRun })}
            />
          )}
        </main>
      </div>

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

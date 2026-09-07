/** Autopilot's automation editor, live engine state, and audit trail. */
'use client'

import { useMemo, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
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

/** Combine automation editing, live engine state, and the audit trail in one page. */
export function AutopilotConsole() {
  const utils = trpc.useUtils()
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

  return (
    <div className="ap-console w-full space-y-4 text-zinc-100" style={{ ['--accent' as string]: ACCENT }}>
      <style dangerouslySetInnerHTML={{ __html: SCOPED_CSS }} />
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
        <AutomationsList
          items={items}
          loading={listQ.isLoading}
          onToggle={(id, enabled) => setEnabledM.mutate({ id, enabled })}
          onOpen={a => setEditing(a.builder)}
          onNew={() => setEditing(blankRule())}
        />
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
        <StatusPanel
          globalEnabled={statusQ.data?.globalEnabled ?? true}
          onKill={enabled => killM.mutate({ enabled })}
          rules={statusQ.data?.rules ?? []}
          runs={runsQ.data ?? []}
          loading={statusQ.isLoading}
          onDry={(id, dryRun) => setDryRunM.mutate({ id, dryRun })}
        />
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

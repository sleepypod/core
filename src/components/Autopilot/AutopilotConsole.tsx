/**
 * Autopilot console — hosts the Automations page (who controls the bed
 * tonight, the rules, and the activity log) and the Diagnostics/status panel;
 * a rule opens on its own page (/autopilot/<id>, /autopilot/new). The view
 * lives in `?view=`; desktop switches it from the sidebar, phones from a
 * segmented switch. Renders inside the AppShell's <main>. Owns all tRPC data +
 * mutations.
 */
'use client'

import { useCallback, useMemo, useState } from 'react'
import { useNowMinute } from '@/src/components/Schedule/CurveChart'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Plus } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, PageHeader, SegmentedControl, Toggle } from '@/src/components/ds'
import { useDocumentTitle } from '@/src/hooks/useDocumentTitle'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatSetpointF } from '@/src/lib/tempUtils'
import type { Condition } from '@/src/automation/types'
import { AutomationsList, type ListItem } from './AutomationsList'
import { ActivityCard } from './ActivityCard'
import { TonightCard, type FireMark, type TimelineRule } from './TonightCard'
import { StatusPanel, STRIP_HOURS, type RuleMode as DiagMode } from './StatusPanel'
import { fromAST, missingLiveSignals, type TemplateId } from './builderModel'
import { nightStarts, ruleMode, statusLine, type RuleMode } from './automationsLogic'
import { AUTOPILOT_VIEWS, resolveAutopilotView, type AutopilotView } from './autopilotViews'

export function AutopilotConsole() {
  const utils = trpc.useUtils()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { unit } = useTemperatureUnit()
  const view = resolveAutopilotView(searchParams.get('view'))
  useDocumentTitle(AUTOPILOT_VIEWS.find(v => v.id === view)?.label, 'Autopilot')
  const setView = useCallback((next: AutopilotView) => {
    const params = new URLSearchParams(searchParams.toString())
    if (next === 'automations') params.delete('view')
    else params.set('view', next)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  const onAutomations = view === 'automations'
  const [nightCount, setNightCount] = useState(2)
  const nowMinute = useNowMinute()
  // Night boundaries only move at 6 PM, so the query key stays put minute to minute.
  const starts = nowMinute == null ? [] : nightStarts(nowMinute * 60_000, nightCount)

  const listQ = trpc.automations.list.useQuery({})
  const statusQ = trpc.automations.status.useQuery({}, { refetchInterval: 15000 })
  const diagQ = trpc.automations.diagnostics.useQuery({ hours: STRIP_HOURS }, { enabled: view === 'diagnostics', refetchInterval: 15000 })
  const tonightQ = trpc.automations.tonight.useQuery({}, { enabled: onAutomations, refetchInterval: 30000 })
  const backtestQ = trpc.automations.backtestSummaries.useQuery({}, { enabled: onAutomations, staleTime: 5 * 60_000 })
  const activityQ = trpc.automations.activity.useQuery(
    { nightStarts: starts },
    { enabled: onAutomations && starts.length > 0, refetchInterval: 60000, placeholderData: prev => prev },
  )

  const invalidate = () => {
    void utils.automations.list.invalidate()
    void utils.automations.status.invalidate()
    void utils.automations.diagnostics.invalidate()
    void utils.automations.tonight.invalidate()
  }

  const setEnabledM = trpc.automations.setEnabled.useMutation({ onSuccess: invalidate })
  const setDryRunM = trpc.automations.setDryRun.useMutation({ onSuccess: invalidate })
  const killM = trpc.automations.setKillSwitch.useMutation({ onSuccess: () => {
    void utils.automations.status.invalidate()
    void utils.automations.diagnostics.invalidate()
    void utils.automations.getKillSwitch.invalidate()
  } })

  // Off = disabled; Dry-run / Active = enabled with dryRun on / off.
  const setMode = async (id: number, mode: RuleMode | DiagMode) => {
    const row = listQ.data?.find(r => r.id === id) ?? diagQ.data?.rules.find(r => r.id === id)
    if (mode === 'off') {
      if (row?.enabled !== false) setEnabledM.mutate({ id, enabled: false })
      return
    }
    const dryRun = mode === 'dryrun'
    if (row?.dryRun !== dryRun) await setDryRunM.mutateAsync({ id, dryRun })
    if (row?.enabled !== true) setEnabledM.mutate({ id, enabled: true })
  }

  const rows = useMemo(() => listQ.data ?? [], [listQ.data])
  const builders = useMemo(() => new Map(rows.map(r => [r.id, fromAST(r)])), [rows])
  const summaries = useMemo(() => new Map((backtestQ.data ?? []).map(s => [s.id, s])), [backtestQ.data])

  const items: ListItem[] = rows.map(row => ({
    id: row.id,
    name: row.name,
    mode: ruleMode(row),
    side: row.side ?? 'both',
    builder: builders.get(row.id) ?? fromAST(row),
    backtest: summaries.get(row.id),
  }))

  const ruleInfo = useMemo(() => new Map(rows.map(r => [r.id, {
    conditions: r.conditions as Condition,
    missing: missingLiveSignals(builders.get(r.id) ?? fromAST(r)),
  }])), [rows, builders])

  const timelineRules: TimelineRule[] = rows.map(r => ({
    id: r.id,
    name: r.name,
    mode: ruleMode(r),
    side: r.side,
    conditions: r.conditions as Condition,
    missing: ruleInfo.get(r.id)?.missing ?? [],
  }))

  const tonightNight = activityQ.data?.nights[0]
  const fires: FireMark[] = (tonightNight?.entries ?? [])
    .filter(e => e.outcome === 'fired' || e.outcome === 'clamped' || e.outcome === 'dry_run')
    .map(e => ({ ruleId: e.ruleId, at: e.start, outcome: e.outcome, sides: e.sides }))

  const lang = pathname?.split('/')[1] || 'en'
  const killed = statusQ.data ? !statusQ.data.globalEnabled : false
  const fmt = (f: number) => formatSetpointF(f, unit, { includeUnit: false })

  const openTemplate = (id: TemplateId) => router.push(`/${lang}/autopilot/new?template=${id}`)

  return (
    <>
      <span className="-mb-2 hidden font-mono text-[13px] text-fg-2 min-[900px]:block">Autopilot /</span>
      <PageHeader
        title={(
          <span className="flex items-baseline gap-3">
            <span className="min-[900px]:hidden">Autopilot</span>
            <span className="hidden min-[900px]:inline">{AUTOPILOT_VIEWS.find(v => v.id === view)?.label}</span>
            {onAutomations && !listQ.isLoading && (
              <span className="font-mono text-xs font-normal whitespace-nowrap text-fg-2" data-testid="automations-status">{statusLine(rows)}</span>
            )}
          </span>
        )}
        right={(
          <>
            <label className="flex cursor-pointer items-center gap-2.5 rounded-ctl border border-line px-3 py-1.5 text-[13px]">
              <Toggle size="md" label="Autopilot enabled" on={!killed} onChange={on => killM.mutate({ enabled: on })} />
              {killed ? 'Autopilot off' : 'Autopilot on'}
            </label>
            {onAutomations && (
              <Button variant="primary" size="md" icon={Plus} onClick={() => router.push(`/${lang}/autopilot/new`)} className="max-[899px]:hidden">
                New automation
              </Button>
            )}
            <SegmentedControl
              ariaLabel="Autopilot view"
              size="sm"
              className="min-[900px]:hidden"
              value={view}
              onChange={setView}
              options={[
                { value: 'automations', label: (
                  <>
                    Automations
                    <span className="font-mono text-fg-3">{items.length}</span>
                  </>
                ) },
                { value: 'diagnostics', label: 'Diagnostics' },
              ]}
            />
          </>
        )}
      />

      {killed && (
        <div className="rounded-ctl border border-line-2 bg-active px-4 py-2.5 text-[13px] text-fg-2" role="status">
          Autopilot is off. No rules are evaluated.
        </div>
      )}

      {onAutomations && (
        <>
          <Button variant="primary" size="md" icon={Plus} full onClick={() => router.push(`/${lang}/autopilot/new`)} className="min-[900px]:hidden">
            New automation
          </Button>
          <TonightCard rules={timelineRules} tonight={tonightQ.data} fires={fires} unit={unit} />
          <AutomationsList
            items={items}
            loading={listQ.isLoading}
            onMode={(id, mode) => void setMode(id, mode).catch(() => {})}
            onOpen={a => router.push(`/${lang}/autopilot/${a.id}`)}
            onTemplate={openTemplate}
          />
          <ActivityCard
            data={activityQ.data}
            rules={ruleInfo}
            fmt={fmt}
            onMore={() => setNightCount(n => Math.min(30, n + 2))}
            loadingMore={activityQ.isFetching && activityQ.isPlaceholderData}
          />
        </>
      )}
      {view === 'diagnostics' && (
        <StatusPanel
          data={diagQ.data}
          loading={diagQ.isLoading}
          onKill={enabled => killM.mutate({ enabled })}
          onMode={(id, mode) => void setMode(id, mode).catch(() => {})}
        />
      )}
    </>
  )
}

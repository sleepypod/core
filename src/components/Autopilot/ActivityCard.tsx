/**
 * Activity — why the bed changed, or didn't. Runs grouped by night (6 PM–6 PM),
 * newest first; consecutive same-reason skips arrive collapsed from the server
 * as one ranged row with a count. Manual holds show as "Paused" rows.
 */
'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { SegmentedControl } from '@/src/components/ds'
import type { Condition } from '@/src/automation/types'
import {
  clock, entryTime, matchesFilter, nightHeader, OUTCOME_VIEW, reasonText,
  type ActivityFilter, type ActivityTone, type EntryLike,
} from './automationsLogic'

export interface ActivityEntryView extends EntryLike {
  ruleId: number
  ruleName: string
  outcome: string
  start: number
  end: number
  count: number
}

export interface ActivityData {
  now: number
  /** Newest night first. */
  nights: Array<{ start: number, entries: ActivityEntryView[] }>
  holds: Array<{ side: 'left' | 'right', temperature: number, startedAt: number, expiresAt: number }>
}

interface Row {
  key: string
  time: string
  sortAt: number
  outcome: string
  who: string
  reason: string
}

const TONE_CLASS: Record<ActivityTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  muted: 'text-fg-2',
  danger: 'text-vital-hr',
  link: 'text-link',
}

const FILTERS: Array<{ value: ActivityFilter, label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'fired', label: 'Fired' },
  { value: 'would', label: 'Would fire' },
  { value: 'skipped', label: 'Skipped' },
]

export function ActivityCard({ data, rules, fmt, onMore, loadingMore }: {
  data: ActivityData | undefined
  rules: Map<number, { conditions: Condition, missing: string[] }>
  fmt: (f: number) => string
  onMore: () => void
  loadingMore: boolean
}) {
  const [filter, setFilter] = useState<ActivityFilter>('all')

  const nights = (data?.nights ?? []).map((night, i, all) => {
    const nightEnd = i === 0 ? Infinity : all[i - 1].start
    const rows: Row[] = night.entries
      .filter(e => matchesFilter(e.outcome, filter))
      .map((e) => {
        const rule = rules.get(e.ruleId)
        const reason = reasonText(e, rule, rule?.missing ?? [], fmt)
        return {
          key: `${e.ruleId}-${e.start}-${e.outcome}-${e.code}`,
          time: entryTime(e.start, e.end, data?.now ?? 0, e.count),
          sortAt: e.end,
          outcome: e.outcome,
          who: e.ruleName,
          reason: e.count > 1 ? `${reason} · ${e.count}×` : reason,
        }
      })
    if (filter === 'all') {
      for (const h of data?.holds ?? []) {
        if (h.startedAt < night.start || h.startedAt >= nightEnd) continue
        rows.push({
          key: `hold-${h.side}-${h.startedAt}`,
          time: clock(h.startedAt),
          sortAt: h.startedAt,
          outcome: 'paused',
          who: h.side === 'left' ? 'Left side' : 'Right side',
          reason: `dial set to ${fmt(h.temperature)} · autopilot paused until ${clock(h.expiresAt)}`,
        })
      }
    }
    rows.sort((a, b) => b.sortAt - a.sortAt)
    return { start: night.start, rows }
  })

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-card border border-line bg-surface px-[18px] py-4" data-testid="activity-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[15px] font-medium">Activity</span>
        <span className="font-mono text-xs text-fg-2">why the bed changed, or didn’t</span>
        <SegmentedControl ariaLabel="Activity filter" size="sm" className="ml-auto" options={FILTERS} value={filter} onChange={setFilter} />
      </div>

      {!data && <div className="py-6 text-center text-[13px] text-fg-3">Loading activity…</div>}
      {nights.map(n => (
        <div key={n.start} className="flex flex-col">
          <span className="border-b border-line pt-2 pb-2 font-mono text-[11px] tracking-wide text-fg-3">{nightHeader(n.start, data?.now ?? 0)}</span>
          {n.rows.length === 0 && <span className="py-3 text-[13px] text-fg-3">Nothing logged.</span>}
          {n.rows.map((r) => {
            const v = OUTCOME_VIEW[r.outcome] ?? { label: r.outcome, tone: 'muted' as const }
            return (
              <div key={r.key} className="grid grid-cols-[150px_110px_minmax(0,1fr)] items-baseline gap-x-3 border-b border-grid py-2.5 last:border-0 max-[640px]:grid-cols-[1fr_auto] max-[640px]:gap-y-1">
                <span className="font-mono text-[13px] whitespace-nowrap">{r.time}</span>
                <span className={cn('flex items-center gap-1.5 text-[13px]', TONE_CLASS[v.tone])}>
                  <span className="size-1.5 rounded-full bg-current" />
                  {v.label}
                </span>
                <span className="min-w-0 text-[13px] text-fg-2 max-[640px]:col-span-2">
                  <span className="text-fg">{r.who}</span>
                  {` · ${r.reason}`}
                </span>
              </div>
            )
          })}
        </div>
      ))}
      {data && (
        <button
          type="button"
          onClick={onMore}
          disabled={loadingMore}
          className="cursor-pointer self-start border-0 bg-transparent p-0 text-[13px] text-link hover:underline disabled:cursor-default disabled:text-fg-3"
        >
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  )
}

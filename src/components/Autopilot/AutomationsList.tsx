/**
 * Automations list — one compact card per rule. Line 1: name, side chip, and a
 * warning when the rule reads a signal with no live source. Line 2: the rule
 * as a plain-English sentence. Right: the Off / Dry-run / Active mode control
 * and the rule's 5-night backtest. The whole row opens the editor.
 *
 * With no rules, the list becomes three starter templates.
 */
'use client'

import { CircleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Icon } from './icons'
import { type BuilderRule, buildSentence, missingLiveSignals, TEMPLATES, type TemplateId } from './builderModel'
import { backtestLine, type BacktestSummary, type RuleMode } from './automationsLogic'

export interface ListItem {
  id: number
  name: string
  mode: RuleMode
  side: 'left' | 'right' | 'both'
  builder: BuilderRule
  backtest: BacktestSummary | undefined
}

const SIDE_CHIP: Record<ListItem['side'], string> = { left: 'L', right: 'R', both: 'L+R' }

function RuleSentence({ b }: { b: BuilderRule }) {
  const chunks = buildSentence(b)
  return (
    <span className="text-[13px] leading-snug text-fg-2 text-pretty">
      {chunks.map((c, i) => (
        <span key={i} className={cn(c.mono && 'font-mono', c.hot && 'text-link')}>{c.text}</span>
      ))}
    </span>
  )
}

const MODES: Array<{ value: RuleMode, label: string, on: string }> = [
  { value: 'off', label: 'Off', on: 'bg-active text-fg' },
  { value: 'dryrun', label: 'Dry-run', on: 'bg-warn-bg text-warn' },
  { value: 'active', label: 'Active', on: 'bg-ok/15 text-ok' },
]

export function ModeControl({ value, onChange, name }: { value: RuleMode, onChange: (m: RuleMode) => void, name: string }) {
  return (
    <div role="radiogroup" aria-label={`${name} mode`} className="inline-flex rounded-seg border border-line p-0.5">
      {MODES.map(m => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={value === m.value}
          onClick={(e) => {
            e.stopPropagation()
            if (value !== m.value) onChange(m.value)
          }}
          className={cn(
            'cursor-pointer rounded-ctl border-0 px-2.5 py-1 text-[13px] transition-colors',
            value === m.value ? m.on : 'bg-transparent text-fg-2 hover:text-fg',
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

function Row({ a, onMode, onOpen }: { a: ListItem, onMode: (id: number, mode: RuleMode) => void, onOpen: (a: ListItem) => void }) {
  const missing = missingLiveSignals(a.builder)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(a)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(a)
        }
      }}
      className="group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 rounded-card border border-line bg-surface px-[18px] py-4 transition-colors hover:bg-active focus:outline-none focus-visible:bg-active max-[720px]:grid-cols-1"
      data-testid={`rule-${a.id}`}
    >
      <div className="min-w-0">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-[15px] font-medium whitespace-nowrap text-fg">{a.name}</span>
          <span className="rounded-tag border border-line-2 px-1.5 font-mono text-[11px] text-fg-2">{SIDE_CHIP[a.side]}</span>
          {missing.length > 0 && (
            <span className="flex items-center gap-1.5 font-mono text-[12px] text-warn">
              <CircleAlert size={13} />
              {`no live ${missing[0]} signal`}
            </span>
          )}
        </div>
        <RuleSentence b={a.builder} />
      </div>
      <div className="flex items-center gap-3 max-[720px]:justify-between">
        <div className="flex flex-col items-end gap-1.5 max-[720px]:items-start">
          <ModeControl name={a.name} value={a.mode} onChange={m => onMode(a.id, m)} />
          <span className="font-mono text-[11px] whitespace-nowrap text-fg-2" data-testid={`backtest-${a.id}`}>{backtestLine(a.backtest)}</span>
        </div>
        <Icon.ChevRight size={16} className="text-fg-3 transition-colors group-hover:text-fg-2" />
      </div>
    </div>
  )
}

function Templates({ onTemplate }: { onTemplate: (id: TemplateId) => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="sp-label">Start from a template</span>
      <div className="grid gap-2.5 @min-[720px]:grid-cols-3">
        {TEMPLATES.map((t) => {
          const live = missingLiveSignals(t.rule()).length === 0
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTemplate(t.id)}
              className="flex cursor-pointer flex-col gap-1.5 rounded-card border border-line bg-surface px-4 py-3.5 text-left transition-colors hover:bg-active"
            >
              <span className="text-sm font-medium text-fg">{t.title}</span>
              <span className="text-[13px] leading-snug text-fg-2">{t.description}</span>
              <span className={cn('mt-1 flex items-center gap-1.5 font-mono text-[11px]', live ? 'text-ok' : 'text-fg-3')}>
                <span className="size-1.5 rounded-full bg-current" />
                {live ? 'live' : 'backtest only'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function AutomationsList({ items, loading, onMode, onOpen, onTemplate }: {
  items: ListItem[]
  loading: boolean
  onMode: (id: number, mode: RuleMode) => void
  onOpen: (a: ListItem) => void
  onTemplate: (id: TemplateId) => void
}) {
  if (loading) return <div className="rounded-card border border-line bg-surface px-[18px] py-10 text-center text-[13px] text-fg-3">Loading automations…</div>
  if (items.length === 0) return <div className="@container"><Templates onTemplate={onTemplate} /></div>
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {items.map(a => <Row key={a.id} a={a} onMode={onMode} onOpen={onOpen} />)}
    </div>
  )
}

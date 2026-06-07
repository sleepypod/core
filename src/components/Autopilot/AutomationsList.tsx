/**
 * Automations list — the dense table-of-rules. Each row renders its rule as a
 * plain-English sentence with the dynamic parts in the accent colour, plus an
 * enabled toggle, status/side badges, last-fired and fires-today.
 */
'use client'

import { Icon } from './icons'
import { Button, SideBadge, StatusBadge, Toggle } from './primitives'
import { type BuilderRule, buildSentence } from './builderModel'

export interface ListItem {
  id: number
  name: string
  enabled: boolean
  mode: 'active' | 'dryrun'
  side: 'left' | 'right' | 'both'
  builder: BuilderRule
  lastFired: string
  firesToday: number
}

function RuleSentence({ b }: { b: BuilderRule }) {
  const chunks = buildSentence(b)
  return (
    <span className="text-[13px] leading-snug text-zinc-400" style={{ textWrap: 'pretty' }}>
      {chunks.map((c, i) => (
        <span key={i} className={c.mono ? 'mono' : ''} style={c.hot ? { color: 'var(--accent)' } : undefined}>{c.text}</span>
      ))}
    </span>
  )
}

function Row({ a, onToggle, onOpen }: { a: ListItem, onToggle: (id: number, enabled: boolean) => void, onOpen: (a: ListItem) => void }) {
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
      className="group grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-4 border-b border-zinc-800/60 px-5 py-4 transition-colors hover:bg-zinc-900/40 focus:outline-none focus:ring-2 focus:ring-zinc-500/60"
    >
      <div onClick={e => e.stopPropagation()} className="pt-0.5">
        <Toggle checked={a.enabled} onChange={() => onToggle(a.id, !a.enabled)} />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5 mb-1">
          <span className="truncate text-[14px] font-medium text-zinc-100">{a.name}</span>
          <StatusBadge mode={a.enabled ? a.mode : 'paused'} />
          <SideBadge side={a.side} />
        </div>
        <RuleSentence b={a.builder} />
      </div>
      <div className="flex items-center gap-5 text-right">
        <div className="hidden sm:block">
          <div className="text-[10px] uppercase tracking-[0.1em] text-zinc-600">Last fired</div>
          <div className="mono text-[12px] text-zinc-400">{a.lastFired}</div>
        </div>
        <div className="hidden md:block w-14">
          <div className="text-[10px] uppercase tracking-[0.1em] text-zinc-600">Today</div>
          <div className="mono text-[12px] text-zinc-400">
            {a.firesToday}
            {' '}
            fire
            {a.firesToday === 1 ? '' : 's'}
          </div>
        </div>
        <Icon.ChevRight size={16} className="text-zinc-700 group-hover:text-zinc-400 transition-colors" />
      </div>
    </div>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="grid place-items-center px-6 py-24">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl border border-zinc-800 bg-zinc-900/60" style={{ color: 'var(--accent)' }}>
          <Icon.Sliders size={26} />
        </div>
        <h3 className="text-[18px] font-semibold text-zinc-100">No automations yet</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
          Autopilot reacts to live signals — movement, heart rate, ambient temperature — instead of just the clock.
          Build a rule as
          {' '}
          <span className="text-zinc-300">When</span>
          {' '}
          ·
          {' '}
          <span className="text-zinc-300">If</span>
          {' '}
          ·
          {' '}
          <span className="text-zinc-300">Then</span>
          , then backtest it against past nights before it ever touches your bed.
        </p>
        <div className="mt-6 flex justify-center">
          <Button variant="accent" size="lg" onClick={onNew}>
            <Icon.Plus size={16} />
            New automation
          </Button>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-3 text-left">
          {[{ t: 'Hold ambient + 3°F overnight', s: 'continuous policy' }, { t: 'Cool down when restless', s: 'edge-triggered rule' }].map((x, i) => (
            <div key={i} className="rounded-xl border border-zinc-800/70 bg-zinc-900/30 p-3">
              <div className="text-[13px] text-zinc-300">{x.t}</div>
              <div className="mt-0.5 text-[11px] text-zinc-600">{x.s}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function AutomationsList({ items, loading, onToggle, onOpen, onNew }: {
  items: ListItem[]
  loading: boolean
  onToggle: (id: number, enabled: boolean) => void
  onOpen: (a: ListItem) => void
  onNew: () => void
}) {
  const activeCount = items.filter(a => a.enabled && a.mode === 'active').length
  const dryCount = items.filter(a => a.enabled && a.mode === 'dryrun').length
  const empty = !loading && items.length === 0
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-4 border-b border-zinc-800 px-5 py-4">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight text-zinc-100">Automations</h1>
          <p className="text-[12px] text-zinc-500 mt-0.5">
            {empty
              ? 'Reactive rules that respond to live signals'
              : (
                  <>
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
                  </>
                )}
          </p>
        </div>
        {!empty && (
          <Button variant="accent" size="md" onClick={onNew}>
            <Icon.Plus size={15} />
            New automation
          </Button>
        )}
      </div>

      {loading
        ? <div className="px-5 py-16 text-center text-[13px] text-zinc-600">Loading automations…</div>
        : empty
          ? <EmptyState onNew={onNew} />
          : <div className="overflow-y-auto">{items.map(a => <Row key={a.id} a={a} onToggle={onToggle} onOpen={onOpen} />)}</div>}
    </div>
  )
}

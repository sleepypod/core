'use client'

import { ArrowDown, ArrowUp, Check, Plus, TriangleAlert, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button, GhostIcon, SelectValue } from '@/src/components/ds'
import {
  SLEEP_STAGES,
  STAGE_METRICS,
  STAGE_OPERATORS,
  type StageCondition,
  type StageMetric,
  type StageRule,
  type StageRuleset,
  type StageTransition,
} from '@/src/lib/sleep-stage-rules'
import type { RuleListStats, SleepStage } from '@/src/lib/sleep-stages'
import { NumberField } from './SettingsLayout'
import {
  formatMetricRange,
  formatMetricValue,
  groupTransitions,
  METRIC_WORD,
  nextTransitionPair,
  OP_WORD,
  pct,
  STAGE_COLOR,
  STAGE_LABELS,
  STAGE_METRIC_LABELS,
} from './sleepStageEditing'

export const STAGE_OPTIONS = SLEEP_STAGES.map(s => ({ value: s, label: STAGE_LABELS[s] }))
const METRIC_OPTIONS = STAGE_METRICS.map(m => ({ value: m, label: STAGE_METRIC_LABELS[m] }))
const OP_OPTIONS = STAGE_OPERATORS.map(o => ({ value: o, label: o }))
export const NEW_CONDITION: StageCondition = { metric: 'movement', op: '>', value: 100 }

export function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/* ─── Sentence primitives ─────────────────────────────────────────────── */

/** A value in a sentence that opens its row for editing when clicked. */
export function DottedValue({ children, onClick, label, mono = true, color, className }: {
  children: ReactNode
  onClick: () => void
  label: string
  mono?: boolean
  color?: string
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={color ? { color } : undefined}
      className={cn(
        'inline cursor-pointer border-0 border-b border-dotted border-fg-3 bg-transparent p-0 text-fg hover:border-fg disabled:cursor-default disabled:opacity-45',
        mono ? 'font-mono text-[13px]' : 'text-sm',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Mono stage tag tinted with the stage colour. */
export function StageChip({ stage, onClick, label }: { stage: SleepStage, onClick?: () => void, label?: string }) {
  const style = { color: STAGE_COLOR[stage], background: `color-mix(in srgb, ${STAGE_COLOR[stage]} 16%, transparent)` }
  const cls = 'inline-block rounded-tag px-[7px] py-0.5 font-mono text-xs'
  if (!onClick) return <span className={cls} style={style}>{STAGE_LABELS[stage]}</span>
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(cls, 'cursor-pointer border-0 border-b border-dotted border-current hover:brightness-125 disabled:cursor-default disabled:opacity-45')}
      style={style}
    >
      {STAGE_LABELS[stage]}
    </button>
  )
}

/** Share of epochs a rule decided, as a thin bar plus a mono caption. */
export function HitBar({ hits, total, color, caption }: { hits: number, total: number, color: string, caption: string }) {
  const p = pct(hits, total)
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1 overflow-hidden rounded-sm bg-active">
        <div className="h-full" style={{ width: `${p}%`, background: color }} />
      </div>
      <span className="font-mono text-[11px] text-fg-2">{`${p}% ${caption}`}</span>
    </div>
  )
}

/** Grey "· last night 0–412" tail on a sentence. */
export function Seen({ children }: { children: ReactNode }) {
  return <span className="text-xs text-fg-3">{` · ${children}`}</span>
}

export function DoneButton({ onClick }: { onClick: () => void }) {
  return <Button variant="ghost" size="sm" icon={Check} onClick={onClick}>Done</Button>
}

/** A row of the rules list: number, sentence, hit bar, reorder/remove. */
function RuleGrid({ n, children, bar, actions, nested, className }: {
  n?: ReactNode
  children: ReactNode
  bar?: ReactNode
  actions?: ReactNode
  nested?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid items-center gap-x-3.5 gap-y-2 py-3 max-[519px]:grid-cols-[24px_minmax(0,1fr)_auto] min-[520px]:grid-cols-[24px_minmax(0,1fr)_140px_72px]',
        nested ? 'ml-0 border-l-2 border-line pl-3' : 'border-t border-line',
        className,
      )}
    >
      <span className="self-start pt-1 font-mono text-xs text-fg-3">{n}</span>
      <div className="min-w-0 text-sm leading-[1.7]">{children}</div>
      <div className="flex justify-end gap-0.5 max-[519px]:order-2 max-[519px]:self-start">{actions}</div>
      {bar && <div className="max-[519px]:order-3 max-[519px]:col-span-2 max-[519px]:col-start-2">{bar}</div>}
    </div>
  )
}

/* ─── Rules ───────────────────────────────────────────────────────────── */

export interface RuleRowProps {
  index: number
  rule: StageRule
  /** "Rule" or "Low-signal rule": the aria-label prefix and the add-button text. */
  label: string
  editing: boolean
  onEdit: (editing: boolean) => void
  onChange: (rule: StageRule) => void
  onMove?: (to: number) => void
  onRemove: () => void
  canUp?: boolean
  canDown?: boolean
  /** Stats of the list this rule belongs to, when the preview has them for this exact list. */
  stats: RuleListStats | null
  /** "of epochs" or "on those nights". */
  hitCaption: string
  /** Range each metric took over the previewed nights. */
  ranges: Partial<Record<StageMetric, { min: number, max: number } | null>>
  /** "last night" or "last 7 nights" */
  seenLabel: string
  nested?: boolean
}

export function RuleRow({ index, rule, label, editing, onEdit, onChange, onMove, onRemove, canUp, canDown, stats, hitCaption, ranges, seenLabel, nested }: RuleRowProps) {
  const n = index + 1
  const low = label.toLowerCase()
  const hits = stats?.hits[index]
  const matches = stats?.matches[index]
  const shadowedBy = stats?.shadowedBy[index]
  const neverFires = stats !== null && hits === 0 && (matches ?? 0) > 0

  const setCondition = (k: number, patch: Partial<StageCondition>) =>
    onChange({ ...rule, when: rule.when.map((c, m) => (m === k ? { ...c, ...patch } : c)) })

  const actions = (
    <>
      {onMove && <GhostIcon icon={ArrowUp} size={14} label={`Move ${low} ${n} up`} disabled={!canUp} onClick={() => onMove(index - 1)} />}
      {onMove && <GhostIcon icon={ArrowDown} size={14} label={`Move ${low} ${n} down`} disabled={!canDown} onClick={() => onMove(index + 1)} />}
      <GhostIcon icon={X} size={14} label={`Remove ${low} ${n}`} onClick={onRemove} />
    </>
  )

  const bar = stats && hits !== undefined
    ? <HitBar hits={hits} total={stats.epochs} color={STAGE_COLOR[rule.stage]} caption={hitCaption} />
    : null

  if (editing) {
    return (
      <RuleGrid n={n} bar={bar} actions={actions} nested={nested} className="rounded-ctl bg-active/40">
        <div className="flex flex-col gap-2 py-1">
          <div className="flex flex-wrap items-center gap-2">
            <SelectValue label={`${label} ${n} stage`} value={rule.stage} options={STAGE_OPTIONS} onChange={stage => onChange({ ...rule, stage })} />
            <span className="text-[13px] text-fg-2">{rule.when.length === 0 ? 'always' : 'when'}</span>
            <DoneButton onClick={() => onEdit(false)} />
          </div>
          {rule.when.map((c, k) => (
            <div key={k} className="flex flex-wrap items-center gap-2">
              <span className="w-6 text-xs text-fg-3">{k > 0 ? 'and' : ''}</span>
              <SelectValue label={`${label} ${n} condition ${k + 1} metric`} value={c.metric} options={METRIC_OPTIONS} onChange={metric => setCondition(k, { metric })} />
              <SelectValue label={`${label} ${n} condition ${k + 1} comparison`} value={c.op} options={OP_OPTIONS} onChange={op => setCondition(k, { op })} />
              <NumberField
                label={`${label} ${n} condition ${k + 1} value`}
                value={c.value}
                step={c.metric === 'hrRatio' ? 0.01 : 1}
                onChange={value => setCondition(k, { value })}
              />
              <GhostIcon icon={X} size={14} label={`Remove ${low} ${n} condition ${k + 1}`} onClick={() => onChange({ ...rule, when: rule.when.filter((_, m) => m !== k) })} />
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            icon={Plus}
            className="self-start"
            disabled={rule.when.length >= 8}
            onClick={() => onChange({ ...rule, when: [...rule.when, NEW_CONDITION] })}
          >
            Condition
          </Button>
        </div>
      </RuleGrid>
    )
  }

  const open = () => onEdit(true)
  const single = rule.when.length === 1 ? rule.when[0] : null
  const seen = single ? formatMetricRange(single.metric, ranges[single.metric] ?? null) : null

  return (
    <RuleGrid n={n} bar={bar} actions={actions} nested={nested}>
      <StageChip stage={rule.stage} onClick={open} label={`${label} ${n} stage`} />
      {rule.when.length === 0
        ? <span className="text-fg-2"> always</span>
        : (
            <>
              <span className="text-fg-2"> when </span>
              {rule.when.map((c, k) => (
                <span key={k}>
                  {k > 0 && <span className="text-fg-2"> and </span>}
                  <DottedValue mono={false} label={`${label} ${n} condition ${k + 1}`} onClick={open}>
                    {`${METRIC_WORD[c.metric]} ${OP_WORD[c.op]}`}
                  </DottedValue>
                  {' '}
                  <DottedValue label={`${label} ${n} condition ${k + 1} value`} onClick={open}>
                    {formatMetricValue(c.metric, c.value)}
                  </DottedValue>
                </span>
              ))}
            </>
          )}
      {seen && <Seen>{`${seenLabel} ${seen}`}</Seen>}
      {neverFires && (
        <div className="flex items-center gap-1.5 text-xs text-warn">
          <TriangleAlert size={12} />
          {shadowedBy !== null && shadowedBy !== undefined
            ? `Never fires: every epoch it matches is taken by ${low} ${shadowedBy + 1}.`
            : 'Never fires on these nights.'}
        </div>
      )}
    </RuleGrid>
  )
}

/** "Otherwise [Light]" with the fallback's share of epochs. */
export function FallbackRow({ fallback, editing, onEdit, onChange, stats }: {
  fallback: SleepStage
  editing: boolean
  onEdit: (editing: boolean) => void
  onChange: (stage: SleepStage) => void
  stats: RuleListStats | null
}) {
  const bar = stats ? <HitBar hits={stats.fallbackHits} total={stats.epochs} color={STAGE_COLOR[fallback]} caption="of epochs" /> : null
  return (
    <RuleGrid bar={bar} actions={editing ? <DoneButton onClick={() => onEdit(false)} /> : undefined}>
      <span className="text-fg-2">Otherwise </span>
      {editing
        ? <SelectValue label="Fallback stage" value={fallback} options={STAGE_OPTIONS} onChange={onChange} />
        : <StageChip stage={fallback} onClick={() => onEdit(true)} label="Fallback stage" />}
    </RuleGrid>
  )
}

/** The ordered rules of one list, with the add button. */
export function RuleList({ rules, onChange, label, editingKey, onEdit, stats, hitCaption, ranges, seenLabel, nested }: {
  rules: StageRule[]
  onChange: (rules: StageRule[]) => void
  label: string
  /** Key of the row being edited anywhere on the page. Rows here are `${label}:${index}`. */
  editingKey: string | null
  onEdit: (key: string | null) => void
  stats: RuleListStats | null
  hitCaption: string
  ranges: RuleRowProps['ranges']
  seenLabel: string
  nested?: boolean
}) {
  // Only trust stats that describe this exact list (the preview lags edits).
  const aligned = stats && stats.hits.length === rules.length ? stats : null
  const key = (i: number) => `${label}:${i}`
  return (
    <>
      {rules.map((rule, i) => (
        <RuleRow
          key={i}
          index={i}
          rule={rule}
          label={label}
          nested={nested}
          editing={editingKey === key(i)}
          onEdit={on => onEdit(on ? key(i) : null)}
          onChange={r => onChange(rules.map((x, j) => (j === i ? r : x)))}
          onMove={(to) => {
            onChange(move(rules, i, to))
            if (editingKey === key(i)) onEdit(key(to))
          }}
          canUp={i > 0}
          canDown={i < rules.length - 1}
          onRemove={() => {
            onChange(rules.filter((_, j) => j !== i))
            if (editingKey === key(i)) onEdit(null)
          }}
          stats={aligned}
          hitCaption={hitCaption}
          ranges={ranges}
          seenLabel={seenLabel}
        />
      ))}
    </>
  )
}

export function AddRuleButton({ label, rules, onChange, onEdit, nested }: {
  label: string
  rules: StageRule[]
  onChange: (rules: StageRule[]) => void
  onEdit: (key: string | null) => void
  nested?: boolean
}) {
  const add = () => {
    onChange([...rules, { stage: 'wake', when: [NEW_CONDITION] }])
    onEdit(`${label}:${rules.length}`)
  }
  if (nested) {
    return (
      <div className="border-l-2 border-line pl-3 pt-2">
        <button type="button" disabled={rules.length >= 32} onClick={add} className="cursor-pointer border-0 bg-transparent p-0 text-[13px] text-fg-2 hover:text-fg disabled:opacity-45">
          {`+ ${label}`}
        </button>
      </div>
    )
  }
  return (
    <Button variant="dashed" size="sm" icon={Plus} disabled={rules.length >= 32} onClick={add}>
      {label}
    </Button>
  )
}

/* ─── Signal ──────────────────────────────────────────────────────────── */

type Outliers = StageRuleset['outliers']

/** "Ignore heart rate outside 45–130 bpm, HRV outside 1–300 ms, breathing outside 8–25 br/min" */
export function LimitsRow({ outliers, onChange, editing, onEdit, ranges, seenLabel }: {
  outliers: Outliers
  onChange: (outliers: Outliers) => void
  editing: boolean
  onEdit: (editing: boolean) => void
  ranges: RuleRowProps['ranges']
  seenLabel: string
}) {
  const open = () => onEdit(true)
  const limits: { key: 'heartRate' | 'hrv' | 'breathingRate', metric: StageMetric, name: string, unit: string, lead: string }[] = [
    { key: 'heartRate', metric: 'heartRate', name: 'Heart rate (bpm)', unit: 'bpm', lead: 'Ignore heart rate outside ' },
    { key: 'hrv', metric: 'hrv', name: 'HRV (ms)', unit: 'ms', lead: ', HRV outside ' },
    { key: 'breathingRate', metric: 'breathingRate', name: 'Breathing (br/min)', unit: 'br/min', lead: ', breathing outside ' },
  ]
  const seen = limits.map(l => formatMetricRange(l.metric, ranges[l.metric] ?? null)).filter((s): s is string => s !== null)

  if (editing) {
    return (
      <SignalRow actions={<DoneButton onClick={() => onEdit(false)} />}>
        <div className="flex flex-col gap-2 py-1">
          {limits.map(l => (
            <div key={l.key} className="flex flex-wrap items-center gap-2">
              <span className="w-40 text-[13px] text-fg-2">{l.name}</span>
              <NumberField label={`${l.name} minimum`} value={outliers[l.key].min} onChange={min => onChange({ ...outliers, [l.key]: { ...outliers[l.key], min } })} />
              <span className="text-fg-3">–</span>
              <NumberField label={`${l.name} maximum`} value={outliers[l.key].max} onChange={max => onChange({ ...outliers, [l.key]: { ...outliers[l.key], max } })} />
            </div>
          ))}
        </div>
      </SignalRow>
    )
  }
  return (
    <SignalRow>
      {limits.map(l => (
        <span key={l.key}>
          {l.lead}
          <DottedValue label={`${l.name} limits`} onClick={open}>{`${outliers[l.key].min}–${outliers[l.key].max}`}</DottedValue>
          {` ${l.unit}`}
        </span>
      ))}
      {seen.length > 0 && <Seen>{`${seenLabel} ${seen.join(' · ')}`}</Seen>}
    </SignalRow>
  )
}

export function SpikeRow({ value, onChange, editing, onEdit, dropped, readings, seenLabel }: {
  value: number
  onChange: (v: number) => void
  editing: boolean
  onEdit: (editing: boolean) => void
  dropped: number | null
  readings: number | null
  seenLabel: string
}) {
  return (
    <SignalRow actions={editing ? <DoneButton onClick={() => onEdit(false)} /> : undefined}>
      Drop heart-rate spikes beyond
      {' '}
      {editing
        ? <NumberField label="Heart-rate spike threshold" value={value} min={0} max={10} step={0.5} onChange={onChange} />
        : <DottedValue label="Heart-rate spike threshold" onClick={() => onEdit(true)}>{String(value)}</DottedValue>}
      {' standard deviations'}
      {value === 0 && <span className="text-fg-2"> (off)</span>}
      {dropped !== null && readings !== null && readings > 0 && value > 0 && (
        <Seen>{`dropped ${pct(dropped, readings)}% of readings ${seenLabel}`}</Seen>
      )}
    </SignalRow>
  )
}

export function LowSignalRow({ value, onChange, editing, onEdit, lowSignalNights, nights, children }: {
  value: number
  onChange: (v: number) => void
  editing: boolean
  onEdit: (editing: boolean) => void
  lowSignalNights: number | null
  nights: number
  children: ReactNode
}) {
  const seen = lowSignalNights === null
    ? null
    : nights <= 1
      ? (lowSignalNights > 0 ? 'used last night' : 'not needed last night')
      : `${lowSignalNights} of the last ${nights} nights`
  return (
    <SignalRow actions={editing ? <DoneButton onClick={() => onEdit(false)} /> : undefined}>
      {'When sensor calibration quality is below '}
      {editing
        ? <NumberField label="Low-signal threshold" value={value} min={0} max={1} step={0.05} onChange={onChange} />
        : <DottedValue label="Low-signal threshold" onClick={() => onEdit(true)}>{String(value)}</DottedValue>}
      , use the low-signal rules instead
      {seen && <Seen>{seen}</Seen>}
      <div className="mt-1.5 flex flex-col">{children}</div>
    </SignalRow>
  )
}

function SignalRow({ children, actions }: { children: ReactNode, actions?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-t border-line py-2.5 text-sm leading-[1.7]">
      <div className="min-w-0 flex-1">{children}</div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  )
}

/* ─── Cleanup ─────────────────────────────────────────────────────────── */

/**
 * "Never jump directly between Wake and Deep, or Deep and REM; pass through
 * Light · 4 transitions" — symmetric pairs read as one item.
 */
export function TransitionsRow({ transitions, onChange, editing, onEdit, fixes, seenLabel }: {
  transitions: StageTransition[]
  onChange: (t: StageTransition[]) => void
  editing: boolean
  onEdit: (editing: boolean) => void
  fixes: number | null
  seenLabel: string
}) {
  const open = () => onEdit(true)
  const addPair = () => {
    onChange([...transitions, ...nextTransitionPair(transitions)])
    onEdit(true)
  }
  const set = (i: number, t: StageTransition) => onChange(transitions.map((x, j) => (j === i ? t : x)))

  if (editing) {
    return (
      <div className="flex flex-col gap-2 border-t border-line py-2.5 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-fg-2">Transitions that must pass through another stage</span>
          <span className="ml-auto"><DoneButton onClick={() => onEdit(false)} /></span>
        </div>
        {transitions.map((t, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <SelectValue label={`Transition ${i + 1} from`} value={t.from} options={STAGE_OPTIONS} onChange={from => set(i, { ...t, from })} />
            <span className="text-fg-3">→</span>
            <SelectValue label={`Transition ${i + 1} to`} value={t.to} options={STAGE_OPTIONS} onChange={to => set(i, { ...t, to })} />
            <span className="text-xs text-fg-3">via</span>
            <SelectValue label={`Transition ${i + 1} via`} value={t.via} options={STAGE_OPTIONS} onChange={via => set(i, { ...t, via })} />
            <GhostIcon icon={X} size={14} label={`Remove transition ${i + 1}`} onClick={() => onChange(transitions.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="dashed" size="sm" icon={Plus} disabled={transitions.length >= 15} onClick={addPair}>Pair</Button>
          <Button
            variant="dashed"
            size="sm"
            icon={Plus}
            disabled={transitions.length >= 16}
            onClick={() => onChange([...transitions, { from: 'wake', to: 'deep', via: 'light' }])}
          >
            Transition
          </Button>
        </div>
      </div>
    )
  }

  const groups = groupTransitions(transitions)
  const vias = new Set(groups.map(g => g.via))
  const oneVia = vias.size === 1 ? groups[0].via : null
  const stage = (s: SleepStage, label: string) => (
    <DottedValue mono={false} color={STAGE_COLOR[s]} label={label} onClick={open}>{STAGE_LABELS[s]}</DottedValue>
  )

  return (
    <div className="border-t border-line py-2.5 text-sm leading-[1.7]">
      {groups.length === 0
        ? <span className="text-fg-2">Any stage may follow any other</span>
        : (
            <>
              <span className="text-fg-2">Never jump directly </span>
              {groups.map((g, i) => (
                <span key={i}>
                  {i > 0 && <span className="text-fg-2">, or </span>}
                  <span className="text-fg-2">{g.pair ? (i === 0 ? 'between ' : '') : 'from '}</span>
                  {stage(g.a, `Transition ${g.indexes[0] + 1} from`)}
                  <span className="text-fg-2">{g.pair ? ' and ' : ' to '}</span>
                  {stage(g.b, `Transition ${g.indexes[0] + 1} to`)}
                  {oneVia === null && (
                    <>
                      <span className="text-fg-2"> via </span>
                      {stage(g.via, `Transition ${g.indexes[0] + 1} via`)}
                    </>
                  )}
                </span>
              ))}
              {oneVia !== null && (
                <>
                  <span className="text-fg-2">; pass through </span>
                  {stage(oneVia, 'Transitions via')}
                </>
              )}
            </>
          )}
      {fixes !== null && transitions.length > 0 && <Seen>{`${fixes} ${fixes === 1 ? 'transition' : 'transitions'} ${seenLabel}`}</Seen>}
      <button
        type="button"
        onClick={addPair}
        disabled={transitions.length >= 15}
        className="ml-2 cursor-pointer border-0 bg-transparent p-0 text-[13px] text-fg-2 hover:text-fg disabled:opacity-45"
      >
        + pair
      </button>
    </div>
  )
}

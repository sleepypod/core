/**
 * Rule editor — a full page at /autopilot/<id> (or /autopilot/new), two
 * columns on wide screens. Left: WHEN / IF / THEN structured form. Right: live
 * "reads as" sentence + a backtest that re-runs against real history as you edit. Local state until explicit Save (no autosave).
 */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { PageHeader } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { Icon, type IconName } from './icons'
import { Button, Card, NumberField, SectionLabel, Segmented, Select, Toggle } from './primitives'
import { BacktestPanel } from './BacktestPanel'
import { CapZoneViz } from './CapZoneViz'
import {
  AGGS,
  type BuilderRule,
  buildSentence,
  DEFAULT_CLAMP,
  fmtClock,
  type IfSpec,
  parseExpr,
  SIGNALS,
  sigUnit,
  type ThenSpec,
  toAST,
  UI_OPS,
  type UiOp,
  type WhenSpec,
} from './builderModel'

function clone(r: BuilderRule): BuilderRule {
  return JSON.parse(JSON.stringify(r))
}

const numSignalOpts = SIGNALS.map(s => ({ value: s.id, label: s.label, icon: s.icon as IconName }))

// ---------- live sentence preview ----------
function SentencePreview({ rule }: { rule: BuilderRule }) {
  const chunks = buildSentence(rule)
  return (
    <Card className="px-[18px] py-4" style={{ borderColor: 'color-mix(in srgb, var(--accent-cool) 35%, transparent)' }}>
      <div className="mb-2 flex items-center gap-2 text-cool">
        <Icon.Sliders size={13} />
        <span className="sp-label text-cool">Reads as</span>
      </div>
      <p className="text-[15px] leading-relaxed text-fg-2 text-pretty">
        {chunks.map((c, i) => (
          <span key={i} className={cn(c.mono && 'font-mono', c.hot && 'font-medium text-cool')}>{c.text}</span>
        ))}
      </p>
    </Card>
  )
}

const TimeField = ({ value, onChange }: { value: string, onChange: (v: string) => void }) => {
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: `${String(h).padStart(2, '0')}:00`, label: fmtClock(`${String(h).padStart(2, '0')}:00`) }))
  return <Select chip value={value} options={hours} onChange={onChange} />
}

// ---------- WHEN ----------
function WhenEditor({ rule, set, range }: { rule: BuilderRule, set: (r: BuilderRule) => void, range: string | null }) {
  const w = rule.when
  const setW = (patch: Partial<WhenSpec>) => set({ ...rule, when: { ...w, ...patch } as WhenSpec })
  const types = [
    { value: 'agg', label: 'Aggregate' },
    { value: 'cond', label: 'Threshold' },
    { value: 'change', label: 'On change' },
    { value: 'time', label: 'Time of day' },
  ] as const
  const switchType = (t: WhenSpec['type']) => {
    if (t === 'agg') set({ ...rule, when: { type: 'agg', agg: 'avg', signal: '{side}.movement', window: 10, op: '>', value: 200 } })
    if (t === 'cond') set({ ...rule, when: { type: 'cond', signal: '{side}.heartRate', op: '>', value: 60 } })
    if (t === 'change') set({ ...rule, when: { type: 'change', signal: 'water.low' } })
    if (t === 'time') set({ ...rule, when: { type: 'time', between: ['23:00', '06:00'] } })
  }

  return (
    <Card className="px-[18px] py-4">
      <SectionLabel kicker="When" color="var(--accent-cool)" icon="Zap" desc="the trigger that starts evaluation" />
      <div className="mb-3"><Segmented size="sm" value={w.type} options={types} onChange={switchType} /></div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px] text-fg-2">
        {w.type === 'agg' && (
          <>
            <Select chip value={w.agg} options={[...AGGS]} onChange={v => setW({ agg: v as WhenSpec extends { agg: infer A } ? A : never })} />
            <span>of</span>
            <Select chip value={w.signal} options={numSignalOpts} onChange={v => setW({ signal: v })} />
            <Select chip value={w.op} options={['>', '≥', '<', '≤']} onChange={v => setW({ op: v as UiOp })} />
            <NumberField value={w.value} step={10} onChange={v => setW({ value: v })} width={92} />
            <span>over the last</span>
            <NumberField value={w.window} step={5} suffix="minutes" onChange={v => setW({ window: Math.max(1, v) })} width={84} />
            {range && <span className="basis-full font-mono text-[11px] text-fg-3" data-testid="threshold-range">{range}</span>}
          </>
        )}
        {w.type === 'cond' && (
          <>
            <Select chip value={w.signal} options={numSignalOpts} onChange={v => setW({ signal: v })} />
            <Select chip value={w.op} options={[...UI_OPS]} onChange={v => setW({ op: v as UiOp })} />
            <NumberField value={w.value} step={1} onChange={v => setW({ value: v })} width={92} />
            <span className="font-mono text-fg-3">{sigUnit(w.signal)}</span>
            {range && <span className="font-mono text-[11px] text-fg-3" data-testid="threshold-range">{range}</span>}
          </>
        )}
        {w.type === 'change' && (
          <>
            <Select chip value={w.signal} options={numSignalOpts} onChange={v => setW({ signal: v })} />
            <span>changes</span>
          </>
        )}
        {w.type === 'time' && (
          <>
            <span>between</span>
            <TimeField value={w.between[0]} onChange={v => setW({ between: [v, w.between[1]] })} />
            <span>and</span>
            <TimeField value={w.between[1]} onChange={v => setW({ between: [w.between[0], v] })} />
          </>
        )}
      </div>
    </Card>
  )
}

// ---------- IF ----------
function IfEditor({ rule, set }: { rule: BuilderRule, set: (r: BuilderRule) => void }) {
  const ifs = rule.ifs
  const setIfs = (arr: IfSpec[]) => set({ ...rule, ifs: arr })
  const add = (kind: 'time' | 'cond') => {
    if (kind === 'time') setIfs([...ifs, { type: 'time', between: ['23:00', '06:00'] }])
    else setIfs([...ifs, { type: 'cond', signal: '{side}.currentTemperature', op: '>', value: 75 }])
  }
  const upd = (i: number, patch: Partial<IfSpec>) => setIfs(ifs.map((c, k) => k === i ? { ...c, ...patch } as IfSpec : c))
  const del = (i: number) => setIfs(ifs.filter((_, k) => k !== i))

  return (
    <Card className="px-[18px] py-4">
      <SectionLabel kicker="If" color="var(--text-2)" icon="Shield" desc="extra conditions — all must hold (AND)" right={<span className="text-[12px] text-fg-3">optional</span>} />
      {ifs.length === 0 && <div className="mb-3 text-[12px] text-fg-3">No conditions — fires whenever the trigger hits.</div>}
      <div className="mb-3 flex flex-col gap-2">
        {ifs.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-ctl border border-line bg-code px-2.5 py-2">
            <span className="sp-label mr-1">and</span>
            {c.type === 'time'
              ? (
                  <>
                    <span className="text-[13px] text-fg-2">it&apos;s between</span>
                    <TimeField value={c.between[0]} onChange={v => upd(i, { between: [v, c.between[1]] })} />
                    <span className="text-[13px] text-fg-2">and</span>
                    <TimeField value={c.between[1]} onChange={v => upd(i, { between: [c.between[0], v] })} />
                  </>
                )
              : (
                  <>
                    <Select chip value={c.signal} options={numSignalOpts} onChange={v => upd(i, { signal: v })} />
                    <Select chip value={c.op} options={[...UI_OPS]} onChange={v => upd(i, { op: v as UiOp })} />
                    <NumberField value={c.value} step={1} onChange={v => upd(i, { value: v })} width={88} />
                  </>
                )}
            <button type="button" aria-label="Remove condition" onClick={() => del(i)} className="ml-auto text-fg-3 hover:text-danger"><Icon.X size={14} /></button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => add('time')}>
          <Icon.Clock size={13} />
          Time window
        </Button>
        <Button variant="outline" size="sm" onClick={() => add('cond')}>
          <Icon.Plus size={13} />
          Condition
        </Button>
      </div>
    </Card>
  )
}

// ---------- THEN ----------
function ThenEditor({ rule, set, liveAmbient }: { rule: BuilderRule, set: (r: BuilderRule) => void, liveAmbient: number | null }) {
  const a = rule.then[0]
  const setA = (patch: Partial<ThenSpec>) => set({ ...rule, then: [{ ...a, ...patch } as ThenSpec, ...rule.then.slice(1)] })
  const isTemp = a.action === 'setTemperature'
  const isExpr = isTemp && a.expr != null
  const clamp = isTemp ? a.clamp : DEFAULT_CLAMP

  const exprEval = useMemo(() => {
    if (!isTemp || a.expr == null || liveAmbient == null) return null
    const parsed = parseExpr(a.expr, rule.side)
    if (!parsed) return null
    // Only the ambient-relative form has a live readout in the editor.
    const m = /^\s*ambient\s*([+-])\s*(\d+(?:\.\d+)?)\s*$/i.exec(a.expr)
    const raw = m ? liveAmbient + (m[1] === '-' ? -1 : 1) * Number(m[2]) : (/^\s*ambient\s*$/i.test(a.expr) ? liveAmbient : null)
    if (raw == null) return null
    return Math.min(clamp[1], Math.max(clamp[0], raw))
  }, [isTemp, a, liveAmbient, rule.side, clamp])

  return (
    <Card className="px-[18px] py-4">
      <SectionLabel kicker="Then" color="var(--status-ok)" icon="Play" desc="what Autopilot does when it fires" />
      <div className="mb-3 flex items-center gap-2">
        <Select
          chip
          value={a.action}
          options={[{ value: 'setTemperature', label: 'Set temperature' }, { value: 'setPower', label: 'Set power' }, { value: 'notify', label: 'Notify' }]}
          onChange={(v) => {
            if (v === 'setTemperature') setA({ action: 'setTemperature', delta: -2, revert: undefined, expr: undefined, clamp: [...DEFAULT_CLAMP] } as ThenSpec)
            else if (v === 'setPower') setA({ action: 'setPower', on: false } as ThenSpec)
            else setA({ action: 'notify', message: '' } as ThenSpec)
          }}
        />
      </div>

      {isTemp && (
        <div className="flex flex-col gap-3">
          <Segmented size="sm" value={isExpr ? 'expr' : 'amount'} options={[{ value: 'amount', label: 'By amount' }, { value: 'expr', label: 'Expression' }]} onChange={v => v === 'expr' ? setA({ expr: 'ambient + 3', delta: undefined, revert: undefined }) : setA({ expr: undefined, delta: -2 })} />

          {!isExpr && (
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-2">
              <Select chip value={(a.delta ?? -2) < 0 ? 'lower' : 'raise'} options={['lower', 'raise']} onChange={v => setA({ delta: (v === 'lower' ? -1 : 1) * Math.abs(a.delta ?? 2) })} />
              <span>by</span>
              <NumberField value={Math.abs(a.delta ?? 2)} step={1} suffix="°F" onChange={v => setA({ delta: ((a.delta ?? -2) < 0 ? -1 : 1) * Math.max(0, v) })} width={84} />
              <label className="ml-1 inline-flex items-center gap-2 text-[12px] text-fg-2">
                <Toggle size="sm" label="Revert after" checked={!!a.revert} onChange={v => setA({ revert: v ? 20 : undefined })} />
                revert after
              </label>
              {a.revert ? <NumberField value={a.revert} step={5} suffix="minutes" onChange={v => setA({ revert: Math.max(1, v) })} width={78} /> : null}
            </div>
          )}

          {isExpr && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Icon.Function size={14} className="text-icon" />
                <input value={a.expr} onChange={e => setA({ expr: e.target.value })} spellCheck={false} aria-label="Temperature expression" className="min-w-0 flex-1 rounded-ctl border border-line-2 bg-field px-3 py-2 font-mono text-[14px] text-ok focus:border-fg-3 focus:outline-none" />
                {exprEval != null && (
                  <span className="whitespace-nowrap rounded-ctl border border-line-2 px-2 py-2 font-mono text-[12px] text-fg-2">
                    =
                    <span className="text-fg">
                      {Math.round(exprEval)}
                      °F
                    </span>
                    {' '}
                    now
                  </span>
                )}
              </div>
              <div className="text-[12px] text-fg-3">
                Variables:
                <span className="font-mono text-fg-2">ambient</span>
                ,
                <span className="font-mono text-fg-2">target</span>
                ,
                <span className="font-mono text-fg-2">current</span>
                . Evaluated every tick.
              </div>
            </div>
          )}

          <div className="rounded-ctl border border-line bg-code p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Icon.Shield size={13} className="text-warn" />
              <span className="text-[13px] font-medium text-fg">Safety clamp</span>
              <span className="text-[12px] text-fg-3">never command outside these bounds</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-2">
              <span>min</span>
              <NumberField value={clamp[0]} step={1} suffix="°F" onChange={v => setA({ clamp: [v, clamp[1]] })} width={84} />
              <span>max</span>
              <NumberField value={clamp[1]} step={1} suffix="°F" onChange={v => setA({ clamp: [clamp[0], v] })} width={84} />
            </div>
          </div>
        </div>
      )}

      {a.action === 'notify' && (
        <input value={a.message} onChange={e => setA({ message: e.target.value })} placeholder="Notification message…" aria-label="Notification message" className="w-full rounded-ctl border border-line-2 bg-field px-3 py-2 text-[13px] text-fg placeholder:text-fg-3 focus:border-fg-3 focus:outline-none" />
      )}
      {a.action === 'setPower' && (
        <Segmented size="sm" value={a.on ? 'on' : 'off'} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} onChange={v => setA({ on: v === 'on' })} />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-[12px] text-fg-2">
        <label className="inline-flex items-center gap-2">
          <Icon.Clock size={13} className="text-icon" />
          cooldown
          <NumberField value={rule.cooldown} step={5} suffix="minutes" onChange={v => set({ ...rule, cooldown: Math.max(0, v) })} width={80} />
        </label>
      </div>
    </Card>
  )
}

// ---------- page ----------
export function RuleEditor({ automation, onClose, onSave, saving }: { automation: BuilderRule, onClose: () => void, onSave: (r: BuilderRule) => void, saving?: boolean }) {
  const [rule, setRule] = useState<BuilderRule>(() => clone(automation))
  const backtestSide = rule.side === 'right' ? 'right' : 'left'

  // Debounce the rule before backtesting so we don't replay on every keystroke.
  const [debounced, setDebounced] = useState(rule)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(rule), 350)
    return () => clearTimeout(t)
  }, [rule])

  const nightsQ = trpc.automations.nights.useQuery({ side: backtestSide, limit: 5 })
  const nights = useMemo(() => nightsQ.data ?? [], [nightsQ.data])
  // The picked night, falling back to the most recent — derived, not an effect.
  const [picked, setPicked] = useState<number | null>(null)
  // Drop a picked id that isn't in the current side's nights, so switching
  // sides doesn't send a stale sleepRecordId until the user re-picks.
  const resolvedPicked = picked != null && nights.some(n => n.sleepRecordId === picked) ? picked : null
  const nightId = resolvedPicked ?? nights[0]?.sleepRecordId ?? null

  const ambientQ = trpc.environment.getLatestBedTemp.useQuery({ unit: 'F' })
  const liveAmbient = ambientQ.data?.ambientTemp ?? null

  // Show the live capacitive zone viz when the rule reads a pressure signal —
  // "zone" is meaningless as a bare number without it.
  const usesCapSignal = useMemo(() => {
    const sigs: string[] = []
    if ('signal' in rule.when && rule.when.signal) sigs.push(rule.when.signal)
    for (const c of rule.ifs) if (c.type === 'cond') sigs.push(c.signal)
    return sigs.some(s => s.startsWith('{side}.cap.'))
  }, [rule])

  const ast = useMemo(() => toAST(debounced), [debounced])
  const backtestQ = trpc.automations.backtest.useQuery(
    {
      side: backtestSide,
      sleepRecordId: nightId ?? undefined,
      rule: { side: ast.side, cooldownMin: ast.cooldownMin, trigger: ast.trigger, conditions: ast.conditions, actions: ast.actions },
    },
    { enabled: nights.length > 0, placeholderData: prev => prev },
  )

  // The compared value's recorded range, so the threshold isn't set out of reach.
  const hasThreshold = debounced.when.type === 'agg' || debounced.when.type === 'cond'
  const rangeQ = trpc.automations.backtestRange.useQuery(
    { nights: 5, rule: { side: ast.side, cooldownMin: ast.cooldownMin, trigger: ast.trigger, conditions: ast.conditions, actions: ast.actions } },
    { enabled: hasThreshold && nights.length > 0, placeholderData: prev => prev },
  )
  const range = hasThreshold && rangeQ.data && rangeQ.data.nights > 0 && rangeQ.data.low != null && rangeQ.data.peak != null
    ? `last ${rangeQ.data.nights} night${rangeQ.data.nights === 1 ? '' : 's'}: ${fmtRange(rangeQ.data.low)}–${fmtRange(rangeQ.data.peak)}`
    : null

  return (
    <>
      <span className="-mb-2 hidden font-mono text-[13px] text-fg-2 min-[900px]:block">Autopilot / Automations /</span>
      <PageHeader
        back={<span className="min-[900px]:hidden">Automations</span>}
        onBack={onClose}
        className="[&>button]:min-[900px]:hidden"
        title={(
          <input
            aria-label="Automation name"
            value={rule.name}
            onChange={e => setRule({ ...rule, name: e.target.value })}
            className="w-[min(70vw,420px)] min-w-0 rounded-thumb bg-transparent font-medium text-fg focus:bg-field focus:outline-none"
          />
        )}
        right={(
          <>
            <span className="text-[12px] text-fg-3 max-[899px]:hidden">Nothing is saved until you press Save.</span>
            <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
            <Button variant="accent" size="md" onClick={() => onSave(rule)} disabled={saving}>
              <Icon.Check size={15} />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        )}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="sp-label">Side</span>
          <Segmented size="sm" value={rule.side} options={[{ value: 'left', label: 'L' }, { value: 'right', label: 'R' }, { value: 'both', label: 'Both' }]} onChange={v => setRule({ ...rule, side: v })} />
        </div>
        <div className="flex items-center gap-2">
          <span className="sp-label">Mode</span>
          <Segmented size="sm" value={rule.mode} options={[{ value: 'dryrun', label: 'Dry-run' }, { value: 'active', label: 'Active' }]} onChange={v => setRule({ ...rule, mode: v, enabled: true })} />
        </div>
      </div>

      <div className="grid min-w-0 gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <WhenEditor rule={rule} set={setRule} range={range} />
          <div className="flex justify-center"><Icon.ArrowDown size={16} className="text-fg-3" /></div>
          <IfEditor rule={rule} set={setRule} />
          <div className="flex justify-center"><Icon.ArrowDown size={16} className="text-fg-3" /></div>
          <ThenEditor rule={rule} set={setRule} liveAmbient={liveAmbient} />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {rule.mode === 'dryrun' && (
            <div className="flex items-center gap-2 rounded-ctl border border-warn-line bg-warn-bg px-3 py-2 text-[12px] text-warn">
              <Icon.Flask size={14} className="shrink-0" />
              Dry-run: Autopilot logs what it would do but never touches hardware.
            </div>
          )}
          <SentencePreview rule={rule} />
          {usesCapSignal && <CapZoneViz side={rule.side} backtestSide={backtestSide} nightId={nightId} />}
          <Card className="px-[18px] py-4">
            <BacktestPanel
              result={backtestQ.data?.ok ? (backtestQ.data.result as Parameters<typeof BacktestPanel>[0]['result']) : null}
              loading={backtestQ.isLoading || backtestQ.isFetching}
              message={nights.length === 0 ? (nightsQ.isLoading ? undefined : 'No recorded nights for this side yet — backtest needs sleep history.') : (backtestQ.data && !backtestQ.data.ok ? backtestQ.data.message : undefined)}
              nights={nights}
              nightId={nightId}
              onNight={setPicked}
            />
          </Card>
          <div className="flex items-start gap-2 text-[12px] leading-relaxed text-fg-3">
            <Icon.Shield size={13} className="mt-0.5 shrink-0" />
            Backtest replays real recorded sensor history against your current settings. Nothing here changes your bed — it&apos;s a dry preview of how this rule would have behaved.
          </div>
        </div>
      </div>
    </>
  )
}

function fmtRange(v: number): string {
  return Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
}

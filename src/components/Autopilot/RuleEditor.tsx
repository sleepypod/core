/**
 * Rule editor — full-screen, two-pane. Left: WHEN / IF / THEN structured form.
 * Right: sticky live "reads as" sentence + a backtest that re-runs against real
 * history as you edit. Local state until explicit Save (no autosave).
 */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Icon, type IconName } from './icons'
import { Button, Card, NumberField, SectionLabel, Segmented, Select, Toggle } from './primitives'
import { BacktestPanel } from './BacktestPanel'
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
    <Card className="p-4" style={{ background: 'color-mix(in srgb, var(--accent) 7%, #0a0a0b)', borderColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' }}>
      <div className="flex items-center gap-2 mb-2">
        <Icon.Sliders size={13} style={{ color: 'var(--accent)' }} />
        <span className="text-[11px] font-semibold tracking-[0.12em] uppercase" style={{ color: 'var(--accent)' }}>Reads as</span>
      </div>
      <p className="text-[15px] leading-relaxed text-zinc-300" style={{ textWrap: 'pretty' }}>
        {chunks.map((c, i) => (
          <span key={i} className={c.mono ? 'mono' : ''} style={c.hot ? { color: 'var(--accent)', fontWeight: 500 } : undefined}>{c.text}</span>
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
function WhenEditor({ rule, set }: { rule: BuilderRule, set: (r: BuilderRule) => void }) {
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
    <Card className="p-4">
      <SectionLabel kicker="When" color="var(--accent)" icon="Zap" desc="the trigger that starts evaluation" />
      <div className="mb-3"><Segmented size="sm" value={w.type} options={types} onChange={switchType} /></div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px] text-zinc-400">
        {w.type === 'agg' && (
          <>
            <Select chip value={w.agg} options={[...AGGS]} onChange={v => setW({ agg: v as WhenSpec extends { agg: infer A } ? A : never })} />
            <span>of</span>
            <Select chip value={w.signal} options={numSignalOpts} onChange={v => setW({ signal: v })} />
            <Select chip value={w.op} options={['>', '≥', '<', '≤']} onChange={v => setW({ op: v as UiOp })} />
            <NumberField value={w.value} step={10} onChange={v => setW({ value: v })} width={92} />
            <span>over the last</span>
            <NumberField value={w.window} step={5} suffix="m" onChange={v => setW({ window: Math.max(1, v) })} width={84} />
          </>
        )}
        {w.type === 'cond' && (
          <>
            <Select chip value={w.signal} options={numSignalOpts} onChange={v => setW({ signal: v })} />
            <Select chip value={w.op} options={[...UI_OPS]} onChange={v => setW({ op: v as UiOp })} />
            <NumberField value={w.value} step={1} onChange={v => setW({ value: v })} width={92} />
            <span className="text-zinc-500">{sigUnit(w.signal)}</span>
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
    <Card className="p-4">
      <SectionLabel kicker="If" color="#a1a1aa" icon="Shield" desc="extra conditions — all must hold (AND)" right={<span className="text-[11px] text-zinc-600">optional</span>} />
      {ifs.length === 0 && <div className="text-[12px] text-zinc-600 mb-3">No conditions — fires whenever the trigger hits.</div>}
      <div className="flex flex-col gap-2 mb-3">
        {ifs.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-2.5 py-2">
            <span className="mono text-[10px] uppercase tracking-wide text-zinc-600 mr-1">and</span>
            {c.type === 'time'
              ? (
                  <>
                    <span className="text-[13px] text-zinc-400">it&apos;s between</span>
                    <TimeField value={c.between[0]} onChange={v => upd(i, { between: [v, c.between[1]] })} />
                    <span className="text-[13px] text-zinc-400">and</span>
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
            <button type="button" onClick={() => del(i)} className="ml-auto text-zinc-600 hover:text-red-400"><Icon.X size={14} /></button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
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
    <Card className="p-4">
      <SectionLabel kicker="Then" color="#22c55e" icon="Play" desc="what Autopilot does when it fires" />
      <div className="flex items-center gap-2 mb-3">
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
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-zinc-400">
              <Select chip value={(a.delta ?? -2) < 0 ? 'lower' : 'raise'} options={['lower', 'raise']} onChange={v => setA({ delta: (v === 'lower' ? -1 : 1) * Math.abs(a.delta ?? 2) })} />
              <span>by</span>
              <NumberField value={Math.abs(a.delta ?? 2)} step={1} suffix="°F" onChange={v => setA({ delta: ((a.delta ?? -2) < 0 ? -1 : 1) * Math.max(0, v) })} width={84} />
              <label className="ml-1 inline-flex items-center gap-2 text-[12px] text-zinc-400">
                <Toggle size="sm" checked={!!a.revert} onChange={v => setA({ revert: v ? 20 : undefined })} />
                revert after
              </label>
              {a.revert ? <NumberField value={a.revert} step={5} suffix="m" onChange={v => setA({ revert: Math.max(1, v) })} width={78} /> : null}
            </div>
          )}

          {isExpr && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Icon.Function size={14} className="text-zinc-500" />
                <input value={a.expr} onChange={e => setA({ expr: e.target.value })} spellCheck={false} className="mono flex-1 rounded-lg border border-zinc-700/70 bg-zinc-950/70 px-3 py-2 text-[14px] text-emerald-300 focus:border-zinc-500 focus:outline-none" />
                {exprEval != null && (
                  <span className="mono whitespace-nowrap rounded-md border border-zinc-700/60 bg-zinc-900/60 px-2 py-2 text-[12px] text-zinc-400">
                    =
                    <span className="text-zinc-100">
                      {Math.round(exprEval)}
                      °F
                    </span>
                    {' '}
                    now
                  </span>
                )}
              </div>
              <div className="text-[11px] text-zinc-600">
                Variables:
                <span className="mono text-zinc-400">ambient</span>
                ,
                <span className="mono text-zinc-400">target</span>
                ,
                <span className="mono text-zinc-400">current</span>
                . Evaluated every tick.
              </div>
            </div>
          )}

          <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Icon.Shield size={13} className="text-amber-400" />
              <span className="text-[12px] font-medium text-zinc-300">Safety clamp</span>
              <span className="text-[11px] text-zinc-600">never command outside these bounds</span>
            </div>
            <div className="flex items-center gap-2 text-[13px] text-zinc-400">
              <span>min</span>
              <NumberField value={clamp[0]} step={1} suffix="°F" onChange={v => setA({ clamp: [v, clamp[1]] })} width={84} />
              <span>max</span>
              <NumberField value={clamp[1]} step={1} suffix="°F" onChange={v => setA({ clamp: [clamp[0], v] })} width={84} />
            </div>
          </div>
        </div>
      )}

      {a.action === 'notify' && (
        <input value={a.message} onChange={e => setA({ message: e.target.value })} placeholder="Notification message…" className="w-full rounded-lg border border-zinc-700/70 bg-zinc-950/70 px-3 py-2 text-[13px] text-zinc-200 focus:border-zinc-500 focus:outline-none" />
      )}
      {a.action === 'setPower' && (
        <Segmented size="sm" value={a.on ? 'on' : 'off'} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} onChange={v => setA({ on: v === 'on' })} />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-800/70 pt-3 text-[12px] text-zinc-400">
        <label className="inline-flex items-center gap-2">
          <Icon.Clock size={13} className="text-zinc-500" />
          cooldown
          <NumberField value={rule.cooldown} step={5} suffix="m" onChange={v => set({ ...rule, cooldown: Math.max(0, v) })} width={80} />
        </label>
      </div>
    </Card>
  )
}

// ---------- modal ----------
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

  const ast = useMemo(() => toAST(debounced), [debounced])
  const backtestQ = trpc.automations.backtest.useQuery(
    {
      side: backtestSide,
      sleepRecordId: nightId ?? undefined,
      rule: { side: ast.side, cooldownMin: ast.cooldownMin, trigger: ast.trigger, conditions: ast.conditions, actions: ast.actions },
    },
    { enabled: nights.length > 0, placeholderData: prev => prev },
  )

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-zinc-950/95 backdrop-blur-sm ap-console" style={{ animation: 'apFade .15s ease' }}>
      <div className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"><Icon.X size={17} /></button>
        <input value={rule.name} onChange={e => setRule({ ...rule, name: e.target.value })} className="min-w-0 flex-1 max-w-sm bg-transparent text-[16px] font-semibold text-zinc-100 focus:outline-none" />
        <div className="ml-auto flex items-center gap-3">
          <Segmented size="sm" value={rule.side} options={[{ value: 'left', label: 'L' }, { value: 'right', label: 'R' }, { value: 'both', label: 'Both' }]} onChange={v => setRule({ ...rule, side: v })} />
          <div className="h-5 w-px bg-zinc-800" />
          <Segmented size="sm" value={rule.mode} options={[{ value: 'dryrun', label: 'Dry-run' }, { value: 'active', label: 'Active' }]} onChange={v => setRule({ ...rule, mode: v, enabled: true })} />
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="accent" size="md" onClick={() => onSave(rule)} disabled={saving}>
            <Icon.Check size={15} />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="w-[44%] min-w-[420px] overflow-y-auto border-r border-zinc-800 p-5">
          <div className="mx-auto flex max-w-xl flex-col gap-3">
            <WhenEditor rule={rule} set={setRule} />
            <div className="flex justify-center"><Icon.ArrowDown size={16} className="text-zinc-700" /></div>
            <IfEditor rule={rule} set={setRule} />
            <div className="flex justify-center"><Icon.ArrowDown size={16} className="text-zinc-700" /></div>
            <ThenEditor rule={rule} set={setRule} liveAmbient={liveAmbient} />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-zinc-950/40 p-5">
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {rule.mode === 'dryrun' && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-400">
                <Icon.Flask size={14} />
                Dry-run: Autopilot logs what it would do but never touches hardware.
              </div>
            )}
            <SentencePreview rule={rule} />
            <Card className="p-4">
              <BacktestPanel
                result={backtestQ.data?.ok ? (backtestQ.data.result as Parameters<typeof BacktestPanel>[0]['result']) : null}
                loading={backtestQ.isLoading || backtestQ.isFetching}
                message={nights.length === 0 ? (nightsQ.isLoading ? undefined : 'No recorded nights for this side yet — backtest needs sleep history.') : (backtestQ.data && !backtestQ.data.ok ? backtestQ.data.message : undefined)}
                nights={nights}
                nightId={nightId}
                onNight={setPicked}
              />
            </Card>
            <div className="flex items-start gap-2 text-[11px] text-zinc-600">
              <Icon.Shield size={13} className="mt-0.5 shrink-0 text-zinc-600" />
              Backtest replays real recorded sensor history against your current settings. Nothing here changes your bed — it&apos;s a dry preview of how this rule would have behaved.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Builder model — the friendly WHEN/IF/THEN shape the editor edits, plus a
 * bidirectional mapping to the engine AST (src/automation/types.ts) that the
 * router stores and the engine evaluates.
 *
 * The engine model is narrower than the UI: a rule is one `trigger`
 * (tick | signalChange | timeOfDay) + one `condition` tree + `actions[]` whose
 * params are numeric expressions. The builder's WHEN/IF collapse into
 * trigger + an AND of conditions; "lower by 2°F" becomes
 * `setTemperature(currentTemperature − 2)`, "ambient + 3" becomes
 * `setTemperature(ambient.temperature + 3)`. All signals the engine sees are
 * numeric, so the catalog here is the numeric/back-testable subset of the full
 * catalog in docs/adr/0023-autopilot-reactive-automations.md. Enum/bool signals (sleep stage, occupancy)
 * are a later phase once those sources are wired.
 *
 * Round-trip contract: `fromAST(toAST(b))` preserves any rule the editor can
 * build. `toAST` resolves the `{side}` template against the rule's side.
 */

import type {
  Action,
  Condition,
  Expr,
  Side,
  Trigger,
} from '@/src/automation/types'

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type SignalKind = 'num'
export interface SignalDef {
  id: string // may contain the {side} template
  label: string
  unit: string
  kind: SignalKind
  group: 'Room' | 'Bed' | 'Bio' | 'Presence' | 'System'
  icon: string
  perSide?: boolean
  max?: number
  /** Live-only: no granular history, so it reads live but can't be back-tested. */
  liveOnly?: boolean
}

/** Numeric, engine-evaluable signals (subset wired for live read and/or backtest). */
export const SIGNALS: SignalDef[] = [
  { id: 'ambient.temperature', label: 'Ambient temp', unit: '°F', kind: 'num', group: 'Room', icon: 'Thermometer' },
  { id: 'ambient.humidity', label: 'Ambient humidity', unit: '%', kind: 'num', group: 'Room', icon: 'Droplet' },
  { id: 'ambient.light', label: 'Ambient light', unit: 'lux', kind: 'num', group: 'Room', icon: 'Moon' },
  { id: '{side}.currentTemperature', label: 'Current temp (level)', unit: '°F', kind: 'num', group: 'Bed', icon: 'Thermometer', perSide: true },
  { id: '{side}.targetTemperature', label: 'Target temp (level)', unit: '°F', kind: 'num', group: 'Bed', icon: 'Thermometer', perSide: true },
  { id: '{side}.surfaceTemp', label: 'Bed surface temp', unit: '°F', kind: 'num', group: 'Bed', icon: 'Thermometer', perSide: true },
  { id: '{side}.surfaceTemp.spread', label: 'Surface temp spread', unit: '°F', kind: 'num', group: 'Bed', icon: 'Thermometer', perSide: true },
  { id: '{side}.surfaceTemp.gradient', label: 'Surface temp gradient', unit: '°F', kind: 'num', group: 'Bed', icon: 'Thermometer', perSide: true },
  { id: '{side}.waterTemp', label: 'Water temp', unit: '°F', kind: 'num', group: 'Bed', icon: 'Droplet', perSide: true },
  { id: '{side}.movement', label: 'Movement', unit: '', kind: 'num', group: 'Bio', icon: 'Activity', perSide: true, max: 1000 },
  { id: '{side}.heartRate', label: 'Heart rate', unit: 'bpm', kind: 'num', group: 'Bio', icon: 'Heart', perSide: true },
  { id: '{side}.hrv', label: 'HRV', unit: 'ms', kind: 'num', group: 'Bio', icon: 'Pulse', perSide: true },
  { id: '{side}.breathingRate', label: 'Breathing rate', unit: 'brpm', kind: 'num', group: 'Bio', icon: 'Wind', perSide: true },
  // Capacitive presence sensing (not temperature): per-zone body-contact load.
  { id: '{side}.cap.max', label: 'Bed pressure (peak)', unit: '', kind: 'num', group: 'Presence', icon: 'Activity', perSide: true, liveOnly: true },
  { id: '{side}.cap.mean', label: 'Bed pressure (avg)', unit: '', kind: 'num', group: 'Presence', icon: 'Activity', perSide: true, liveOnly: true },
  { id: '{side}.cap.spread', label: 'Pressure spread', unit: '', kind: 'num', group: 'Presence', icon: 'Activity', perSide: true, liveOnly: true },
  { id: 'water.low', label: 'Water low', unit: '', kind: 'num', group: 'System', icon: 'Droplet' },
]

export const AGGS = ['avg', 'max', 'min', 'sum', 'count'] as const
export type UiAgg = typeof AGGS[number]

/** Display operators (UI) ↔ engine CompareOp. */
export const UI_OPS = ['>', '≥', '<', '≤', '==', '≠'] as const
export type UiOp = typeof UI_OPS[number]
const UI_TO_OP: Record<UiOp, '>' | '>=' | '<' | '<=' | '==' | '!='> = { '>': '>', '≥': '>=', '<': '<', '≤': '<=', '==': '==', '≠': '!=' }
const OP_TO_UI: Record<string, UiOp> = { '>': '>', '>=': '≥', '<': '<', '<=': '≤', '==': '==', '!=': '≠' }

export const ACTIONS = [
  { id: 'setTemperature', label: 'Set temperature' },
  { id: 'setPower', label: 'Set power' },
  { id: 'notify', label: 'Notify' },
] as const

// ---------------------------------------------------------------------------
// Builder model
// ---------------------------------------------------------------------------

export type WhenSpec
  = | { type: 'agg', agg: UiAgg, signal: string, window: number, op: UiOp, value: number }
    | { type: 'cond', signal: string, op: UiOp, value: number }
    | { type: 'change', signal: string }
    | { type: 'time', between: [string, string] }

export type IfSpec
  = | { type: 'time', between: [string, string] }
    | { type: 'cond', signal: string, op: UiOp, value: number }

export type ThenSpec
  = | { action: 'setTemperature', delta?: number, revert?: number, expr?: string, clamp: [number, number] }
    | { action: 'setPower', on: boolean }
    | { action: 'notify', message: string }

export interface BuilderRule {
  id?: number
  name: string
  enabled: boolean
  mode: 'dryrun' | 'active'
  side: 'left' | 'right' | 'both'
  priority: number
  when: WhenSpec
  ifs: IfSpec[]
  then: ThenSpec[]
  cooldown: number // minutes
}

export const DEFAULT_CLAMP: [number, number] = [60, 75]

/** A fresh, valid blank rule for the editor. */
export function blankRule(): BuilderRule {
  return {
    name: 'New automation',
    enabled: true,
    mode: 'dryrun',
    side: 'both',
    priority: 0,
    when: { type: 'agg', agg: 'avg', signal: '{side}.movement', window: 10, op: '>', value: 200 },
    ifs: [{ type: 'time', between: ['23:00', '06:00'] }],
    then: [{ action: 'setTemperature', delta: -2, revert: 20, clamp: [...DEFAULT_CLAMP] }],
    cooldown: 30,
  }
}

// ---------------------------------------------------------------------------
// Side / signal-key resolution
// ---------------------------------------------------------------------------

function concreteSide(side: BuilderRule['side']): Side {
  return side === 'right' ? 'right' : 'left'
}

/** Resolve a `{side}.x` template to a concrete key using the rule side. */
export function resolveSignal(template: string, side: BuilderRule['side']): string {
  return template.replace('{side}', concreteSide(side))
}

/** Reverse: turn a concrete `left.x`/`right.x` back into `{side}.x` if it matches. */
function templatize(key: string, side: BuilderRule['side']): string {
  const s = concreteSide(side)
  return key.startsWith(`${s}.`) ? key.replace(`${s}.`, '{side}.') : key
}

// ---------------------------------------------------------------------------
// Expression parse / print (THEN expression mode)
// ---------------------------------------------------------------------------

const VAR_TO_SIGNAL: Record<string, string> = {
  ambient: 'ambient.temperature',
  current: '{side}.currentTemperature',
  target: '{side}.targetTemperature',
}
const SIGNAL_TO_VAR: Record<string, string> = {
  'ambient.temperature': 'ambient',
  '{side}.currentTemperature': 'current',
  '{side}.targetTemperature': 'target',
}

/** Parse "ambient + 3", "target - 2", "72", "current" → Expr (null if invalid). */
export function parseExpr(input: string, side: BuilderRule['side']): Expr | null {
  const s = input.trim()
  if (!s) return null
  // bare number
  if (/^-?\d+(\.\d+)?$/.test(s)) return { kind: 'literal', value: Number(s) }
  const m = /^([a-z]+)\s*(?:([+\-*/])\s*(-?\d+(?:\.\d+)?))?$/i.exec(s)
  if (!m) return null
  const varName = m[1].toLowerCase()
  const tmpl = VAR_TO_SIGNAL[varName]
  if (!tmpl) return null
  const signal: Expr = { kind: 'signal', signal: resolveSignal(tmpl, side) }
  if (!m[2]) return signal
  return { kind: 'binary', op: m[2] as '+' | '-' | '*' | '/', left: signal, right: { kind: 'literal', value: Number(m[3]) } }
}

/** Print an Expr back to the editor's variable syntax (best-effort). */
export function printExpr(e: Expr, side: BuilderRule['side']): string {
  switch (e.kind) {
    case 'literal':
      return String(e.value)
    case 'signal': {
      const t = templatize(e.signal, side)
      return SIGNAL_TO_VAR[t] ?? t
    }
    case 'binary':
      return `${printExpr(e.left, side)} ${e.op} ${printExpr(e.right, side)}`
    case 'clamp':
      return printExpr(e.value, side)
    default:
      return ''
  }
}

// ---------------------------------------------------------------------------
// builder → AST
// ---------------------------------------------------------------------------

export interface RuleAST {
  name: string
  enabled: boolean
  side: Side | null
  priority: number
  dryRun: boolean
  cooldownMin: number | null
  trigger: Trigger
  conditions: Condition
  actions: Action[]
}

function whenToTrigger(when: WhenSpec, side: BuilderRule['side']): Trigger {
  if (when.type === 'change') return { kind: 'signalChange', signal: resolveSignal(when.signal, side) }
  // agg / cond / time are all evaluated on the global tick; the time/threshold
  // lives in the condition tree.
  return { kind: 'tick', everyMin: 1 }
}

function whenToCondition(when: WhenSpec, side: BuilderRule['side']): Condition | null {
  switch (when.type) {
    case 'agg':
      return {
        kind: 'compare',
        op: UI_TO_OP[when.op],
        left: { kind: 'window', fn: when.agg, signal: resolveSignal(when.signal, side), lastMin: when.window },
        right: { kind: 'literal', value: when.value },
      }
    case 'cond':
      return {
        kind: 'compare',
        op: UI_TO_OP[when.op],
        left: { kind: 'signal', signal: resolveSignal(when.signal, side) },
        right: { kind: 'literal', value: when.value },
      }
    case 'time':
      return { kind: 'timeBetween', start: when.between[0], end: when.between[1] }
    case 'change':
      return null
  }
}

function ifToCondition(c: IfSpec, side: BuilderRule['side']): Condition {
  if (c.type === 'time') return { kind: 'timeBetween', start: c.between[0], end: c.between[1] }
  return {
    kind: 'compare',
    op: UI_TO_OP[c.op],
    left: { kind: 'signal', signal: resolveSignal(c.signal, side) },
    right: { kind: 'literal', value: c.value },
  }
}

function thenToAction(t: ThenSpec, side: BuilderRule['side']): Action {
  if (t.action === 'notify') return { kind: 'notify', message: t.message || 'Autopilot notification' }
  if (t.action === 'setPower') return { kind: 'setPower', on: t.on }
  // setTemperature — amount (delta) or expression
  let temp: Expr
  if (t.expr != null) {
    temp = parseExpr(t.expr, side) ?? { kind: 'literal', value: 72 }
  }
  else {
    const delta = t.delta ?? 0
    temp = delta === 0
      ? { kind: 'signal', signal: resolveSignal('{side}.currentTemperature', side) }
      : {
          kind: 'binary',
          op: delta < 0 ? '-' : '+',
          left: { kind: 'signal', signal: resolveSignal('{side}.currentTemperature', side) },
          right: { kind: 'literal', value: Math.abs(delta) },
        }
  }
  const action: Extract<Action, { kind: 'setTemperature' }> = {
    kind: 'setTemperature',
    temp,
    clamp: { min: t.clamp[0], max: t.clamp[1] },
  }
  if (t.expr == null && t.revert) action.durationSec = t.revert * 60
  return action
}

export function toAST(b: BuilderRule): RuleAST {
  const conds: Condition[] = []
  const whenCond = whenToCondition(b.when, b.side)
  if (whenCond) conds.push(whenCond)
  for (const c of b.ifs) conds.push(ifToCondition(c, b.side))
  return {
    name: b.name.trim() || 'Untitled automation',
    enabled: b.enabled,
    side: b.side === 'both' ? null : b.side,
    priority: b.priority,
    dryRun: b.mode === 'dryrun',
    cooldownMin: b.cooldown > 0 ? b.cooldown : null,
    trigger: whenToTrigger(b.when, b.side),
    conditions: { kind: 'and', conditions: conds },
    actions: b.then.map(t => thenToAction(t, b.side)),
  }
}

// ---------------------------------------------------------------------------
// AST → builder
// ---------------------------------------------------------------------------

function astSide(side: Side | null): BuilderRule['side'] {
  return side ?? 'both'
}

/** Compares whose left is a window aggregate or plain signal, with literal right. */
function asThresholdCompare(c: Condition): { signal: string, windowed: boolean, agg?: UiAgg, window?: number, op: UiOp, value: number } | null {
  if (c.kind !== 'compare') return null
  const right = c.right.kind === 'literal' ? c.right.value : null
  if (right == null) return null
  const op = OP_TO_UI[c.op] ?? '>'
  if (c.left.kind === 'window') {
    return { signal: c.left.signal, windowed: true, agg: c.left.fn as UiAgg, window: c.left.lastMin, op, value: right }
  }
  if (c.left.kind === 'signal') {
    return { signal: c.left.signal, windowed: false, op, value: right }
  }
  return null
}

export function fromAST(row: RuleAST & { id?: number }): BuilderRule {
  const side = astSide(row.side)
  const conds = row.conditions.kind === 'and' ? row.conditions.conditions : [row.conditions]

  // Pull out a time-window condition and the first threshold compare.
  const timeIdx = conds.findIndex(c => c.kind === 'timeBetween')
  const time = timeIdx >= 0 ? conds[timeIdx] : null
  const compares = conds.filter((c): c is Extract<Condition, { kind: 'compare' }> => c.kind === 'compare')

  // WHEN
  let when: WhenSpec
  let consumedCompare: Condition | null = null
  if (row.trigger.kind === 'signalChange') {
    when = { type: 'change', signal: templatize(row.trigger.signal, side) }
  }
  else if (compares.length > 0 && asThresholdCompare(compares[0])) {
    const t = asThresholdCompare(compares[0]) as NonNullable<ReturnType<typeof asThresholdCompare>>
    consumedCompare = compares[0]
    when = t.windowed
      ? { type: 'agg', agg: t.agg ?? 'avg', signal: templatize(t.signal, side), window: t.window ?? 10, op: t.op, value: t.value }
      : { type: 'cond', signal: templatize(t.signal, side), op: t.op, value: t.value }
  }
  else if (time && time.kind === 'timeBetween') {
    when = { type: 'time', between: [time.start, time.end] }
  }
  else {
    when = { type: 'cond', signal: templatize('{side}.movement', side), op: '>', value: 200 }
  }

  // IFs: every condition not consumed by WHEN.
  const ifs: IfSpec[] = []
  for (const c of conds) {
    if (c === consumedCompare) continue
    if (c.kind === 'timeBetween') {
      if (when.type === 'time' && c.start === when.between[0] && c.end === when.between[1]) continue
      ifs.push({ type: 'time', between: [c.start, c.end] })
    }
    else if (c.kind === 'compare') {
      const t = asThresholdCompare(c)
      if (t && !t.windowed) ifs.push({ type: 'cond', signal: templatize(t.signal, side), op: t.op, value: t.value })
    }
  }

  // THEN
  const then: ThenSpec[] = row.actions.map((a): ThenSpec => {
    if (a.kind === 'notify') return { action: 'notify', message: a.message }
    if (a.kind === 'setPower') return { action: 'setPower', on: a.on }
    const clamp: [number, number] = a.clamp ? [a.clamp.min, a.clamp.max] : [...DEFAULT_CLAMP]
    // Recognise the "currentTemperature ± n" delta shape; else expose as expression.
    const t = a.temp
    // Zero delta is encoded by toAST as a bare currentTemperature signal.
    if (t.kind === 'signal' && t.signal === resolveSignal('{side}.currentTemperature', side)) {
      return {
        action: 'setTemperature',
        delta: 0,
        revert: a.durationSec ? Math.round(a.durationSec / 60) : undefined,
        clamp,
      }
    }
    if (t.kind === 'binary' && t.left.kind === 'signal'
      && t.left.signal === resolveSignal('{side}.currentTemperature', side)
      && t.right.kind === 'literal' && (t.op === '+' || t.op === '-')) {
      return {
        action: 'setTemperature',
        delta: (t.op === '-' ? -1 : 1) * t.right.value,
        revert: a.durationSec ? Math.round(a.durationSec / 60) : undefined,
        clamp,
      }
    }
    return { action: 'setTemperature', expr: printExpr(t, side), clamp }
  })

  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    mode: row.dryRun ? 'dryrun' : 'active',
    side,
    priority: row.priority,
    when,
    ifs,
    then: then.length ? then : [{ action: 'notify', message: '' }],
    cooldown: row.cooldownMin ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Natural-language sentence
// ---------------------------------------------------------------------------

export interface SentenceChunk { text: string, hot?: boolean, mono?: boolean }

export function sigLabel(id: string): string {
  const base = id.replace('{side}.', '')
  const s = SIGNALS.find(x => x.id === id || x.id === `{side}.${base}`)
  return s ? s.label : base
}
export function sigUnit(id: string): string {
  const s = SIGNALS.find(x => x.id === id)
  return s ? s.unit : ''
}

function opWord(op: UiOp): string {
  return ({ '>': 'rises above', '≥': 'is at least', '<': 'drops below', '≤': 'is at most', '==': 'equals', '≠': 'differs from' } as Record<UiOp, string>)[op]
}

export function fmtClock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const ap = h < 12 ? 'am' : 'pm'
  let hh = h % 12
  if (hh === 0) hh = 12
  return `${hh}${m ? `:${String(m).padStart(2, '0')}` : ''}${ap}`
}

/** Assemble the plain-English "reads as" sentence with highlightable spans. */
export function buildSentence(r: BuilderRule): SentenceChunk[] {
  const out: SentenceChunk[] = []
  const sideShort = r.side === 'both' ? '' : `${r.side}-side `
  out.push({ text: 'When ' })
  const w = r.when
  if (w.type === 'agg') {
    out.push({ text: `${sideShort}${sigLabel(w.signal).toLowerCase()} `, hot: true })
    out.push({ text: `${w.agg === 'avg' ? 'averages' : w.agg} ` })
    out.push({ text: `${opWord(w.op)} ${w.value}`, hot: true })
    out.push({ text: ` over the last ` })
    out.push({ text: `${w.window} min`, hot: true })
  }
  else if (w.type === 'cond') {
    out.push({ text: `${sideShort}${sigLabel(w.signal).toLowerCase()} `, hot: true })
    out.push({ text: `${opWord(w.op)} ${w.value}${sigUnit(w.signal)}`, hot: true })
  }
  else if (w.type === 'change') {
    out.push({ text: `${sideShort}${sigLabel(w.signal).toLowerCase()} `, hot: true })
    out.push({ text: `changes`, hot: true })
  }
  else {
    out.push({ text: `the clock reaches ` })
    out.push({ text: `${fmtClock(w.between[0])}–${fmtClock(w.between[1])}`, hot: true })
  }
  for (const c of r.ifs) {
    out.push({ text: ', and ' })
    if (c.type === 'time') out.push({ text: `it's between ${fmtClock(c.between[0])}–${fmtClock(c.between[1])}`, hot: true })
    else out.push({ text: `${sigLabel(c.signal).toLowerCase()} ${opWord(c.op)} ${c.value}`, hot: true })
  }
  out.push({ text: ', ' })
  r.then.forEach((a, i) => {
    if (i) out.push({ text: ' and ' })
    if (a.action === 'setTemperature') {
      if (a.expr != null) {
        out.push({ text: `set temperature to ` })
        out.push({ text: a.expr, hot: true, mono: true })
        out.push({ text: ` (clamped ${a.clamp[0]}–${a.clamp[1]}°F)` })
      }
      else {
        const delta = a.delta ?? 0
        out.push({ text: `${delta < 0 ? 'lower' : 'raise'} temperature by ` })
        out.push({ text: `${Math.abs(delta)}°F`, hot: true })
        if (a.revert) out.push({ text: ` for ${a.revert} min then revert` })
      }
    }
    else if (a.action === 'notify') {
      out.push({ text: `send a notification` })
    }
    else {
      out.push({ text: `turn power ${a.on ? 'on' : 'off'}`, hot: true })
    }
  })
  if (r.cooldown) {
    out.push({ text: `. Then wait ` })
    out.push({ text: `${r.cooldown} min`, hot: true })
    out.push({ text: ` before firing again` })
  }
  out.push({ text: '.' })
  return out
}

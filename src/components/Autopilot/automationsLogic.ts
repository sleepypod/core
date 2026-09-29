/**
 * View-model for the Automations page — who owns each side now, tonight's
 * timeline lanes, rule row copy and activity-log copy. Pure (times are epoch
 * ms, temperatures °F) so it can be tested without React or tRPC.
 */

import type { CurvePoint } from '@/src/components/TempScreen/timelineLogic'
import type { Condition } from '@/src/automation/types'
import { conditionTimeWindow } from '@/src/automation/activity'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type Owner = 'manual' | 'run-once' | 'autopilot' | 'schedule' | 'off'

export interface ControlLike {
  source: 'manual' | 'run-once' | 'autopilot' | 'schedule' | null
  targetTemperature: number | null
  blocked: 'safety' | 'off' | null
}

export interface SideTonight {
  control: ControlLike | null
  hold: { temperature: number, startedAt: number, expiresAt: number } | null
  runOnceUntil: number | null
  lastAutopilot: { ruleName: string, temp: number, at: number } | null
}

export interface OwnerView {
  owner: Owner
  label: string
  detail: string
}

export const OWNER_LABEL: Record<Owner, string> = {
  'manual': 'Manual hold',
  'run-once': 'Run once',
  'autopilot': 'Autopilot',
  'schedule': 'Schedule',
  'off': 'Off',
}

export const clock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/**
 * The side's owner, by TemperatureController precedence (manual hold →
 * run-once → autopilot → schedule → off), with one sentence explaining it.
 * `fmt` renders a °F setpoint in the user's unit ("81°").
 */
export function ownerView(s: SideTonight | undefined, curve: CurvePoint[], now: number, fmt: (f: number) => string): OwnerView {
  const next = curve.find(p => p.at > now)
  // Without a running controller, infer the owner from what's persisted.
  const inferred = s?.hold && s.hold.expiresAt > now
    ? 'manual'
    : curve.length > 1 && curve[0].at <= now && now < curve[curve.length - 1].at ? 'schedule' : null
  const source = s?.control ? (s.control.blocked ? null : s.control.source) : inferred
  const hold = s?.hold
  if (source === 'manual' && hold) {
    const resumes = curve.some(p => p.at >= hold.expiresAt) ? 'Schedule resumes' : 'Hold ends'
    return {
      owner: 'manual',
      label: OWNER_LABEL.manual,
      detail: `Dial set to ${fmt(hold.temperature)} at ${clock(hold.startedAt)}. ${resumes} at ${clock(hold.expiresAt)}.`,
    }
  }
  if (source === 'run-once') {
    const target = s?.control?.targetTemperature
    return {
      owner: 'run-once',
      label: OWNER_LABEL['run-once'],
      detail: `${target != null ? `${fmt(target)} from a run-once session` : 'Run-once session'}${s?.runOnceUntil ? ` until ${clock(s.runOnceUntil)}` : ''}.`,
    }
  }
  if (source === 'autopilot') {
    const last = s?.lastAutopilot
    return {
      owner: 'autopilot',
      label: OWNER_LABEL.autopilot,
      detail: last ? `${last.ruleName} set ${fmt(last.temp)} at ${clock(last.at)}.` : 'An automation holds this side.',
    }
  }
  if (source === 'schedule') {
    const target = s?.control?.targetTemperature
    const current = target ?? [...curve].reverse().find(p => p.at <= now)?.temperature ?? null
    // Skip steps that read the same ("80° until 10:30 PM, then 80°").
    const change = current == null ? next : curve.find(p => p.at > now && (p === curve[curve.length - 1] || fmt(p.temperature) !== fmt(current)))
    const then = change && change !== curve[curve.length - 1] ? `, then ${fmt(change.temperature)}` : ''
    const until = change ? ` until ${clock(change.at)}` : ''
    return {
      owner: 'schedule',
      label: OWNER_LABEL.schedule,
      detail: current != null ? `${fmt(current)}${until}${then}.` : 'Following the schedule.',
    }
  }
  const start = curve.length > 1 && curve[0].at > now ? curve[0] : null
  return {
    owner: 'off',
    label: OWNER_LABEL.off,
    detail: s?.control?.blocked === 'safety'
      ? 'Paused by pump stall protection.'
      : start ? `Schedule starts at ${clock(start.at)}.` : 'No schedule tonight.',
  }
}

// ── Timeline ────────────────────────────────────────────────────────────────

export interface Block { start: number, end: number, temperature: number }

/**
 * Set points as blocks: each point holds until the next (the last is power
 * off). A curve steps every few minutes, so neighbours that `label` shows the
 * same (79.2 and 79.4 both read "79°") merge into one block.
 */
export function scheduleBlocks(curve: CurvePoint[], from: number, to: number, label: (f: number) => string = String): Block[] {
  const out: Block[] = []
  for (let i = 0; i < curve.length - 1; i++) {
    const start = Math.max(curve[i].at, from)
    const end = Math.min(curve[i + 1].at, to)
    if (end <= start) continue
    const last = out[out.length - 1]
    if (last && last.end === start && label(last.temperature) === label(curve[i].temperature)) last.end = end
    else out.push({ start, end, temperature: curve[i].temperature })
  }
  return out
}

export interface Band<T extends string = string> { start: number, end: number, lo: number, hi: number, tone: T }

/**
 * Touching blocks of one colour as a single band, with the temperature range
 * it spans, so a curve stepping a degree at a time reads as one stretch.
 */
export function scheduleBands<T extends string>(blocks: Block[], tone: (f: number) => T): Array<Band<T>> {
  const out: Array<Band<T>> = []
  for (const b of blocks) {
    const t = tone(b.temperature)
    const last = out[out.length - 1]
    if (last && last.end === b.start && last.tone === t) {
      last.end = b.end
      last.lo = Math.min(last.lo, b.temperature)
      last.hi = Math.max(last.hi, b.temperature)
    }
    else out.push({ start: b.start, end: b.end, lo: b.temperature, hi: b.temperature, tone: t })
  }
  return out
}

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * A rule's active window tonight, from its `timeBetween` condition (a start
 * before noon belongs to the morning after `midnight`), or the whole range
 * when it has none. Clipped to [from, to].
 */
export function ruleWindow(conditions: Condition, midnight: Date, from: number, to: number): { start: number, end: number } | null {
  const w = conditionTimeWindow(conditions)
  if (!w) return { start: from, end: to }
  const s = hhmmToMin(w.start)
  let e = hhmmToMin(w.end)
  const startAt = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), 0, s < 12 * 60 ? s + 24 * 60 : s).getTime()
  if (e <= s) e += 24 * 60
  const endAt = startAt + (e - s) * MINUTE
  const start = Math.max(startAt, from)
  const end = Math.min(endAt, to)
  return end > start ? { start, end } : null
}

// ── Night grouping ─────────────────────────────────────────────────────────

const NIGHT_START_H = 18

/** Start of the 6 PM–6 PM night containing `now`. */
export function currentNightStart(now: number): number {
  const d = new Date(now)
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), NIGHT_START_H).getTime()
  return now >= today ? today : new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, NIGHT_START_H).getTime()
}

/** The last `count` night starts, ascending (oldest first). */
export function nightStarts(now: number, count: number): number[] {
  const tonight = new Date(currentNightStart(now))
  return Array.from({ length: count }, (_, i) =>
    new Date(tonight.getFullYear(), tonight.getMonth(), tonight.getDate() - (count - 1 - i), NIGHT_START_H).getTime())
}

/** `TONIGHT · MON SEP 28`, `LAST NIGHT · SUN SEP 27`, then the date. */
export function nightHeader(start: number, now: number): string {
  const date = new Date(start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '').toUpperCase()
  const tonight = currentNightStart(now)
  if (start === tonight) return `TONIGHT · ${date}`
  if (Math.abs(start - (tonight - DAY)) < 2 * HOUR) return `LAST NIGHT · ${date}`
  return date
}

// ── Rule rows ──────────────────────────────────────────────────────────────

export type RuleMode = 'off' | 'dryrun' | 'active'

export function ruleMode(r: { enabled: boolean, dryRun: boolean }): RuleMode {
  if (!r.enabled) return 'off'
  return r.dryRun ? 'dryrun' : 'active'
}

/** `{n} rules · {active} active · {dry} dry-run`, dropping zero parts. */
export function statusLine(rules: Array<{ enabled: boolean, dryRun: boolean }>): string {
  const active = rules.filter(r => ruleMode(r) === 'active').length
  const dry = rules.filter(r => ruleMode(r) === 'dryrun').length
  const parts = [`${rules.length} rule${rules.length === 1 ? '' : 's'}`]
  if (active) parts.push(`${active} active`)
  if (dry) parts.push(`${dry} dry-run`)
  return rules.length ? parts.join(' · ') : 'no rules'
}

export interface BacktestSummary { nights: number, wouldFire: number, peak: number | null, threshold: number | null }

function fmtNum(v: number): string {
  return Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
}

/** `5-night backtest · 0 would fire · peak 64 of 200`. */
export function backtestLine(s: BacktestSummary | undefined): string {
  if (!s) return 'backtesting…'
  if (s.nights === 0) return 'no recorded nights to backtest'
  const parts = [`${s.nights}-night backtest`, `${s.wouldFire} would fire`]
  if (s.threshold != null && s.peak != null) parts.push(`peak ${fmtNum(s.peak)} of ${fmtNum(s.threshold)}`)
  return parts.join(' · ')
}

// ── Activity ───────────────────────────────────────────────────────────────

export type ActivityFilter = 'all' | 'fired' | 'would' | 'skipped'

export type ActivityTone = 'ok' | 'warn' | 'muted' | 'danger' | 'link'

export const OUTCOME_VIEW: Record<string, { label: string, tone: ActivityTone }> = {
  fired: { label: 'Fired', tone: 'ok' },
  dry_run: { label: 'Would fire', tone: 'warn' },
  skipped: { label: 'Skipped', tone: 'muted' },
  clamped: { label: 'Clamped', tone: 'warn' },
  error: { label: 'Error', tone: 'danger' },
  paused: { label: 'Paused', tone: 'link' },
}

export function matchesFilter(outcome: string, f: ActivityFilter): boolean {
  if (f === 'all') return true
  if (f === 'fired') return outcome === 'fired' || outcome === 'clamped'
  if (f === 'would') return outcome === 'dry_run'
  return outcome === 'skipped'
}

export interface EntryLike {
  code: string
  temp: number | null
  sides: Array<'left' | 'right'>
}

function fmtWindow(w: { start: string, end: string }): string {
  const f = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    const hh = h % 12 === 0 ? 12 : h % 12
    return `${hh}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`
  }
  return `${f(w.start)}–${f(w.end)}`
}

/** The reason column: why the rule did (or didn't) change the bed. */
export function reasonText(e: EntryLike, rule: { conditions: Condition } | undefined, missing: string[], fmt: (f: number) => string): string {
  const w = rule ? conditionTimeWindow(rule.conditions) : null
  switch (e.code) {
    case 'signal-unavailable': return `${missing[0] ?? 'signal'} unavailable`
    case 'outside-window': return w ? `outside ${fmtWindow(w)}` : 'outside its window'
    case 'condition-false': return 'condition not met'
    case 'cooldown': return 'cooling down'
    case 'manual-hold': return 'manual hold'
    case 'anti-thrash': return 'below anti-thrash'
    case 'side-off': return 'side is off'
    case 'superseded': return 'another source owns the side'
    case 'runaway': return 'fired too often · rule disabled'
    case 'eval-error': return 'evaluation failed'
    case 'action-error': return 'command failed'
    case 'set-temperature': return e.temp != null ? `set ${fmt(e.temp)}` : 'set temperature'
    case 'notify': return 'sent a notification'
    case 'power-on': return 'turned power on'
    case 'power-off': return 'turned power off'
    default: return 'no reason recorded'
  }
}

/** `6:31 PM`, or `11:00 PM → 6 AM` for a collapsed range (`→ now` if still running). */
export function entryTime(start: number, end: number, now: number, count: number): string {
  if (count <= 1) return clock(start)
  const endLabel = now - end < 3 * MINUTE ? 'now' : clock(end).replace(':00 ', ' ')
  return `${clock(start)} → ${endLabel}`
}

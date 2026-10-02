import { TEMP_NEUTRAL, TEMP_RANGE } from '@/src/hardware/types'
import { curveToScheduleTemperatures, generateSleepCurve } from '@/src/lib/sleepCurve/generate'
import { DAYS_OF_WEEK, getCurrentDay, hhmmToMinutes, type DayOfWeek } from '@/src/lib/scheduleTime'
import { TEMP } from '@/src/lib/tempColors'
import { setpointFToDisplay, type TempUnit } from '@/src/lib/tempUtils'
import type { TempDisplay } from '@/src/providers/PrefsProvider'
import { stepTargetF } from './tempScreenUtils'

// ── Eight Sleep levels ──────────────────────────────────────────────────────
// The pod's own scale: hardware level −100…100 in tenths, so −10…+10 with
// 0 = 82.5°F and each step 2.75°F. Whole °F set points round-trip exactly
// (max rounding error 0.5°F < half a step).

const LEVEL_STEP_F = TEMP_RANGE / 10

export function levelForF(f: number): number {
  return Math.max(-10, Math.min(10, Math.round((f - TEMP_NEUTRAL) / LEVEL_STEP_F)))
}

export function fForLevel(level: number): number {
  return Math.round(TEMP_NEUTRAL + Math.max(-10, Math.min(10, level)) * LEVEL_STEP_F)
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0'
}

/** "+3" · "−2" · "0" on the Eight Sleep −10…+10 scale. */
export function formatLevel(f: number): string {
  return signed(levelForF(f))
}

/**
 * ± one step in whatever the big number reads in: an Eight Sleep level, or a
 * display degree (°F / °C, which offset mode also counts in). Whole °F out.
 */
export function stepForDisplay(f: number, delta: number, unit: TempUnit, display: TempDisplay): number {
  if (display === 'level') return fForLevel(levelForF(Math.round(f)) + delta)
  return stepTargetF(f, delta, unit)
}

/** Big-number text for a °F set point in the chosen display mode. */
export function formatForDisplay(f: number, unit: TempUnit, display: TempDisplay): string {
  if (display === 'level') return formatLevel(f)
  if (display === 'offset') return signed(Math.round(f) - TEMP.BASE_F)
  return `${Math.round(setpointFToDisplay(f, unit) ?? f)}°${unit}`
}

// ── Night / Dawn ────────────────────────────────────────────────────────────

export type NightPhaseKey = 'night' | 'dawn'

export interface ScheduleTempRow {
  id: number
  dayOfWeek: DayOfWeek
  time: string
  temperature: number
  enabled: boolean
}

export interface NightPhase {
  /** Time-weighted mean of the phase's set points, °F. */
  temperatureF: number
  /** HH:mm the phase starts / ends (end = next phase start, or the final set point). */
  start: string
  end: string
  /** Length in minutes (drives the tab width). */
  minutes: number
  /** Set point times (HH:mm) that belong to this phase. */
  times: string[]
}

export interface NightPhases {
  /** Schedule day that owns tonight (before 4 AM counts as the previous day). */
  day: DayOfWeek
  /** Days whose enabled set points match tonight's exactly — edits apply to all of them. */
  days: DayOfWeek[]
  night: NightPhase
  dawn: NightPhase | null
}

/** Minutes the final set point is assumed to hold when weighting the mean. */
const FINAL_HOLD_MIN = 30
/** Dawn is the last quarter of the span from the first to the last set point. */
const DAWN_FRACTION = 0.25
const HALF_DAY = 12 * 60

function fingerprint(rows: { time: string, temperature: number }[]): string {
  return rows.map(r => `${r.time}@${r.temperature}`).sort().join('|')
}

/** Night order: evening times first, early-morning times after midnight (+24h). */
function nightOrdered(rows: ScheduleTempRow[]): { time: string, temperature: number, m: number }[] {
  const withMin = rows
    .map(r => ({ time: r.time, temperature: r.temperature, m: hhmmToMinutes(r.time) }))
    .filter(r => !Number.isNaN(r.m))
    .sort((a, b) => a.m - b.m)
  let wraps = false
  for (let i = 0; i < withMin.length - 1; i++) {
    if (withMin[i + 1].m - withMin[i].m > HALF_DAY) wraps = true
  }
  const ordered = wraps
    ? withMin.map(r => ({ ...r, m: r.m < HALF_DAY ? r.m + 24 * 60 : r.m }))
    : withMin
  return ordered.sort((a, b) => a.m - b.m)
}

function phaseOf(points: { time: string, temperature: number, m: number }[], endM: number, endTime: string): NightPhase {
  let weighted = 0
  let total = 0
  points.forEach((p, i) => {
    const next = i + 1 < points.length ? points[i + 1].m : endM
    const w = Math.max(next - p.m, 1)
    weighted += p.temperature * w
    total += w
  })
  return {
    temperatureF: weighted / total,
    start: points[0].time,
    end: endTime,
    minutes: Math.max(endM - points[0].m, 1),
    times: points.map(p => p.time),
  }
}

/**
 * Split tonight's enabled set points into Night and Dawn, Eight Sleep style:
 * Dawn is the set points in the last quarter of the night (always including
 * the final one), Night is everything before. One set point → Night only.
 */
export function nightPhases(rows: ScheduleTempRow[], now: Date): NightPhases | null {
  const day = getCurrentDay(now)
  const tonight = rows.filter(r => r.enabled && r.dayOfWeek === day)
  const points = nightOrdered(tonight)
  if (points.length === 0) return null

  const key = fingerprint(tonight)
  const days = DAYS_OF_WEEK.filter(d =>
    d === day || fingerprint(rows.filter(r => r.enabled && r.dayOfWeek === d)) === key,
  )

  const first = points[0].m
  const last = points[points.length - 1].m
  const span = last - first
  const dawnFrom = last - span * DAWN_FRACTION
  const split = points.length >= 2 && span > 0
    ? points.findIndex(p => p.m >= dawnFrom)
    : points.length

  const nightPts = points.slice(0, split)
  const dawnPts = points.slice(split)
  const finalM = last + FINAL_HOLD_MIN
  const finalTime = points[points.length - 1].time

  return {
    day,
    days,
    night: dawnPts.length > 0
      ? phaseOf(nightPts, dawnPts[0].m, dawnPts[0].time)
      : phaseOf(nightPts, finalM, finalTime),
    dawn: dawnPts.length > 0 ? phaseOf(dawnPts, finalM, finalTime) : null,
  }
}

/**
 * Shift every set point of a phase by the same whole-°F delta across all the
 * days that share tonight's curve, so the curve keeps its shape. Returns the
 * batchUpdate temperature updates (unchanged rows omitted).
 */
export function phaseShiftUpdates(
  rows: ScheduleTempRow[],
  phases: NightPhases,
  phase: NightPhaseKey,
  deltaF: number,
): { id: number, temperature: number }[] {
  const target = phases[phase]
  if (!target || deltaF === 0) return []
  const times = new Set(target.times)
  const days = new Set(phases.days)
  const updates: { id: number, temperature: number }[] = []
  for (const r of rows) {
    if (!r.enabled || !days.has(r.dayOfWeek) || !times.has(r.time)) continue
    const next = Math.max(TEMP.MIN_F, Math.min(TEMP.MAX_F, Math.round(r.temperature + deltaF)))
    if (next !== r.temperature) updates.push({ id: r.id, temperature: next })
  }
  return updates
}

// ── Template ────────────────────────────────────────────────────────────────
// A side with no schedule tonight gets Night / Dawn from the balanced sleep
// curve (the Schedule page's default preset). Nothing is written until the
// first − / +; then the whole curve lands on every night without a schedule.

export const TEMPLATE_BEDTIME = '22:00'
export const TEMPLATE_WAKE = '07:00'

/** Template set points (negative ids) for each day with no enabled set points. */
export function templateRows(rows: ScheduleTempRow[]): ScheduleTempRow[] {
  const bedtimeMinutes = hhmmToMinutes(TEMPLATE_BEDTIME)
  const curve = curveToScheduleTemperatures(
    generateSleepCurve({ bedtimeMinutes, wakeMinutes: hhmmToMinutes(TEMPLATE_WAKE) }),
    bedtimeMinutes,
  )
  const open = DAYS_OF_WEEK.filter(d => !rows.some(r => r.enabled && r.dayOfWeek === d))
  let id = 0
  return open.flatMap(dayOfWeek => Object.entries(curve).map(([time, temperature]) => ({
    id: --id,
    dayOfWeek,
    time,
    temperature: Math.max(TEMP.MIN_F, Math.min(TEMP.MAX_F, Math.round(temperature))),
    enabled: true,
  })))
}

interface PowerRowRef {
  id: number
  dayOfWeek: DayOfWeek
}

/**
 * batchUpdate input that creates the template on its days with Night / Dawn
 * shifted to the chosen values, plus a power window from the first to the
 * last set point (as the Schedule page's curve save does). Leftover disabled
 * set points and power rows on those days are replaced.
 */
export function templateBatch(
  side: 'left' | 'right',
  existing: { temperature: ScheduleTempRow[], power: PowerRowRef[] },
  template: ScheduleTempRow[],
  phases: NightPhases,
  targets: Partial<Record<NightPhaseKey, number>>,
) {
  const temps = new Map(template.map(r => [r.id, r.temperature]))
  for (const phase of ['night', 'dawn'] as const) {
    const want = targets[phase]
    const p = phases[phase]
    if (want == null || !p) continue
    for (const u of phaseShiftUpdates(template, phases, phase, want - Math.round(p.temperatureF))) temps.set(u.id, u.temperature)
  }
  const days = new Set(template.map(r => r.dayOfWeek))
  const byDay = new Map<DayOfWeek, ScheduleTempRow[]>()
  for (const r of template) byDay.set(r.dayOfWeek, [...(byDay.get(r.dayOfWeek) ?? []), r])

  const power = [...byDay.entries()].flatMap(([dayOfWeek, dayRows]) => {
    const ordered = nightOrdered(dayRows)
    const first = ordered[0]
    const last = ordered[ordered.length - 1]
    if (!first || first.time === last.time) return []
    const onTemperature = temps.get(dayRows.find(r => r.time === first.time)?.id ?? 0) ?? first.temperature
    return [{ side, dayOfWeek, onTime: first.time, offTime: last.time, onTemperature, enabled: true }]
  })

  return {
    deletes: {
      temperature: existing.temperature.filter(r => days.has(r.dayOfWeek)).map(r => r.id),
      power: existing.power.filter(r => days.has(r.dayOfWeek)).map(r => r.id),
      alarm: [],
    },
    creates: {
      temperature: template.map(r => ({ side, dayOfWeek: r.dayOfWeek, time: r.time, temperature: temps.get(r.id) ?? r.temperature, enabled: true })),
      power,
      alarm: [],
    },
  }
}

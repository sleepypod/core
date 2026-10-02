import { calculateDistribution, calculateQualityScore, mergeIntoBlocks, type SleepEpoch, type SleepStage } from '@/src/lib/sleep-stages'
import { DAY, HOUR, MINUTE, hashSeed, randomBetween, seededRandom, startOfDay } from './util'

/**
 * Synthetic sleep history for the demo: ~45 nights per side, deterministic per
 * (side, night) and anchored to the viewer's clock so last night always exists
 * and a session in progress grows in real time.
 */

export type Side = 'left' | 'right'

export interface StageSegment { start: number, end: number, stage: SleepStage }
export interface DemoVital { t: number, heartRate: number, hrv: number, breathingRate: number }
export interface DemoMovement { t: number, score: number }

export interface DemoNight {
  /** Stable sleep-record id (same night + side → same id across reloads). */
  id: number
  side: Side
  enteredBedAt: Date
  /** null while the session is still in progress. */
  leftBedAt: Date | null
  sleepDurationSeconds: number
  timesExitedBed: number
  /** Epoch-second [start, end] pairs; end is null for an open interval. */
  presentIntervals: Array<[number, number | null]>
  notPresentIntervals: Array<[number, number]>
  /** Ascending, ms timestamps; clipped to "now". */
  stages: StageSegment[]
  vitals: DemoVital[]
  movement: DemoMovement[]
}

const HISTORY_NIGHTS = 45
const VITALS_STEP = 2 * MINUTE
const MOVEMENT_STEP = MINUTE
const EPOCH_MS = 5 * MINUTE

const PROFILE: Record<Side, { hr: number, hrv: number, br: number, bedShiftMin: number, seed: number }> = {
  left: { hr: 57, hrv: 58, br: 14, bedShiftMin: 0, seed: 11 },
  right: { hr: 62, hrv: 44, br: 15.5, bedShiftMin: 20, seed: 29 },
}

interface FullNight extends Omit<DemoNight, 'leftBedAt' | 'sleepDurationSeconds' | 'presentIntervals' | 'notPresentIntervals' | 'timesExitedBed'> {
  leftBedAt: Date
  exits: Array<{ start: number, end: number }>
}

const cache = new Map<string, FullNight | null>()

function generateNight(side: Side, evening: Date): FullNight | null {
  const key = `${side}:${evening.getTime()}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const p = PROFILE[side]
  const rand = seededRandom(hashSeed(key) ^ p.seed)

  // Occasional night away (never the most recent two).
  const daysAgo = Math.round((startOfDay(0).getTime() - evening.getTime()) / DAY)
  if (daysAgo > 2 && rand() < 0.05) {
    cache.set(key, null)
    return null
  }

  const weekend = evening.getDay() === 5 || evening.getDay() === 6
  const bed = evening.getTime() + 22.5 * HOUR + (p.bedShiftMin + randomBetween(rand, 0, 60) + (weekend ? 40 : 0)) * MINUTE
  const wake = bed + randomBetween(rand, 6.8, 8.4) * HOUR + (weekend ? 45 * MINUTE : 0)

  const stages: StageSegment[] = []
  const push = (stage: SleepStage, minutes: number, t: number) => {
    const end = Math.min(t + minutes * MINUTE, wake)
    if (end > t) stages.push({ start: t, end, stage })
    return end
  }

  let t = push('wake', randomBetween(rand, 8, 22), bed)
  for (let cycle = 0; t < wake - 15 * MINUTE; cycle++) {
    const deep = Math.max(0, [42, 30, 16, 6, 0, 0][Math.min(cycle, 5)] + randomBetween(rand, -6, 6))
    const rem = [8, 14, 19, 23, 26, 28][Math.min(cycle, 5)] + randomBetween(rand, -4, 4)
    t = push('light', randomBetween(rand, 16, 30), t)
    if (deep > 2) t = push('deep', deep, t)
    t = push('light', randomBetween(rand, 12, 24), t)
    t = push('rem', rem, t)
    if (rand() < 0.3) t = push('wake', randomBetween(rand, 2, 6), t)
  }
  push('wake', (wake - t) / MINUTE, t)

  // Some nights include one trip out of bed mid-sleep.
  const exits: FullNight['exits'] = []
  if (rand() < 0.4) {
    const at = bed + (wake - bed) * randomBetween(rand, 0.4, 0.7)
    const exit = { start: at + 2 * MINUTE, end: at + 2 * MINUTE + randomBetween(rand, 3, 8) * MINUTE }
    exits.push(exit)
    overwriteStage(stages, at, exit.end + 2 * MINUTE, 'wake')
  }

  const inBed = (ts: number) => !exits.some(e => ts >= e.start && ts < e.end)
  const nightLen = wake - bed

  const vitals: DemoVital[] = []
  for (let ts = bed + VITALS_STEP; ts < wake; ts += VITALS_STEP) {
    if (!inBed(ts)) continue
    const stage = stageAt(stages, ts)
    const drift = -4 * ((ts - bed) / nightLen)
    const hrOffset = { deep: -6, light: 0, rem: 4, wake: 8 }[stage]
    const hrvOffset = { deep: 16, light: 2, rem: -12, wake: -16 }[stage]
    const brOffset = { deep: -1.2, light: 0, rem: 1.4, wake: 1.8 }[stage]
    vitals.push({
      t: ts,
      heartRate: Math.round(p.hr + drift + hrOffset + randomBetween(rand, -1.8, 1.8)),
      hrv: Math.round(p.hrv + hrvOffset + randomBetween(rand, -6, 6)),
      breathingRate: Math.round((p.br + brOffset + randomBetween(rand, -0.6, 0.6)) * 10) / 10,
    })
  }

  const transitions = new Set(stages.slice(1).map(s => Math.floor(s.start / MOVEMENT_STEP)))
  const movement: DemoMovement[] = []
  for (let ts = bed; ts < wake; ts += MOVEMENT_STEP) {
    if (!inBed(ts)) continue
    const stage = stageAt(stages, ts)
    let score = { deep: randomBetween(rand, 0, 12), light: randomBetween(rand, 4, 45), rem: randomBetween(rand, 0, 20), wake: randomBetween(rand, 60, 260) }[stage]
    if (transitions.has(Math.floor(ts / MOVEMENT_STEP)) && rand() < 0.3) score = randomBetween(rand, 200, 560)
    else if (stage === 'light' && rand() < 0.04) score = randomBetween(rand, 60, 180)
    movement.push({ t: ts, score: Math.round(score) })
  }

  const night: FullNight = {
    id: Math.round(evening.getTime() / DAY) * 2 + (side === 'right' ? 1 : 0),
    side,
    enteredBedAt: new Date(bed),
    leftBedAt: new Date(wake),
    exits,
    stages,
    vitals,
    movement,
  }
  cache.set(key, night)
  return night
}

function overwriteStage(stages: StageSegment[], from: number, to: number, stage: SleepStage) {
  const out: StageSegment[] = []
  for (const s of stages) {
    if (s.end <= from || s.start >= to) {
      out.push(s)
      continue
    }
    if (s.start < from) out.push({ ...s, end: from })
    if (s.end > to) out.push({ ...s, start: to })
  }
  out.push({ start: from, end: to, stage })
  out.sort((a, b) => a.start - b.start)
  stages.splice(0, stages.length, ...out)
}

export function stageAt(stages: StageSegment[], t: number): SleepStage {
  for (const s of stages) if (t >= s.start && t < s.end) return s.stage
  return 'wake'
}

const toSec = (ms: number) => Math.floor(ms / 1000)

/** Clip a generated night to `now` and shape it like a sleep_records row. */
function view(full: FullNight, now: number): DemoNight {
  const active = full.leftBedAt.getTime() > now
  const end = active ? now : full.leftBedAt.getTime()
  const exits = full.exits.filter(e => e.start < end)

  const present: DemoNight['presentIntervals'] = []
  let cursor = full.enteredBedAt.getTime()
  for (const e of exits) {
    present.push([toSec(cursor), toSec(e.start)])
    cursor = Math.min(e.end, end)
  }
  present.push([toSec(cursor), active ? null : toSec(end)])

  return {
    id: full.id,
    side: full.side,
    enteredBedAt: full.enteredBedAt,
    leftBedAt: active ? null : full.leftBedAt,
    sleepDurationSeconds: toSec(end - full.enteredBedAt.getTime()),
    timesExitedBed: exits.length,
    presentIntervals: present,
    notPresentIntervals: exits.map(e => [toSec(e.start), toSec(Math.min(e.end, end))] as [number, number]),
    stages: active
      ? full.stages.filter(s => s.start < now).map(s => (s.end > now ? { ...s, end: now } : s))
      : full.stages,
    vitals: active ? full.vitals.filter(v => v.t <= now) : full.vitals,
    movement: active ? full.movement.filter(m => m.t <= now) : full.movement,
  }
}

// ---------------------------------------------------------------------------
// In-memory edits (updateSleepRecord / deleteSleepRecord)
// ---------------------------------------------------------------------------

interface RecordEdit { enteredBedAt?: Date, leftBedAt?: Date, timesExitedBed?: number }
const edits = new Map<number, RecordEdit>()
const deleted = new Set<number>()

export function editDemoNight(id: number, edit: RecordEdit): DemoNight | null {
  const night = findDemoNight(id)
  if (!night) return null
  edits.set(id, { ...edits.get(id), ...edit })
  return findDemoNight(id)
}

export function deleteDemoNight(id: number): boolean {
  if (!findDemoNight(id)) return false
  deleted.add(id)
  return true
}

function applyEdit(n: DemoNight): DemoNight {
  const e = edits.get(n.id)
  if (!e) return n
  const enteredBedAt = e.enteredBedAt ?? n.enteredBedAt
  const leftBedAt = e.leftBedAt ?? n.leftBedAt
  const end = leftBedAt?.getTime() ?? Date.now()
  return {
    ...n,
    enteredBedAt,
    leftBedAt,
    timesExitedBed: e.timesExitedBed ?? n.timesExitedBed,
    sleepDurationSeconds: toSec(end - enteredBedAt.getTime()),
  }
}

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

/** All demo nights for a side, newest first, including any session in progress. */
export function demoNights(side: Side, now = Date.now()): DemoNight[] {
  const out: DemoNight[] = []
  for (let daysAgo = 0; daysAgo <= HISTORY_NIGHTS; daysAgo++) {
    const full = generateNight(side, startOfDay(daysAgo, now))
    if (!full || full.enteredBedAt.getTime() > now || deleted.has(full.id)) continue
    out.push(applyEdit(view(full, now)))
  }
  return out
}

export function findDemoNight(id: number, now = Date.now()): DemoNight | null {
  const side: Side = id % 2 === 1 ? 'right' : 'left'
  return demoNights(side, now).find(n => n.id === id) ?? null
}

/** Nights overlapping [start, end] (ms), newest first. */
export function demoNightsOverlapping(side: Side, start: number, end: number, now = Date.now()): DemoNight[] {
  return demoNights(side, now).filter(n => n.enteredBedAt.getTime() <= end && (n.leftBedAt?.getTime() ?? now) >= start)
}

/** Vitals for a side within [start, end] (ms), ascending. */
export function demoVitals(side: Side, start: number, end: number, now = Date.now()): DemoVital[] {
  return demoNightsOverlapping(side, start, end, now)
    .reverse()
    .flatMap(n => n.vitals.filter(v => v.t >= start && v.t <= end))
}

/** Movement epochs for a side within [start, end] (ms), ascending. */
export function demoMovement(side: Side, start: number, end: number, now = Date.now()): DemoMovement[] {
  return demoNightsOverlapping(side, start, end, now)
    .reverse()
    .flatMap(n => n.movement.filter(m => m.t >= start && m.t <= end))
}

/** The night in progress (occupant in bed right now), if any. */
export function activeDemoNight(side: Side, now = Date.now()): DemoNight | null {
  const latest = demoNights(side, now)[0]
  if (!latest || latest.leftBedAt !== null) return null
  const outNow = latest.notPresentIntervals.some(([s, e]) => now >= s * 1000 && now < e * 1000)
  return outNow ? null : latest
}

/** 5-minute stage epochs for a window, shaped like the server's getSleepStages. */
export function demoStageEpochs(night: DemoNight, start: number, end: number): SleepEpoch[] {
  const epochs: SleepEpoch[] = []
  let vi = 0
  let mi = 0
  for (let ts = Math.max(start, night.enteredBedAt.getTime()); ts < end; ts += EPOCH_MS) {
    const duration = Math.min(EPOCH_MS, end - ts)
    while (vi < night.vitals.length - 1 && night.vitals[vi + 1].t <= ts) vi++
    while (mi < night.movement.length - 1 && night.movement[mi + 1].t <= ts) mi++
    const v = night.vitals[vi]
    const m = night.movement[mi]
    const near = (x: { t: number } | undefined) => x !== undefined && Math.abs(x.t - ts) <= EPOCH_MS
    epochs.push({
      start: ts,
      duration,
      stage: stageAt(night.stages, ts + duration / 2),
      heartRate: near(v) ? v.heartRate : null,
      hrv: near(v) ? v.hrv : null,
      breathingRate: near(v) ? v.breathingRate : null,
      movement: near(m) ? m.score : null,
    })
  }
  return epochs
}

export function summarizeEpochs(epochs: SleepEpoch[]) {
  const distribution = calculateDistribution(epochs)
  return {
    blocks: mergeIntoBlocks(epochs),
    distribution,
    qualityScore: calculateQualityScore(distribution),
    totalSleepMs: epochs.reduce((sum, e) => sum + e.duration, 0),
  }
}

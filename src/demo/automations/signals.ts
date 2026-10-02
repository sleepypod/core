/**
 * Synthetic signal history for the demo Autopilot. Every signal the engine can
 * read is a pure, deterministic function of (key, time), so the run log, the
 * backtests and the live "observed" values all agree without storing anything.
 * Values are in engine units: °F, bpm, ms, brpm, lux, unitless cap load.
 */

import type { DayOfWeek } from '@/src/automation/types'
import { DAY, HOUR, MINUTE, hashSeed, seededRandom } from '../util'

type Side = 'left' | 'right'

const DAYS: DayOfWeek[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export function localClock(ms: number): { nowMinutes: number, dayOfWeek: DayOfWeek, dateKey: string } {
  const d = new Date(ms)
  return {
    nowMinutes: d.getHours() * 60 + d.getMinutes(),
    dayOfWeek: DAYS[d.getDay()],
    dateKey: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  }
}

/** Uniform [0, 1) keyed by string — stable "random" decisions. */
function chance(key: string): number {
  return seededRandom(hashSeed(key))()
}

/** Smooth value noise in [-1, 1] with features roughly `periodMs` wide. */
function noise(key: string, t: number, periodMs: number): number {
  const x = t / periodMs
  const i = Math.floor(x)
  const f = x - i
  const a = chance(`${key}:${i}`) * 2 - 1
  const b = chance(`${key}:${i + 1}`) * 2 - 1
  const s = f * f * (3 - 2 * f)
  return a + (b - a) * s
}

// ---------------------------------------------------------------------------
// Sleep sessions
// ---------------------------------------------------------------------------

export interface Session {
  side: Side
  /** Local midnight of the evening the night started on. */
  evening: number
  enteredMs: number
  leftMs: number
  /** Out-of-bed gap (bathroom trip), if any. */
  breakStart: number | null
  breakEnd: number | null
}

const BED: Record<Side, { enter: number, leave: number }> = {
  left: { enter: 22 * 60 + 40, leave: 6 * 60 + 45 },
  right: { enter: 23 * 60 + 10, leave: 7 * 60 + 15 },
}

const sessionCache = new Map<string, Session>()

/** The (deterministic) session for the night starting on local date `evening`. */
export function sessionFor(side: Side, evening: number): Session {
  const key = `${side}:${evening}`
  const hit = sessionCache.get(key)
  if (hit) return hit
  const rand = seededRandom(hashSeed(`session:${key}`))
  const dow = new Date(evening).getDay()
  const weekend = dow === 5 || dow === 6
  const enterMin = BED[side].enter + (weekend ? 40 : 0) + Math.round(-25 + rand() * 60)
  const leaveMin = BED[side].leave + (weekend ? 50 : 0) + Math.round(-20 + rand() * 60)
  const enteredMs = evening + enterMin * MINUTE
  const nextMorning = new Date(evening)
  nextMorning.setDate(nextMorning.getDate() + 1)
  const leftMs = nextMorning.getTime() + leaveMin * MINUTE
  let breakStart: number | null = null
  let breakEnd: number | null = null
  if (rand() < 0.4) {
    breakStart = nextMorning.getTime() + Math.round((120 + rand() * 150)) * MINUTE
    breakEnd = breakStart + Math.round(6 + rand() * 7) * MINUTE
  }
  const session = { side, evening, enteredMs, leftMs, breakStart, breakEnd }
  sessionCache.set(key, session)
  return session
}

/** Local midnight of the evening a timestamp's night belongs to (nights run noon→noon). */
export function eveningOf(ms: number): number {
  const d = new Date(ms - 12 * HOUR)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function inBed(side: Side, t: number): boolean {
  const s = sessionFor(side, eveningOf(t))
  if (t < s.enteredMs || t >= s.leftMs) return false
  return !(s.breakStart !== null && s.breakEnd !== null && t >= s.breakStart && t < s.breakEnd)
}

/** Completed sessions for a side, newest first. */
export function recentSessions(side: Side, limit: number, now = Date.now()): Session[] {
  const out: Session[] = []
  let evening = eveningOf(now)
  for (let i = 0; i < limit + 2 && out.length < limit; i++) {
    const s = sessionFor(side, evening)
    if (s.leftMs <= now) out.push(s)
    const d = new Date(evening)
    d.setDate(d.getDate() - 1)
    evening = d.getTime()
  }
  return out
}

/** Stable id for a session: epoch-day of its evening, side in the low bit. */
export function sessionId(s: Session): number {
  return Math.round(s.evening / DAY) * 2 + (s.side === 'right' ? 1 : 0)
}

export function sessionById(side: Side, id: number): Session | null {
  if ((id & 1) !== (side === 'right' ? 1 : 0)) return null
  const approx = new Date(Math.floor(id / 2) * DAY + 12 * HOUR)
  approx.setHours(0, 0, 0, 0)
  return sessionFor(side, approx.getTime())
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Restless episodes: a few 6–14 minute bursts per night, keyed per 15-min block. */
function restless(side: Side, t: number): boolean {
  const block = Math.floor(t / (15 * MINUTE))
  const r = chance(`restless:${side}:${block}`)
  if (r > 0.13) return false
  const startOff = Math.floor(chance(`restless-start:${side}:${block}`) * 6) * MINUTE
  const len = (6 + Math.floor(chance(`restless-len:${side}:${block}`) * 9)) * MINUTE
  const start = block * 15 * MINUTE + startOff
  return t >= start && t < start + len
}

function movement(side: Side, t: number): number | undefined {
  if (!inBed(side, t)) return undefined
  const s = sessionFor(side, eveningOf(t))
  let v = 45 + 25 * noise(`mv:${side}`, t, 7 * MINUTE)
  if (t - s.enteredMs < 20 * MINUTE || s.leftMs - t < 15 * MINUTE) v += 160 + 60 * noise(`mvs:${side}`, t, 3 * MINUTE)
  if (restless(side, t)) v += 320 + 120 * noise(`mvr:${side}`, t, 2 * MINUTE)
  return Math.max(0, Math.round(v))
}

/** Scheduled water target (°F): cool overnight, neutral-warm by day. */
function targetTemp(side: Side, t: number): number {
  const m = localClock(t).nowMinutes
  const night = m >= 22 * 60 || m < 7 * 60
  if (side === 'left') return night ? 68 : 80
  return night ? 78 : 82
}

function ambient(t: number): number {
  const local = new Date(t).getHours() + new Date(t).getMinutes() / 60
  return 69.3 + 1.6 * Math.cos((2 * Math.PI * (local - 17)) / 24) + 0.4 * noise('amb', t, 40 * MINUTE)
}

const CAP_BASE: Record<Side, [number, number, number]> = {
  left: [17.13, 17.2, 21.6],
  right: [16.05, 15.93, 22.46],
}

/** Three paired head/torso/legs zone loads (the cap_sense_frames shape). */
export function capZones(side: Side, t: number): [number, number, number] {
  const base = CAP_BASE[side]
  const n = (k: string) => 0.15 * noise(`cap:${side}:${k}`, t, 5 * MINUTE)
  if (!inBed(side, t)) return [base[0] + n('a'), base[1] + n('b'), base[2] + n('c')]
  const shift = restless(side, t) ? 1.5 * noise(`capr:${side}`, t, MINUTE) : 0
  return [
    base[0] + 3.4 + shift + n('a') * 3,
    base[1] + 10 - shift + n('b') * 3,
    base[2] + 1.5 + n('c') * 3,
  ]
}

function capStats(side: Side, t: number): { max: number, mean: number, spread: number } {
  const z = capZones(side, t)
  // Six channels are pairs of the three zones, ±0.03 apart.
  const ch = z.flatMap(v => [v - 0.03, v + 0.03])
  const max = Math.max(...ch)
  const min = Math.min(...ch)
  return { max, mean: ch.reduce((a, b) => a + b, 0) / ch.length, spread: max - min }
}

const r1 = (v: number) => Math.round(v * 10) / 10

const memo = new Map<string, number | undefined>()

/** Value of an engine signal key at `t`, or undefined when unavailable. */
export function signalAt(key: string, t: number): number | undefined {
  const k = `${key}@${t}`
  if (memo.has(k)) return memo.get(k)
  if (memo.size > 250_000) memo.clear()
  const v = computeSignal(key, t)
  memo.set(k, v)
  return v
}

function computeSignal(key: string, t: number): number | undefined {
  if (key === 'ambient.temperature') return r1(ambient(t))
  if (key === 'ambient.humidity') return r1(45 + 3 * noise('hum', t, 90 * MINUTE))
  if (key === 'ambient.light') {
    const h = new Date(t).getHours()
    if (h >= 7 && h < 19) return Math.round(260 + 80 * noise('lux', t, 30 * MINUTE))
    if (h >= 19 && h < 23) return Math.round(110 + 20 * noise('lux', t, 30 * MINUTE))
    return 0.4
  }
  if (key === 'water.low') return 0

  const dot = key.indexOf('.')
  const side = key.slice(0, dot)
  if (side !== 'left' && side !== 'right') return undefined
  const sig = key.slice(dot + 1)
  const occupied = inBed(side, t)
  const hrBase = side === 'left' ? 56 : 61

  switch (sig) {
    case 'movement':
      return movement(side, t)
    case 'heartRate':
      if (!occupied) return undefined
      return Math.round(hrBase + 3 * noise(`hr:${side}`, t, 25 * MINUTE) + (restless(side, t) ? 9 : 0))
    case 'hrv':
      if (!occupied) return undefined
      return Math.round((side === 'left' ? 54 : 45) + 10 * noise(`hrv:${side}`, t, 30 * MINUTE))
    case 'breathingRate':
      if (!occupied) return undefined
      return r1((side === 'left' ? 14.4 : 15.8) + 0.9 * noise(`br:${side}`, t, 20 * MINUTE))
    case 'targetTemperature':
      return targetTemp(side, t)
    case 'currentTemperature':
    case 'waterTemp':
      return r1(targetTemp(side, t) + 0.6 * noise(`water:${side}`, t, 15 * MINUTE))
    case 'surfaceTemp':
      return r1(occupied ? 86.2 + 0.8 * noise(`surf:${side}`, t, 20 * MINUTE) : ambient(t) + 3)
    case 'surfaceTemp.spread':
      return r1(occupied ? 1.8 + 0.6 * noise(`spr:${side}`, t, 20 * MINUTE) : 0.6)
    case 'surfaceTemp.gradient':
      return r1(occupied ? 0.9 + 0.4 * noise(`grad:${side}`, t, 20 * MINUTE) : 0.1)
    case 'cap.max':
      return Math.round(capStats(side, t).max * 100) / 100
    case 'cap.mean':
      return Math.round(capStats(side, t).mean * 100) / 100
    case 'cap.spread':
      return Math.round(capStats(side, t).spread * 100) / 100
    default:
      return undefined
  }
}

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { centiDegreesToF } from '@/src/lib/tempUtils'

/**
 * Downsampled thermal history for System → Thermal: stored bed_temp,
 * freezer_temp, flow_readings and thermal_state rows averaged into at most
 * MAX_BUCKETS time buckets, all in SQL so a 7-day window stays cheap on the
 * pod. Nothing is interpolated or invented — a bucket with no rows is absent.
 */

export const THERMAL_RANGES = { '1h': 3_600, '12h': 43_200, '24h': 86_400, '48h': 172_800, '7d': 604_800 } as const
export type ThermalRange = keyof typeof THERMAL_RANGES

const MAX_BUCKETS = 360
/** Rows land about once a minute; finer buckets would just be empty. */
const MIN_BUCKET_SEC = 60

type Side = 'left' | 'right'

export interface ThermalHistoryPoint {
  /** Bucket midpoint, epoch ms. */
  t: number
  leftBed: number | null
  rightBed: number | null
  leftTarget: number | null
  rightTarget: number | null
  leftWater: number | null
  rightWater: number | null
  leftSurface: number | null
  rightSurface: number | null
  leftRpm: number | null
  rightRpm: number | null
  heatsink: number | null
  ambient: number | null
}

export type ThermalSeriesKey = 'bedTarget' | 'water' | 'surface' | 'pump' | 'hub'

export interface ThermalHistory {
  range: ThermalRange
  from: number
  to: number
  bucketSec: number
  points: ThermalHistoryPoint[]
  powerOn: Array<{ side: Side, at: number }>
  /** Per panel: whether any stored row falls inside the window. */
  available: Record<ThermalSeriesKey, boolean>
  /** First thermal_state row ever (epoch ms) — bed/target history starts here. */
  bedTargetSince: number | null
}

type Db = BetterSQLite3Database<Record<string, unknown>>

const EMPTY_POINT: Omit<ThermalHistoryPoint, 't'> = {
  leftBed: null, rightBed: null, leftTarget: null, rightTarget: null,
  leftWater: null, rightWater: null, leftSurface: null, rightSurface: null,
  leftRpm: null, rightRpm: null, heatsink: null, ambient: null,
}

const cdToF = (v: number | null) => (v == null ? null : Math.round(centiDegreesToF(v) * 10) / 10)
const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10)

export function bucketSecondsFor(range: ThermalRange): number {
  return Math.max(MIN_BUCKET_SEC, Math.ceil(THERMAL_RANGES[range] / MAX_BUCKETS))
}

export function getThermalHistory(db: Db, range: ThermalRange, nowMs = Date.now(), currentPoweredOnAt: Partial<Record<Side, number | null>> = {}): ThermalHistory {
  const bucketSec = bucketSecondsFor(range)
  const to = Math.floor(nowMs / 1000)
  const from = to - THERMAL_RANGES[range]
  const bucket = sql`CAST((timestamp - ${from}) / ${bucketSec} AS INTEGER)`
  const inRange = sql`timestamp >= ${from} AND timestamp <= ${to}`

  const byBucket = new Map<number, ThermalHistoryPoint>()
  const at = (b: number) => {
    let p = byBucket.get(b)
    if (!p) {
      p = { t: (from + (b + 0.5) * bucketSec) * 1000, ...EMPTY_POINT }
      byBucket.set(b, p)
    }
    return p
  }

  const surface = db.all<{ b: number, l: number | null, r: number | null }>(sql`
    SELECT ${bucket} AS b, AVG(left_center_temp) AS l, AVG(right_center_temp) AS r
    FROM bed_temp WHERE ${inRange} GROUP BY b`)
  for (const row of surface) Object.assign(at(row.b), { leftSurface: cdToF(row.l), rightSurface: cdToF(row.r) })

  const freezer = db.all<{ b: number, l: number | null, r: number | null, h: number | null, a: number | null }>(sql`
    SELECT ${bucket} AS b, AVG(left_water_temp) AS l, AVG(right_water_temp) AS r,
           AVG(heatsink_temp) AS h, AVG(ambient_temp) AS a
    FROM freezer_temp WHERE ${inRange} GROUP BY b`)
  for (const row of freezer) {
    Object.assign(at(row.b), { leftWater: cdToF(row.l), rightWater: cdToF(row.r), heatsink: cdToF(row.h), ambient: cdToF(row.a) })
  }

  const flow = db.all<{ b: number, l: number | null, r: number | null }>(sql`
    SELECT ${bucket} AS b, AVG(left_pump_rpm) AS l, AVG(right_pump_rpm) AS r
    FROM flow_readings WHERE ${inRange} GROUP BY b`)
  for (const row of flow) {
    Object.assign(at(row.b), { leftRpm: row.l == null ? null : Math.round(row.l), rightRpm: row.r == null ? null : Math.round(row.r) })
  }

  const state = db.all<{ b: number, side: Side, bed: number | null, target: number | null }>(sql`
    SELECT ${bucket} AS b, side, AVG(current_temp_f) AS bed, AVG(target_temp_f) AS target
    FROM thermal_state WHERE ${inRange} AND is_powered = 1 GROUP BY b, side`)
  for (const row of state) {
    const p = at(row.b)
    if (row.side === 'left') Object.assign(p, { leftBed: round1(row.bed), leftTarget: round1(row.target) })
    else Object.assign(p, { rightBed: round1(row.bed), rightTarget: round1(row.target) })
  }

  // Off→on transitions inside the window. The row just before the window
  // decides whether the first in-window "on" row is a transition.
  const transitions = db.all<{ side: Side, ts: number }>(sql`
    SELECT side, ts FROM (
      SELECT side, timestamp AS ts, is_powered,
             LAG(is_powered) OVER (PARTITION BY side ORDER BY timestamp, id) AS prev
      FROM thermal_state
      WHERE timestamp <= ${to}
        AND timestamp >= COALESCE((SELECT MAX(timestamp) FROM thermal_state WHERE timestamp < ${from}), ${from})
    )
    WHERE is_powered = 1 AND (prev IS NULL OR prev = 0) AND ts >= ${from}
    ORDER BY ts`)
  const powerOn = transitions.map(r => ({ side: r.side, at: r.ts * 1000 }))
  // device_state knows the current session's start even if it predates recording.
  for (const side of ['left', 'right'] as const) {
    const on = currentPoweredOnAt[side]
    if (on != null && on >= from * 1000 && on <= nowMs && !powerOn.some(p => p.side === side && Math.abs(p.at - on) < 120_000)) {
      powerOn.push({ side, at: on })
    }
  }
  powerOn.sort((a, b) => a.at - b.at)

  const points = [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p)
  const has = (keys: Array<keyof ThermalHistoryPoint>) => points.some(p => keys.some(k => p[k] != null))
  const [first] = db.all<{ ts: number | null }>(sql`SELECT MIN(timestamp) AS ts FROM thermal_state`)

  return {
    range,
    from: from * 1000,
    to: nowMs,
    bucketSec,
    points,
    powerOn,
    available: {
      bedTarget: has(['leftBed', 'rightBed', 'leftTarget', 'rightTarget']),
      water: has(['leftWater', 'rightWater']),
      surface: has(['leftSurface', 'rightSurface']),
      pump: has(['leftRpm', 'rightRpm']),
      hub: has(['heatsink', 'ambient']),
    },
    bedTargetSince: first?.ts != null ? first.ts * 1000 : null,
  }
}

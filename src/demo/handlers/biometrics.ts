import { TRPCError } from '@trpc/server'
import { POSITION_CHANGE_SCORE_MIN, RESTLESS_SCORE_MIN, pickMinBucketNonStillEpochs } from '@/src/lib/movement'
import {
  activeDemoNight,
  deleteDemoNight,
  demoMovement,
  demoNights,
  demoNightsOverlapping,
  demoStageEpochs,
  demoVitals,
  editDemoNight,
  findDemoNight,
  summarizeEpochs,
  type DemoNight,
  type Side,
} from '../history'
import type { DemoHandlers, RouterOutputs } from '../types'
import { DAY, MINUTE } from '../util'

type SleepRecord = RouterOutputs['biometrics']['getSleepRecords'][number]

const SIDES: Side[] = ['left', 'right']
const HISTORY_START = () => Date.now() - 50 * DAY

function toRecord(n: DemoNight): SleepRecord {
  return {
    id: n.id,
    side: n.side,
    enteredBedAt: n.enteredBedAt,
    leftBedAt: n.leftBedAt,
    sleepDurationSeconds: n.sleepDurationSeconds,
    timesExitedBed: n.timesExitedBed,
    presentIntervals: n.presentIntervals,
    notPresentIntervals: n.notPresentIntervals,
    createdAt: n.leftBedAt ?? n.enteredBedAt,
  }
}

function range(input: { startDate?: Date, endDate?: Date }) {
  const start = input.startDate?.getTime() ?? HISTORY_START()
  const end = input.endDate?.getTime() ?? Date.now()
  if (start > end) throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
  return { start, end }
}

const sidesFor = (side?: Side) => (side ? [side] : SIDES)
const sideBit = (side: Side) => (side === 'right' ? 1 : 0)

const emptyStages = (sleepRecordId: number | null = null, enteredBedAt: number | null = null, leftBedAt: number | null = null) => ({
  epochs: [],
  blocks: [],
  distribution: { wake: 0, light: 0, deep: 0, rem: 0 },
  qualityScore: 0,
  totalSleepMs: 0,
  sleepRecordId,
  enteredBedAt,
  leftBedAt,
})

function stagesForNight(n: DemoNight) {
  const end = n.leftBedAt?.getTime() ?? Date.now()
  const epochs = demoStageEpochs(n, n.enteredBedAt.getTime(), end)
  if (epochs.length === 0) return emptyStages(n.id, n.enteredBedAt.getTime(), n.leftBedAt?.getTime() ?? null)
  return {
    epochs,
    ...summarizeEpochs(epochs),
    sleepRecordId: n.id,
    enteredBedAt: n.enteredBedAt.getTime(),
    leftBedAt: n.leftBedAt?.getTime() ?? null,
  }
}

/** Server default for getSleepStages: last night, preferring an overnight session of 3 h+. */
function lastNight(side: Side): DemoNight | undefined {
  const recent = demoNights(side).filter(n => n.enteredBedAt.getTime() >= Date.now() - 7 * DAY)
  return recent.find((n) => {
    const h = n.enteredBedAt.getHours()
    return n.sleepDurationSeconds >= 3 * 3600 && (h >= 20 || h < 4)
  }) ?? recent[0]
}

export const biometrics: DemoHandlers<'biometrics'> = {
  getSleepRecords: (input) => {
    const { start, end } = range(input)
    return sidesFor(input.side)
      .flatMap(side => demoNights(side))
      .filter(n => n.enteredBedAt.getTime() >= start && n.enteredBedAt.getTime() <= end)
      .sort((a, b) => b.enteredBedAt.getTime() - a.enteredBedAt.getTime())
      .slice(0, input.limit ?? 30)
      .map(toRecord)
  },

  getSleepRecord: (input) => {
    const n = findDemoNight(input.id)
    return n ? toRecord(n) : null
  },

  getLatestSleep: (input) => {
    const n = demoNights(input.side)[0]
    return n ? toRecord(n) : null
  },

  getVitals: (input) => {
    const { start, end } = range(input)
    return sidesFor(input.side)
      .flatMap(side => demoVitals(side, start, end).map(v => ({
        id: Math.floor(v.t / 1000) * 2 + sideBit(side),
        side,
        timestamp: new Date(v.t),
        heartRate: v.heartRate,
        hrv: v.hrv,
        breathingRate: v.breathingRate,
      })))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, input.limit ?? 288)
  },

  getVitalsSummary: (input) => {
    const end = input.endDate?.getTime() ?? Date.now()
    const start = input.startDate?.getTime() ?? Date.now() - 7 * DAY
    if (start > end) throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
    const rows = demoVitals(input.side, start, end)
    if (rows.length === 0) return null
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
    const hrs = rows.map(r => r.heartRate)
    return {
      avgHeartRate: avg(hrs),
      minHeartRate: Math.min(...hrs),
      maxHeartRate: Math.max(...hrs),
      avgHRV: avg(rows.map(r => r.hrv)),
      avgBreathingRate: avg(rows.map(r => r.breathingRate)),
      recordCount: rows.length,
    }
  },

  getMovement: (input) => {
    const { start, end } = range(input)
    return sidesFor(input.side)
      .flatMap(side => demoMovement(side, start, end).map(m => ({
        id: Math.floor(m.t / 1000) * 2 + sideBit(side),
        side,
        timestamp: new Date(m.t),
        totalMovement: m.score,
      })))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, input.limit ?? 288)
  },

  getMovementBuckets: (input) => {
    const { start, end } = range(input)
    const bSec = Math.floor(input.bucketSeconds)
    const minNonStill = pickMinBucketNonStillEpochs(bSec)
    const buckets = new Map<number, { total: number, events: number, samples: number, nonStill: number }>()
    for (const m of demoMovement(input.side, start, end)) {
      const key = Math.floor(m.t / 1000 / bSec) * bSec
      const b = buckets.get(key) ?? { total: 0, events: 0, samples: 0, nonStill: 0 }
      b.total += m.score
      b.samples++
      if (m.score >= POSITION_CHANGE_SCORE_MIN) b.events++
      if (m.score >= RESTLESS_SCORE_MIN) b.nonStill++
      buckets.set(key, b)
    }
    return [...buckets.entries()]
      .filter(([, b]) => b.nonStill >= minNonStill)
      .sort(([a], [b]) => b - a)
      .slice(0, input.limit ?? 2000)
      .map(([key, b]) => ({
        side: input.side,
        bucketStart: new Date(key * 1000),
        totalMovement: b.total,
        eventCount: b.events,
        sampleCount: b.samples,
      }))
  },

  getMovementSummary: (input) => {
    const { start, end } = range(input)
    const rows = demoMovement(input.side, start, end)
    return {
      positionChanges: rows.filter(m => m.score >= POSITION_CHANGE_SCORE_MIN).length,
      restlessMinutes: rows.filter(m => m.score >= RESTLESS_SCORE_MIN).length,
      sampleCount: rows.length,
    }
  },

  getOccupancy: () => {
    const now = Date.now()
    const occupancy = (side: Side) => {
      const night = activeDemoNight(side, now)
      const recent = night?.movement.filter(m => m.t >= now - 15 * MINUTE) ?? []
      const peakScore = recent.reduce((max, m) => Math.max(max, m.score), 0)
      const levelActive = night !== null
      return {
        occupied: levelActive || peakScore >= RESTLESS_SCORE_MIN,
        available: true,
        movement: { active: peakScore >= RESTLESS_SCORE_MIN, peakScore },
        level: { active: levelActive, deviation: levelActive ? 3.6 : 0.4, threshold: 1.5, ageMs: 420 },
      }
    }
    return { left: occupancy('left'), right: occupancy('right') }
  },

  getFileCount: () => ({ rawFiles: { left: 42, right: 42 }, totalSizeMB: 1611.42 }),

  updateSleepRecord: (input) => {
    const { id, ...updates } = input
    if (updates.enteredBedAt === undefined && updates.leftBedAt === undefined && updates.timesExitedBed === undefined) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'No fields to update' })
    }
    const existing = findDemoNight(id)
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: `Sleep record ${id} not found` })
    const entered = updates.enteredBedAt ?? existing.enteredBedAt
    const left = updates.leftBedAt ?? existing.leftBedAt
    if ((updates.enteredBedAt || updates.leftBedAt) && left && left <= entered) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'leftBedAt must be after enteredBedAt' })
    }
    const updated = editDemoNight(id, updates)
    if (!updated) throw new TRPCError({ code: 'NOT_FOUND', message: `Sleep record ${id} not found` })
    return toRecord(updated)
  },

  deleteSleepRecord: (input) => {
    if (!deleteDemoNight(input.id)) throw new TRPCError({ code: 'NOT_FOUND', message: `Sleep record ${input.id} not found` })
    return { success: true }
  },

  getSleepStages: (input) => {
    if (input.sleepRecordId && (input.startDate || input.endDate)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Provide either sleepRecordId or startDate/endDate, not both' })
    }
    if (input.sleepRecordId) {
      const n = findDemoNight(input.sleepRecordId)
      if (!n || n.side !== input.side) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Sleep record ${input.sleepRecordId} not found for side '${input.side}'` })
      }
      return stagesForNight(n)
    }
    if (input.startDate && input.endDate) {
      const { start, end } = range(input)
      const epochs = demoNightsOverlapping(input.side, start, end)
        .reverse()
        .flatMap(n => demoStageEpochs(n, Math.max(start, n.enteredBedAt.getTime()), Math.min(end, n.leftBedAt?.getTime() ?? Date.now())))
      if (epochs.length === 0) return emptyStages()
      return { epochs, ...summarizeEpochs(epochs), sleepRecordId: null, enteredBedAt: null, leftBedAt: null }
    }
    const n = lastNight(input.side)
    return n ? stagesForNight(n) : emptyStages()
  },
}

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
import { DAY, HOUR, MINUTE, hashSeed, randomBetween, seededRandom } from '../util'
import { classifyDemoWindow } from '../biometrics/stages'
import { demoStageView } from './biometricTuning'
import { mergeIntoBlocks, type SleepStageBlock } from '@/src/lib/sleep-stages'
import { compareNightsToWatch, HRV_NOTE, WATCH_PAIRING_WINDOW_MS, type DeviationNightInput } from '@/src/biometrics/references/watch-deviation'
import type { StageClassifier } from '@/src/lib/sleep-stage-rules'

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

async function stagesForNight(n: DemoNight) {
  const stageView = await demoStageView(n.side)
  const end = n.leftBedAt?.getTime() ?? Date.now()
  const epochs = classifyDemoWindow(n.side, n.enteredBedAt.getTime(), end, stageView.classifier)
  if (epochs.length === 0) return { ...emptyStages(n.id, n.enteredBedAt.getTime(), n.leftBedAt?.getTime() ?? null), stageView }
  return {
    epochs,
    stageView,
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

/**
 * Two simulated profile changes, the mornings after the 10th and 5th newest
 * finished nights, so the deviation trend has markers and a story: each one
 * brings the pod closer to the Watch.
 */
function demoConfigChanges(side: Side) {
  const finished = demoNights(side).filter(n => n.leftBedAt !== null)
  return [[1, 9], [2, 4]].flatMap(([generation, index]) => {
    const night = finished[index]
    return night?.leftBedAt ? [{ generation, atMs: night.leftBedAt.getTime() + 2 * HOUR }] : []
  })
}

/** How far the demo pod reads above the Watch before the first change, between them and after the second. */
const DEMO_POD_OFFSET = { heartRate: [4.5, 2.8, 1.5], breathingRate: [2.4, 1.9, 1.4] }

/**
 * A finished demo night as compareToWatch sees it. The Watch reads a little
 * below the pod (less so after each simulated profile change, `step`) with
 * some scatter (HR every 10 min, breathing every 15 min, two SDNN samples a
 * night), and the scripted hypnogram stands in for its stages, as in the
 * sleepStages demo.
 */
function demoDeviationNight(n: DemoNight & { leftBedAt: Date }, classifier: StageClassifier, step: number): DeviationNightInput {
  const start = n.enteredBedAt.getTime()
  const end = n.leftBedAt.getTime()
  const rand = seededRandom(hashSeed(`watch:${n.id}`))
  const pad = WATCH_PAIRING_WINDOW_MS.hrv
  const vitals = demoVitals(n.side, start - pad, end + pad)
  const inNight = vitals.filter(v => v.t >= start && v.t <= end)
  const watch = (every: number, value: (v: typeof vitals[number]) => number) =>
    inNight.filter((_, i) => i % every === 0).map(v => ({ t: v.t, v: Math.round(value(v) * 10) / 10 }))
  const reference: SleepStageBlock[] = mergeIntoBlocks(demoStageEpochs(n, start, end))
  return {
    sleepRecordId: n.id,
    enteredBedAt: n.enteredBedAt,
    leftBedAt: n.leftBedAt,
    pod: {
      heartRate: vitals.map(v => ({ t: v.t, v: v.heartRate })),
      breathingRate: vitals.map(v => ({ t: v.t, v: v.breathingRate })),
      hrv: vitals.map(v => ({ t: v.t, v: v.hrv })),
    },
    watch: {
      heartRate: watch(5, v => v.heartRate - DEMO_POD_OFFSET.heartRate[step] + randomBetween(rand, -3, 3)),
      breathingRate: watch(8, v => v.breathingRate - DEMO_POD_OFFSET.breathingRate[step] + randomBetween(rand, -1, 1)),
      hrvSdnn: [1 / 3, 2 / 3].flatMap((f) => {
        const v = inNight[Math.floor(inNight.length * f)]
        return v ? [{ t: v.t, v: Math.round(v.hrv * randomBetween(rand, 0.6, 0.8)) }] : []
      }),
    },
    epochs: classifyDemoWindow(n.side, start, end, classifier),
    reference,
  }
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

  // Imported Apple Watch heart rate: one sample every five minutes, a touch
  // below the pod's reading, so the Biometrics page shows the overlay.
  getReferenceVitals: (input) => {
    const start = input.startDate.getTime()
    const end = input.endDate.getTime()
    if (start > end) throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
    return demoVitals(input.side, start, end)
      .filter((_, i) => i % 5 === 0)
      .map(v => ({
        id: Math.floor(v.t / 1000) * 2 + sideBit(input.side),
        side: input.side,
        source: 'apple_watch' as const,
        timestamp: new Date(v.t),
        heartRate: Math.round((v.heartRate - 1.5) * 10) / 10,
        createdAt: new Date(v.t),
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      .slice(-(input.limit ?? 5000))
  },

  compareToWatch: async (input) => {
    const endDate = input.endDate ?? new Date()
    const startDate = input.startDate ?? new Date(endDate.getTime() - 14 * DAY)
    if (startDate > endDate) throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
    if (endDate.getTime() - startDate.getTime() > 31 * DAY) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Select at most 31 days' })
    const minHours = input.minHours ?? 3
    const view = await demoStageView(input.side)
    const changes = demoConfigChanges(input.side)
    const nights = demoNights(input.side)
      .filter((n): n is DemoNight & { leftBedAt: Date } => n.leftBedAt !== null
        && n.enteredBedAt >= startDate && n.enteredBedAt <= endDate
        && n.leftBedAt.getTime() - n.enteredBedAt.getTime() >= minHours * 3_600_000)
      .reverse()
      .map(n => demoDeviationNight(n, view.classifier, changes.filter(c => c.atMs <= n.enteredBedAt.getTime()).length))
    return {
      side: input.side,
      startDate,
      endDate,
      minHours,
      classifier: { isDefault: view.isDefault, source: view.provenance.source, generation: view.provenance.generation, stageHash: view.provenance.stageHash },
      hrvNote: HRV_NOTE,
      ...compareNightsToWatch(nights),
      configChanges: changes.filter(c => c.atMs >= startDate.getTime() && c.atMs <= endDate.getTime()),
    }
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
      const occupied = levelActive || peakScore >= RESTLESS_SCORE_MIN
      return {
        occupied,
        available: true,
        classification: occupied ? 'person' as const : 'none' as const,
        movement: { active: peakScore >= RESTLESS_SCORE_MIN, peakScore },
        level: {
          active: levelActive,
          deviation: levelActive ? 3.6 : 0.4,
          threshold: 1.5,
          ageMs: 420,
          zoneDeviations: levelActive ? [1.3, 1.4, 0.9] : [0.2, 0.1, 0.1],
          zones: levelActive ? 3 : 0,
        },
        vitals: levelActive
          ? { heartRate: 58, breathingRate: 13, humanRange: true }
          : { heartRate: null, breathingRate: null, humanRange: null },
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

  getSleepStages: async (input) => {
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
      const stageView = await demoStageView(input.side)
      const epochs = demoNightsOverlapping(input.side, start, end)
        .reverse()
        .flatMap(n => classifyDemoWindow(input.side, Math.max(start, n.enteredBedAt.getTime()), Math.min(end, n.leftBedAt?.getTime() ?? Date.now()), stageView.classifier))
      if (epochs.length === 0) return { ...emptyStages(), stageView }
      return { epochs, stageView, ...summarizeEpochs(epochs), sleepRecordId: null, enteredBedAt: null, leftBedAt: null }
    }
    const n = lastNight(input.side)
    return n ? stagesForNight(n) : { ...emptyStages(), stageView: await demoStageView(input.side) }
  },
}

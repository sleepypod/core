import type { DemoHandlers, RouterOutputs } from '../types'
import { DAY, HOUR, MINUTE, hashSeed, randomBetween, seededRandom, startOfDay } from '../util'

type Side = 'left' | 'right'
type SensorType = 'capacitance' | 'piezo' | 'temperature'
type Profile = NonNullable<RouterOutputs['calibration']['getStatus']['capacitance']>
type Run = RouterOutputs['calibration']['getHistory'][number]

const SENSORS: SensorType[] = ['capacitance', 'piezo', 'temperature']
// A triggered calibration "runs" this long before completing.
const RUN_MS = 8_000

// Baselines line up with the fake sensor socket's empty-bed readings so the
// diagnostics panels draw signals inside their calibrated bands.
const PARAMS: Record<Side, Record<SensorType, Record<string, unknown>>> = {
  left: {
    capacitance: { format: 'capSense2', threshold: 6, channels: { A: { mean: 17.135, std: 0.03 }, B: { mean: 17.205, std: 0.03 }, C: { mean: 21.6, std: 0.03 } }, ref: { mean: 1.16, std: 0.01 } },
    piezo: { noise_floor_rms: 410.5, presence_threshold: 12000, baseline_mean_range: 2100.4 },
    temperature: { ambient_mean: 21.4, offsets: { left_outer_temp: 0.4, left_center_temp: 0.7, left_inner_temp: 0.2 } },
  },
  right: {
    capacitance: { format: 'capSense2', threshold: 6, channels: { A: { mean: 16.05, std: 0.03 }, B: { mean: 15.925, std: 0.03 }, C: { mean: 22.46, std: 0.03 } }, ref: { mean: 1.17, std: 0.01 } },
    piezo: { noise_floor_rms: 388.2, presence_threshold: 12000, baseline_mean_range: 1980.7 },
    temperature: { ambient_mean: 21.4, offsets: { right_outer_temp: 0.3, right_center_temp: 0.8, right_inner_temp: 0.5 } },
  },
}

const QUALITY: Record<SensorType, number> = { capacitance: 0.94, piezo: 0.88, temperature: 0.97 }
const SAMPLES: Record<SensorType, number> = { capacitance: 300, piezo: 150, temperature: 180 }

let nextId = 1
// Last daily run: 3:15 this morning.
const lastDaily = startOfDay(0).getTime() + 3 * HOUR + 15 * MINUTE

function completedProfile(side: Side, type: SensorType, createdAt: number): Profile {
  return {
    id: nextId++,
    side,
    sensorType: type,
    status: 'completed',
    qualityScore: QUALITY[type],
    samplesUsed: SAMPLES[type],
    createdAt: new Date(createdAt),
    expiresAt: new Date(createdAt + DAY),
    errorMessage: null,
    parameters: PARAMS[side][type],
  }
}

const profiles: Record<Side, Record<SensorType, Profile & { completesAt?: number }>> = {
  left: { capacitance: completedProfile('left', 'capacitance', lastDaily), piezo: completedProfile('left', 'piezo', lastDaily), temperature: completedProfile('left', 'temperature', lastDaily) },
  right: { capacitance: completedProfile('right', 'capacitance', lastDaily), piezo: completedProfile('right', 'piezo', lastDaily), temperature: completedProfile('right', 'temperature', lastDaily) },
}

function buildHistory(side: Side): Run[] {
  const runs: Run[] = []
  for (let day = 0; day < 7; day++) {
    const at = lastDaily - day * DAY
    for (const type of SENSORS) {
      const rand = seededRandom(hashSeed(`cal:${side}:${type}:${day}`))
      runs.push({
        id: nextId++,
        side,
        sensorType: type,
        status: 'completed',
        parameters: PARAMS[side][type],
        qualityScore: Math.round((QUALITY[type] + randomBetween(rand, -0.06, 0.03)) * 100) / 100,
        sourceWindowStart: Math.floor((at - 6 * HOUR) / 1000),
        sourceWindowEnd: Math.floor((at - 5 * HOUR) / 1000),
        samplesUsed: SAMPLES[type],
        errorMessage: null,
        durationMs: Math.round(randomBetween(rand, 1800, 5200)),
        triggeredBy: 'daily',
        createdAt: new Date(at),
      })
    }
  }
  return runs
}

const history: Record<Side, Run[]> = { left: buildHistory('left'), right: buildHistory('right') }

/** Promote pending/running profiles once their simulated run time has passed. */
function settle(side: Side) {
  const now = Date.now()
  for (const type of SENSORS) {
    const p = profiles[side][type]
    if (p.completesAt === undefined) continue
    if (now >= p.completesAt) {
      profiles[side][type] = completedProfile(side, type, now)
      history[side].unshift({
        id: nextId++, side, sensorType: type, status: 'completed', parameters: PARAMS[side][type],
        qualityScore: QUALITY[type], sourceWindowStart: Math.floor((now - HOUR) / 1000), sourceWindowEnd: Math.floor(now / 1000),
        samplesUsed: SAMPLES[type], errorMessage: null, durationMs: RUN_MS, triggeredBy: 'manual', createdAt: new Date(now),
      })
    }
    else if (now >= p.completesAt - RUN_MS / 2) {
      p.status = 'running'
    }
  }
}

function trigger(side: Side, type: SensorType) {
  profiles[side][type] = { ...profiles[side][type], status: 'pending', errorMessage: null, createdAt: new Date(), completesAt: Date.now() + RUN_MS }
}

function publicProfile(p: Profile & { completesAt?: number }): Profile {
  return {
    id: p.id, side: p.side, sensorType: p.sensorType, status: p.status, qualityScore: p.qualityScore,
    samplesUsed: p.samplesUsed, createdAt: p.createdAt, expiresAt: p.expiresAt, errorMessage: p.errorMessage, parameters: p.parameters,
  }
}

export const calibration: DemoHandlers<'calibration'> = {
  getStatus: (input) => {
    settle(input.side)
    const p = profiles[input.side]
    return { capacitance: publicProfile(p.capacitance), piezo: publicProfile(p.piezo), temperature: publicProfile(p.temperature) }
  },

  getHistory: (input) => {
    settle(input.side)
    return history[input.side]
      .filter(r => !input.sensorType || r.sensorType === input.sensorType)
      .slice(0, input.limit ?? 10)
  },

  triggerCalibration: (input) => {
    trigger(input.side, input.sensorType)
    return {
      triggered: true,
      message: `Calibration queued for ${input.side}/${input.sensorType}. The calibrator module will process it within 10 seconds.`,
    }
  },

  triggerFullCalibration: () => {
    for (const side of ['left', 'right'] as const) {
      for (const type of SENSORS) trigger(side, type)
    }
    return { triggered: true, message: 'Full calibration queued for all sensors on both sides.' }
  },

  getVitalsQuality: (input) => {
    const end = Math.min(input.endDate?.getTime() ?? Date.now(), Date.now())
    const start = input.startDate?.getTime() ?? end - 2 * DAY
    const out: RouterOutputs['calibration']['getVitalsQuality'] = []
    // One vitals row per 5 minutes, newest first, only overnight hours.
    for (let t = Math.floor(end / (5 * MINUTE)) * 5 * MINUTE; t >= start && out.length < (input.limit ?? 100); t -= 5 * MINUTE) {
      const hour = new Date(t).getHours()
      if (hour >= 8 && hour < 23) continue
      const rand = seededRandom(hashSeed(`vq:${input.side}:${t}`))
      const score = Math.round(randomBetween(rand, 0.62, 0.98) * 100) / 100
      out.push({
        id: Math.floor(t / 1000),
        vitalsId: Math.floor(t / 1000),
        side: input.side,
        timestamp: new Date(t),
        qualityScore: score,
        flags: score < 0.7 ? ['motion_artifact'] : [],
        hrRaw: Math.round(randomBetween(rand, 52, 66)),
        createdAt: new Date(t),
      })
    }
    return out
  },
}

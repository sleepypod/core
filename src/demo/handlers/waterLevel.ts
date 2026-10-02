import type { DemoHandlers, RouterOutputs } from '../types'
import { DAY, HOUR, MINUTE, hashSeed, randomBetween, seededRandom } from '../util'

type Alert = RouterOutputs['waterLevel']['getAlerts'][number]
type Reading = RouterOutputs['waterLevel']['getHistory'][number]
type FlowReading = RouterOutputs['waterLevel']['getFlowReadings'][number]

const READING_INTERVAL = 5 * MINUTE
const FLOW_INTERVAL = 2 * MINUTE

// The tank ran low for a couple of hours five days ago, then got topped up.
const lowStart = Date.now() - 5 * DAY + 2 * HOUR
const lowEnd = lowStart + 2 * HOUR + 20 * MINUTE

const alerts: Alert[] = [
  {
    id: 1,
    type: 'low_sustained',
    startedAt: new Date(lowStart),
    dismissedAt: new Date(lowEnd + 30 * MINUTE),
    message: 'Water level has been low for over 2 hours. Refill the reservoir.',
    createdAt: new Date(lowStart + 2 * HOUR),
  },
]

function readingAt(t: number): Reading {
  return { id: Math.floor(t / READING_INTERVAL), timestamp: new Date(t), level: t >= lowStart && t < lowEnd ? 'low' : 'ok' }
}

function readings(start: number, end: number, limit: number): Reading[] {
  const out: Reading[] = []
  for (let t = Math.floor(end / READING_INTERVAL) * READING_INTERVAL; t >= start && out.length < limit; t -= READING_INTERVAL) {
    out.push(readingAt(t))
  }
  return out
}

/** Pumps run during the night and whenever a side is holding a temperature. */
function flowAt(t: number): FlowReading {
  const rand = seededRandom(hashSeed(`flow:${t}`))
  const hour = new Date(t).getHours()
  const active = hour >= 21 || hour < 8 || Date.now() - t < 3 * HOUR
  const rpm = () => (active ? Math.round(2400 + randomBetween(rand, -60, 60)) : 0)
  const flow = () => Math.round((active ? 28.7 + randomBetween(rand, -0.6, 0.6) : 21.5 + randomBetween(rand, -0.2, 0.2)) * 100)
  return {
    id: Math.floor(t / FLOW_INTERVAL),
    timestamp: new Date(t),
    leftFlowrateCd: flow(),
    rightFlowrateCd: flow(),
    leftPumpRpm: rpm(),
    rightPumpRpm: rpm(),
  }
}

export const waterLevel: DemoHandlers<'waterLevel'> = {
  getHistory: (input) => {
    const end = Math.min(input.endDate?.getTime() ?? Date.now(), Date.now())
    const start = input.startDate?.getTime() ?? end - DAY
    return readings(start, end, input.limit ?? 1440)
  },

  getLatest: () => readingAt(Math.floor(Date.now() / READING_INTERVAL) * READING_INTERVAL),

  getTrend: (input) => {
    const hours = input.hours ?? 24
    const rows = readings(Date.now() - hours * HOUR, Date.now(), 100_000)
    const low = rows.filter(r => r.level === 'low').length
    return {
      totalReadings: rows.length,
      okPercent: Math.round(((rows.length - low) / rows.length) * 100),
      lowPercent: Math.round((low / rows.length) * 100),
      trend: 'stable',
    }
  },

  getAlerts: () => alerts.filter(a => a.dismissedAt === null),

  dismissAlert: (input) => {
    const alert = alerts.find(a => a.id === input.id && a.dismissedAt === null)
    if (!alert) throw new Error(`Alert ${input.id} not found or already dismissed`)
    alert.dismissedAt = new Date()
    return { success: true }
  },

  getFlowReadings: (input) => {
    const end = Math.floor(Date.now() / FLOW_INTERVAL) * FLOW_INTERVAL
    const out: FlowReading[] = []
    for (let t = end - (input.hours ?? 24) * HOUR; t <= end; t += FLOW_INTERVAL) out.push(flowAt(t))
    return out
  },

  getLatestFlowReading: () => flowAt(Math.floor(Date.now() / FLOW_INTERVAL) * FLOW_INTERVAL),
}

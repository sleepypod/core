import { recordedBedTemperature } from '../bedTemperatureSamples'
import { TRPCError } from '@trpc/server'
import { demoNightsOverlapping, type Side } from '../history'
import type { DemoHandlers } from '../types'
import { HOUR, MINUTE, hashSeed, seededRandom } from '../util'

type Unit = 'F' | 'C'

// Sensor rows land once a minute, like the pod's bed_temp / freezer_temp tables.
const STEP = MINUTE

const floorMinute = (t: number) => Math.floor(t / STEP) * STEP
const noise = (t: number, salt: string, amp: number) => (seededRandom(hashSeed(`${salt}:${t}`))() - 0.5) * 2 * amp
const hourOf = (t: number) => {
  const d = new Date(t)
  return d.getHours() + d.getMinutes() / 60
}

const round2 = (v: number) => Math.round(v * 100) / 100
const temp = (c: number, unit: Unit) => (unit === 'F' ? (round2(c) * 9) / 5 + 32 : round2(c))

/** Bedroom air: ~21 °C, warmest mid-afternoon, coolest before dawn. */
const ambientC = (t: number) => 21 + 0.8 * Math.sin((2 * Math.PI * (hourOf(t) - 9)) / 24) + noise(t, 'amb', 0.08)

/** Bedroom light: daylight through curtains, lamps in the evening, dark overnight. */
function lux(t: number): number {
  const h = hourOf(t)
  const day = new Date(t).toDateString()
  const cloud = 0.55 + 0.45 * seededRandom(hashSeed(`cloud:${day}`))()
  if (h >= 6.5 && h < 19.5) return Math.max(0, 320 * Math.sin((Math.PI * (h - 6.5)) / 13) ** 1.5 * cloud + noise(t, 'lux', 6))
  if (h >= 19.5 && h < 23) return 55 + noise(t, 'lamp', 8)
  return 0.3
}

/** In-bed intervals per side across [start, end], so surface temps track occupancy. */
function occupancyLookup(start: number, end: number) {
  const spans: Record<Side, Array<[number, number]>> = { left: [], right: [] }
  for (const side of ['left', 'right'] as const) {
    for (const n of demoNightsOverlapping(side, start, end)) {
      for (const [s, e] of n.presentIntervals) spans[side].push([s * 1000, e === null ? Date.now() : e * 1000])
    }
  }
  return (side: Side, t: number) => spans[side].some(([s, e]) => t >= s && t < e)
}

type Occupied = ReturnType<typeof occupancyLookup>

/** Bed rows replay the same recorded snapshots as the live stream and getLatestBedTemp,
 * so history, latest, and live frames agree at any shared timestamp. */
function bedRow(t: number, unit: Unit) {
  const reading = recordedBedTemperature(Math.floor(t / 1000))
  return {
    id: t / STEP,
    timestamp: new Date(t),
    ambientTemp: temp(reading.ambientTemp, unit),
    mcuTemp: temp(reading.mcuTemp, unit),
    humidity: reading.humidity,
    leftOuterTemp: temp(reading.leftOuterTemp, unit),
    leftCenterTemp: temp(reading.leftCenterTemp, unit),
    leftInnerTemp: temp(reading.leftInnerTemp, unit),
    rightOuterTemp: temp(reading.rightOuterTemp, unit),
    rightCenterTemp: temp(reading.rightCenterTemp, unit),
    rightInnerTemp: temp(reading.rightInnerTemp, unit),
  }
}

function freezerRow(t: number, occupied: Occupied, unit: Unit) {
  const amb = ambientC(t) + 0.4
  // Water runs cooler on the left (cool sleeper) and warmer on the right overnight.
  const water = (side: Side) => (occupied(side, t) ? (side === 'left' ? 19.6 : 27.4) : 25.8) + noise(t, `w${side}`, 0.1)
  return {
    id: t / STEP,
    timestamp: new Date(t),
    ambientTemp: temp(amb, unit),
    heatsinkTemp: temp(amb + 3.6 + noise(t, 'hs', 0.15), unit),
    leftWaterTemp: temp(water('left'), unit),
    rightWaterTemp: temp(water('right'), unit),
  }
}

function minuteWindow(input: { startDate?: Date, endDate?: Date, limit?: number }) {
  const end = floorMinute(Math.min(input.endDate?.getTime() ?? Date.now(), Date.now()))
  const limit = input.limit ?? 1440
  const start = Math.max(input.startDate?.getTime() ?? 0, end - (limit - 1) * STEP)
  if (input.startDate && input.endDate && input.startDate > input.endDate) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
  }
  const times: number[] = []
  for (let t = end; t >= start; t -= STEP) times.push(t)
  return { times, start, end }
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)

export const environment: DemoHandlers<'environment'> = {
  getBedTemp: (input) => {
    const { times } = minuteWindow(input)
    return times.map(t => bedRow(t, input.unit ?? 'F'))
  },

  getFreezerTemp: (input) => {
    const { times, start, end } = minuteWindow(input)
    const occupied = occupancyLookup(start, end)
    return times.map(t => freezerRow(t, occupied, input.unit ?? 'F'))
  },

  getLatestBedTemp: (input) => {
    const t = Math.floor(Date.now() / 1000)
    return { ...bedRow(t * 1000, input.unit ?? 'F'), id: t }
  },

  getLatestFreezerTemp: (input) => {
    const t = floorMinute(Date.now())
    return freezerRow(t, occupancyLookup(t - HOUR, t), input.unit ?? 'F')
  },

  getSummary: (input) => {
    if (input.startDate > input.endDate) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'startDate must be before or equal to endDate' })
    }
    const unit = input.unit ?? 'F'
    const start = Math.ceil(input.startDate.getTime() / STEP) * STEP
    const end = Math.min(input.endDate.getTime(), Date.now())
    if (end < start) return { bedTemp: null, freezerTemp: null }
    const occupied = occupancyLookup(start, end)
    // Aggregate in Celsius, convert once (matches the server's avg-then-convert).
    const bed: ReturnType<typeof bedRow>[] = []
    const frz: ReturnType<typeof freezerRow>[] = []
    for (let t = start; t <= end; t += STEP) {
      bed.push(bedRow(t, 'C'))
      frz.push(freezerRow(t, occupied, 'C'))
    }
    const conv = (c: number | null) => (c === null ? null : temp(c, unit))
    const pick = <T>(rows: T[], f: (r: T) => number | null) => rows.map(f).filter((v): v is number => v !== null)
    const ambients = pick(bed, r => r.ambientTemp)
    return {
      bedTemp: {
        avgAmbientTemp: conv(avg(ambients)),
        minAmbientTemp: conv(Math.min(...ambients)),
        maxAmbientTemp: conv(Math.max(...ambients)),
        avgHumidity: avg(pick(bed, r => r.humidity)),
        avgLeftCenterTemp: conv(avg(pick(bed, r => r.leftCenterTemp))),
        avgRightCenterTemp: conv(avg(pick(bed, r => r.rightCenterTemp))),
        recordCount: bed.length,
      },
      freezerTemp: {
        avgAmbientTemp: conv(avg(pick(frz, r => r.ambientTemp))),
        avgHeatsinkTemp: conv(avg(pick(frz, r => r.heatsinkTemp))),
        avgLeftWaterTemp: conv(avg(pick(frz, r => r.leftWaterTemp))),
        avgRightWaterTemp: conv(avg(pick(frz, r => r.rightWaterTemp))),
        recordCount: frz.length,
      },
    }
  },

  getAmbientLight: (input) => {
    const { times } = minuteWindow(input)
    return times.map(t => ({ id: t / STEP, timestamp: new Date(t), lux: Math.round(lux(t) * 10) / 10 }))
  },

  getLatestAmbientLight: () => {
    const t = floorMinute(Date.now())
    return { id: t / STEP, timestamp: new Date(t), lux: Math.round(lux(t) * 10) / 10 }
  },

  getAmbientLightSummary: (input) => {
    const start = Math.ceil(input.startDate.getTime() / STEP) * STEP
    const end = Math.min(input.endDate.getTime(), Date.now())
    const values: number[] = []
    for (let t = start; t <= end; t += STEP) values.push(lux(t))
    if (values.length === 0) return null
    return { avgLux: avg(values), minLux: Math.min(...values), maxLux: Math.max(...values), recordCount: values.length }
  },
}

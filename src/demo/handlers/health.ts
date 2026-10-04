import { NODES, evaluateDataPath, type DataPathInputs, type NodeId } from '@/src/lib/dataPath'
import type { DemoHandlers, RouterOutputs } from '../types'
import { DAY, HOUR, MINUTE, hashSeed, randomBetween, seededRandom } from '../util'
import { getDemoDeviceStatus } from './device'
import { DEMO_UPTIME_START } from './system'

type Side = 'left' | 'right'
type ThermalHistory = RouterOutputs['health']['thermalHistory']
type ThermalPoint = ThermalHistory['points'][number]
type Occurrence = RouterOutputs['health']['schedulerTimeline']['occurrences'][number]
type History = RouterOutputs['health']['history']

const SIDES: Side[] = ['left', 'right']
const AMBIENT_F = 71.5
const MAX_BUCKETS = 360
const THERMAL_RANGES = { '1h': 3_600, '12h': 43_200, '24h': 86_400, '48h': 172_800, '7d': 604_800 } as const
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

// ── The demo's nightly routine ───────────────────────────────────────────────
// Both the scheduler views and the thermal history are drawn from this plan.

interface SetPoint { id: number, time: string, tempF: number }
interface SidePlan { on: string, off: string, onTempF: number, setPoints: SetPoint[], alarm?: { id: number, time: string, days: string } }

const PLAN: Record<Side, SidePlan & { powerId: number }> = {
  left: {
    powerId: 1,
    on: '22:00',
    off: '07:30',
    onTempF: 70,
    setPoints: [{ id: 11, time: '23:30', tempF: 68 }, { id: 12, time: '03:00', tempF: 66 }, { id: 13, time: '06:00', tempF: 71 }],
    alarm: { id: 21, time: '07:00', days: '1-5' },
  },
  right: {
    powerId: 2,
    on: '22:00',
    off: '07:30',
    onTempF: 78,
    setPoints: [{ id: 14, time: '01:00', tempF: 80 }, { id: 15, time: '05:00', tempF: 82 }],
  },
}

const PRIME_TIME = '14:00'

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

const cronOf = (hhmm: string, days = '*') => {
  const [h, m] = hhmm.split(':').map(Number)
  return `${m} ${h} * * ${days}`
}

/** Scheduled target at local time `t`, or null when the side is scheduled off. */
function scheduledTarget(side: Side, t: number): number | null {
  const plan = PLAN[side]
  const d = new Date(t)
  const mins = d.getHours() * 60 + d.getMinutes()
  const on = minutesOf(plan.on)
  const off = minutesOf(plan.off)
  const inNight = mins >= on || mins < off
  if (!inNight) return null
  // Walk set points in night order (evening first, then after midnight).
  const nightMins = (m: number) => (m >= on ? m - on : m + 24 * 60 - on)
  let target = plan.onTempF
  for (const sp of [...plan.setPoints].sort((a, b) => nightMins(minutesOf(a.time)) - nightMins(minutesOf(b.time)))) {
    if (nightMins(minutesOf(sp.time)) <= nightMins(mins)) target = sp.tempF
  }
  return target
}

// The current demo session started a couple of hours before the page loaded.
const sessionStart = Date.now() - 2 * HOUR

function targetAt(side: Side, t: number): number | null {
  if (t >= sessionStart) {
    const s = side === 'left' ? getDemoDeviceStatus('F').leftSide : getDemoDeviceStatus('F').rightSide
    return s.targetTemperature ?? scheduledTarget(side, t)
  }
  return scheduledTarget(side, t)
}

// ── Scheduler ────────────────────────────────────────────────────────────────

interface Job { id: string, type: string, side?: Side, schedule: string, targetTempF: number | null, brightness: number | null }

const JOBS: Job[] = [
  ...SIDES.flatMap((side): Job[] => {
    const p = PLAN[side]
    return [
      { id: `power-on-${p.powerId}`, type: 'power_on', side, schedule: cronOf(p.on), targetTempF: p.onTempF, brightness: null },
      { id: `power-off-${p.powerId}`, type: 'power_off', side, schedule: cronOf(p.off), targetTempF: null, brightness: null },
      ...p.setPoints.map(sp => ({ id: `temp-${sp.id}`, type: 'temperature', side, schedule: cronOf(sp.time), targetTempF: sp.tempF, brightness: null })),
      ...(p.alarm ? [{ id: `alarm-${p.alarm.id}`, type: 'alarm', side, schedule: cronOf(p.alarm.time, p.alarm.days), targetTempF: null, brightness: null }] : []),
    ]
  }),
  { id: 'prime-daily', type: 'prime', schedule: cronOf(PRIME_TIME), targetTempF: null, brightness: null },
  { id: 'led-night-start', type: 'led_brightness', schedule: cronOf('22:00'), targetTempF: null, brightness: 0 },
  { id: 'led-night-end', type: 'led_brightness', schedule: cronOf('07:00'), targetTempF: null, brightness: 40 },
  { id: 'calibration-daily', type: 'calibration', schedule: cronOf('03:15'), targetTempF: null, brightness: null },
]

/** Every firing of `job` between `from` and `to` (local time). */
function firings(job: Job, from: number, to: number): number[] {
  const [m, h, , , days] = job.schedule.split(' ')
  const [lo, hi] = days === '*' ? [0, 6] : days.split('-').map(Number)
  const allowed = (d: number) => d >= lo && d <= hi
  const out: number[] = []
  const cursor = new Date(from)
  cursor.setHours(0, 0, 0, 0)
  while (cursor.getTime() <= to) {
    const at = new Date(cursor)
    at.setHours(Number(h), Number(m), 0, 0)
    if (at.getTime() >= from && at.getTime() <= to && allowed(at.getDay())) out.push(at.getTime())
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

const nextRun = (job: Job) => firings(job, Date.now(), Date.now() + 8 * DAY)[0] ?? null

// ── Thermal ──────────────────────────────────────────────────────────────────

function thermalHistory(range: keyof typeof THERMAL_RANGES): ThermalHistory {
  const now = Date.now()
  const bucketSec = Math.max(60, Math.ceil(THERMAL_RANGES[range] / MAX_BUCKETS))
  const to = Math.floor(now / 1000)
  const from = to - THERMAL_RANGES[range]
  const step = bucketSec * 1000

  // Simulate bed temperature forward from a warm-up point so the first bucket is settled.
  const bed: Record<Side, number> = { left: AMBIENT_F + 2, right: AMBIENT_F + 2 }
  const powered: Record<Side, boolean> = { left: false, right: false }
  const powerOn: ThermalHistory['powerOn'] = []
  const points: ThermalPoint[] = []

  for (let t = from * 1000 - 3 * HOUR; t <= now; t += step) {
    const rand = seededRandom(hashSeed(`thermal:${Math.floor(t / step)}`))
    const p: ThermalPoint = {
      t: t + step / 2, leftBed: null, rightBed: null, leftTarget: null, rightTarget: null,
      leftWater: null, rightWater: null, leftSurface: null, rightSurface: null,
      leftRpm: null, rightRpm: null, heatsink: null, ambient: null,
    }
    let load = 0
    for (const side of SIDES) {
      const target = targetAt(side, t)
      const on = target !== null
      if (on && !powered[side] && t >= from * 1000) powerOn.push({ side, at: t })
      powered[side] = on
      const goal = target ?? AMBIENT_F + 2
      // Water-driven sides move fast; an unpowered bed drifts back to the room slowly.
      bed[side] += (goal - bed[side]) * (1 - Math.exp(-step / (on ? 20 * MINUTE : 60 * MINUTE)))
      const jitter = randomBetween(rand, -0.15, 0.15)
      const bedF = Math.round((bed[side] + jitter) * 10) / 10
      const water = on ? Math.round((bedF + (goal - bedF) * 0.6) * 10) / 10 : Math.round((AMBIENT_F + 1 + jitter) * 10) / 10
      const surface = Math.round((bedF * 0.65 + AMBIENT_F * 0.35 + jitter) * 10) / 10
      const rpm = on ? Math.round(2400 + randomBetween(rand, -50, 50)) : 0
      if (on) load += Math.abs(goal - bedF)
      Object.assign(p, side === 'left'
        ? { leftBed: on ? bedF : null, leftTarget: target, leftWater: water, leftSurface: surface, leftRpm: rpm }
        : { rightBed: on ? bedF : null, rightTarget: target, rightWater: water, rightSurface: surface, rightRpm: rpm })
    }
    p.heatsink = Math.round((78 + load * 0.9 + randomBetween(rand, -0.3, 0.3)) * 10) / 10
    p.ambient = Math.round((AMBIENT_F + Math.sin((t / DAY) * 2 * Math.PI) * 0.8 + randomBetween(rand, -0.1, 0.1)) * 10) / 10
    if (t >= from * 1000) points.push(p)
  }

  return {
    range,
    from: from * 1000,
    to: now,
    bucketSec,
    points,
    powerOn,
    available: { bedTarget: true, water: true, surface: true, pump: true, hub: true },
    bedTargetSince: now - 64 * DAY,
  }
}

function thermalNow(): RouterOutputs['health']['thermal'] {
  const status = getDemoDeviceStatus('F')
  return {
    pumpStallProtectionEnabled: true,
    heatsinkTempF: 83.4,
    ambientTempF: AMBIENT_F,
    sides: SIDES.map((side) => {
      const s = side === 'left' ? status.leftSide : status.rightSide
      const on = s.targetTemperature !== null
      const gap = s.targetTemperature !== null && s.currentTemperature !== null ? s.targetTemperature - s.currentTemperature : 0
      return {
        side,
        isPowered: on,
        targetTempF: s.targetTemperature,
        currentTempF: s.currentTemperature,
        isAlarmVibrating: !!s.isAlarmVibrating,
        poweredOnAt: on ? new Date(sessionStart).toISOString() : null,
        pumpRpm: on ? 2402 : 0,
        flowrate: on ? 28.7 : null,
        readingAgeSec: 23,
        waterTempF: on && s.currentTemperature !== null ? Math.round((s.currentTemperature + gap * 0.6) * 10) / 10 : null,
        bedSurfaceTempF: s.currentTemperature !== null ? Math.round((s.currentTemperature * 0.65 + AMBIENT_F * 0.35) * 10) / 10 : null,
        guardBlocked: false,
        verdict: !on ? 'off' : Math.abs(gap) > 1 ? 'delivering' : 'holding',
        note: !on ? null : Math.abs(gap) > 1 ? `Pump ${gap < 0 ? 'cooling' : 'heating'} toward ${s.targetTemperature}°F` : null,
      }
    }),
  }
}

// ── Data path ────────────────────────────────────────────────────────────────

const isNight = (t: number) => {
  const h = new Date(t).getHours()
  return h >= 23 || h < 7
}

function dataPath(): RouterOutputs['health']['dataPath'] {
  const now = Date.now()
  const occupied = isNight(now)
  const recent = (ms: number) => now - ms
  const thermal = thermalNow()
  const inputs: DataPathInputs = {
    now,
    units: { 'sleepypod-piezo-processor.service': true, 'sleepypod-sleep-detector.service': true, 'sleepypod-environment-monitor.service': true },
    frameTimes: { 'piezo-dual': recent(800), 'capSense2': recent(400), 'bedTemp2': recent(9_000), 'frzTemp': recent(9_000), 'frzTherm': recent(9_000) },
    sensorSource: 'nats',
    coreUptimeMs: now - DEMO_UPTIME_START,
    dacSocket: { ok: true, latencyMs: 3 },
    dacMonitor: { status: 'polling', lastPollAt: recent(1_200), pollIntervalMs: 2_000 },
    database: { ok: true, latencyMs: 0.4 },
    scheduler: { enabled: true, jobs: JOBS.length, healthy: true },
    occupied: { left: occupied, right: occupied },
    stillness: { left: { rows: occupied ? 118 : 0, maxScore: occupied ? 140 : 0 }, right: { rows: occupied ? 118 : 0, maxScore: occupied ? 160 : 0 } },
    lastVitalAt: { left: occupied ? recent(40_000) : recent(9 * HOUR), right: occupied ? recent(52_000) : recent(9 * HOUR) },
    lastMovementAt: { left: occupied ? recent(30_000) : recent(9 * HOUR), right: occupied ? recent(30_000) : recent(9 * HOUR) },
    lastEnvAt: recent(35_000),
    thermal: thermal.sides.map(s => ({ side: s.side, verdict: s.verdict })),
    streamClients: 1,
    streamPort: 3001,
  }
  return evaluateDataPath(inputs)
}

function history(): History {
  const now = Date.now()
  const from = now - DAY
  // A short environment-monitor stall this morning, recovered on its own.
  const incidentStart = Math.floor((now - 7 * HOUR) / MINUTE) * MINUTE
  const incidentEnd = incidentStart + 12 * MINUTE

  const nightRuns = (): History['checks'][number]['runs'] => {
    const runs: History['checks'][number]['runs'] = []
    let start = from
    let night = isNight(from)
    for (let t = from + MINUTE; t <= now; t += MINUTE) {
      if (isNight(t) !== night || t === now) {
        runs.push({ status: night ? 'ok' : 'idle', start, end: t })
        start = t
        night = isNight(t)
      }
    }
    if (start < now) runs.push({ status: night ? 'ok' : 'idle', start, end: now })
    return runs
  }

  const checks = NODES.map((n) => {
    const id: NodeId = n.id
    let runs: History['checks'][number]['runs']
    if (id === 'environment-monitor') {
      runs = [
        { status: 'ok', start: from, end: incidentStart },
        { status: 'stale', start: incidentStart, end: incidentEnd },
        { status: 'ok', start: incidentEnd, end: now },
      ]
    }
    else if (id === 'piezo-processor' || id === 'sleep-detector' || id === 'out-vitals' || id === 'out-sleep') {
      runs = nightRuns()
    }
    else {
      runs = [{ status: 'ok', start: from, end: now }]
    }
    const total = runs.reduce((s, r) => s + (r.end - r.start), 0)
    const healthy = runs.filter(r => r.status === 'ok' || r.status === 'idle').reduce((s, r) => s + (r.end - r.start), 0)
    return { id, label: n.label, runs, healthyShare: total > 0 ? healthy / total : null, incidents: id === 'environment-monitor' ? 1 : 0 }
  })

  return {
    from,
    to: now,
    recordedSince: from,
    checks,
    incidents: [{ checkId: 'environment-monitor', label: 'Environment monitor', status: 'stale', start: incidentStart, end: incidentEnd, detail: 'No bed_temp rows for 12m' }],
    gaps: [],
  }
}

export const health: DemoHandlers<'health'> = {
  performance: () => {
    const rand = seededRandom(hashSeed(`perf:${Math.floor(Date.now() / 10_000)}`))
    return {
      uptimeSeconds: Math.floor((Date.now() - DEMO_UPTIME_START) / 1000),
      rssBytes: Math.round(randomBetween(rand, 176, 192) * 1024 * 1024),
      memory: {
        heapTotalBytes: Math.round(randomBetween(rand, 92, 98) * 1024 * 1024),
        heapUsedBytes: Math.round(randomBetween(rand, 74, 82) * 1024 * 1024),
        externalBytes: Math.round(randomBetween(rand, 6, 8) * 1024 * 1024),
        arrayBuffersBytes: Math.round(randomBetween(rand, 0.5, 1) * 1024 * 1024),
      },
      startup: [
        { name: 'migrations', elapsedMs: 412, durationMs: 388 },
        { name: 'migrations-ready', elapsedMs: 431, durationMs: 19 },
        { name: 'http-initialization-ready', elapsedMs: 1210, durationMs: 779 },
        { name: 'hardware-services-started', elapsedMs: 1846, durationMs: 636 },
        { name: 'mqtt-started', elapsedMs: 1902, durationMs: 56 },
        { name: 'scheduler-ready', elapsedMs: 2390, durationMs: 488 },
        { name: 'first-sensor-frame', elapsedMs: 3124, durationMs: 734 },
      ],
      sensorSource: 'nats',
      firstFrameMs: 3124,
      eventLoop: { meanMs: Math.round(randomBetween(rand, 0.6, 1.4) * 10) / 10, p95Ms: Math.round(randomBetween(rand, 3, 6) * 10) / 10, maxMs: Math.round(randomBetween(rand, 18, 42)) },
    }
  },

  scheduler: (input) => {
    const count = (type: string) => JOBS.filter(j => j.type === type).length
    const now = Date.now()
    const upcoming = JOBS
      .map(j => ({ job: j, at: nextRun(j) }))
      .filter((x): x is { job: Job, at: number } => x.at !== null)
      .filter(x => input.withinHours == null || x.at <= now + input.withinHours * HOUR)
      .sort((a, b) => a.at - b.at)
      .slice(0, input.withinHours == null ? 10 : 200)
    return {
      enabled: true,
      jobCounts: {
        temperature: count('temperature'),
        powerOn: count('power_on'),
        powerOff: count('power_off'),
        alarm: count('alarm'),
        prime: count('prime'),
        reboot: 0,
        total: JOBS.length,
      },
      upcomingJobs: upcoming.map(({ job, at }) => ({
        id: job.id,
        type: job.type,
        ...(job.side && { side: job.side }),
        nextRun: new Date(at).toISOString(),
        targetTempF: job.targetTempF,
        brightness: job.brightness,
      })),
      healthy: true,
    }
  },

  schedulerTimeline: (input) => {
    const now = Date.now()
    const occurrences: Occurrence[] = JOBS
      .flatMap(job => firings(job, now - DAY, now + (input.days ?? 8) * DAY).map(at => ({
        id: job.id,
        type: job.type,
        ...(job.side && { side: job.side }),
        at,
        targetTempF: job.targetTempF,
        brightness: job.brightness,
      })))
      .sort((a, b) => a.at - b.at)
    return {
      enabled: true,
      timezone: TIMEZONE,
      now,
      jobs: JOBS.map(job => ({
        id: job.id,
        type: job.type,
        ...(job.side && { side: job.side }),
        schedule: job.schedule,
        oneTime: false,
        nextRun: nextRun(job),
        targetTempF: job.targetTempF,
        brightness: job.brightness,
      })),
      occurrences,
    }
  },

  system: () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: {
      status: 'ok',
      latencyMs: 0.4,
      integrity: { status: 'ok', checkedAt: new Date(Math.floor(Date.now() / HOUR) * HOUR).toISOString(), latencyMs: 41 },
    },
    scheduler: {
      enabled: true,
      jobCount: JOBS.length,
      drift: { dbScheduleCount: 11, schedulerJobCount: 11, drifted: false },
    },
    iptables: { ok: true, missing: [] },
  }),

  dacMonitor: () => ({ status: 'polling', podVersion: 'J00', gesturesSupported: true }),

  hardware: () => ({ status: 'ok', socketPath: '/persistent/deviceinfo/dac.sock', latencyMs: 2.8 }),

  thermal: () => thermalNow(),

  dataPath: () => dataPath(),

  history: () => history(),

  restartService: input => ({ ok: true, message: `Restarted ${input.unit}` }),

  maintenance: () => {
    const today = new Date()
    today.setHours(14, 0, 0, 0)
    const lastPrime = today.getTime() <= Date.now() ? today.getTime() + 6 * MINUTE : today.getTime() - DAY + 6 * MINUTE
    return {
      pumpStallProtectionEnabled: true,
      primePodDaily: true,
      primePodTime: PRIME_TIME,
      lastPrimeAt: lastPrime,
      firstPrimeRecordedAt: Date.now() - 64 * DAY,
    }
  },

  thermalHistory: input => thermalHistory(input.range ?? '12h'),
}

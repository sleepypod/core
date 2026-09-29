import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { and, eq, gte, max, sql } from 'drizzle-orm'
import { sqlite, biometricsDb } from '@/src/db'
import { bedTemp, freezerTemp, movement, vitals } from '@/src/db/biometrics-schema'
import { getDatabaseIntegrity } from '@/src/db/integrity'
import { getJobManager } from '@/src/scheduler'
import { getSharedHardwareClient, getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { getSensorFrameTimes, getStreamClientCount, getStreamPort } from '@/src/streaming/piezoStream'
import { getServerPerformance } from '@/src/lib/serverPerformance'
import { getOccupancy } from '@/src/lib/occupancy'
import { readThermalTruth } from '@/src/lib/thermalTruth'
import { evaluateDataPath, RESTARTABLE_UNITS, STILL_WINDOW_MS, type DataPathInputs, type DataPathState, type RestartableUnit, type Side } from '@/src/lib/dataPath'

const execFileAsync = promisify(execFile)
const SIDES: Side[] = ['left', 'right']

/** true/false from `systemctl is-active`; null when systemctl itself is missing (dev). */
async function unitActive(unit: string): Promise<boolean | null> {
  try {
    await execFileAsync('systemctl', ['is-active', '--quiet', unit], { timeout: 3000 })
    return true
  }
  catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : false
  }
}

function toMs(d: Date | null | undefined): number | null {
  return d ? d.getTime() : null
}

/** Newest row per side, via the (side, timestamp) indexes — no scans. */
function lastPerSide(table: typeof vitals | typeof movement): Record<Side, number | null> {
  const out = { left: null, right: null } as Record<Side, number | null>
  for (const side of SIDES) {
    const [row] = biometricsDb.select({ at: max(table.timestamp) }).from(table).where(eq(table.side, side)).all()
    out[side] = toMs(row?.at)
  }
  return out
}

/** Movement rows and top score per side, over the stillness window. */
function stillnessPerSide(now: number): DataPathInputs['stillness'] {
  const since = new Date(now - STILL_WINDOW_MS)
  const out = {} as DataPathInputs['stillness']
  for (const side of SIDES) {
    const [w] = biometricsDb
      .select({ rows: sql<number>`count(*)`, top: max(movement.totalMovement) })
      .from(movement)
      .where(and(eq(movement.side, side), gte(movement.timestamp, since)))
      .all()
    out[side] = { rows: Number(w?.rows ?? 0), maxScore: w?.top ?? 0 }
  }
  return out
}

async function collect(now: number): Promise<DataPathInputs> {
  const units = Object.fromEntries(
    await Promise.all(RESTARTABLE_UNITS.map(async u => [u, await unitActive(u)] as const)),
  ) as Record<RestartableUnit, boolean | null>

  let dacSocket: DataPathInputs['dacSocket']
  try {
    const start = performance.now()
    await getSharedHardwareClient().connect()
    dacSocket = { ok: true, latencyMs: performance.now() - start }
  }
  catch (err) {
    dacSocket = { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) }
  }

  const monitor = getDacMonitorIfRunning()

  let database: DataPathInputs['database']
  try {
    const start = performance.now()
    sqlite.prepare('SELECT 1').get()
    const integrity = getDatabaseIntegrity()
    database = integrity.status === 'degraded'
      ? { ok: false, latencyMs: 0, error: integrity.error ?? 'integrity check failed' }
      : { ok: true, latencyMs: performance.now() - start }
  }
  catch (err) {
    database = { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) }
  }

  let scheduler: DataPathInputs['scheduler'] = { enabled: false, jobs: 0, healthy: false }
  try {
    const s = (await getJobManager()).getScheduler()
    const jobs = s.getJobs().length
    const enabled = s.isEnabled()
    scheduler = { enabled, jobs, healthy: enabled ? jobs > 0 : true }
  }
  catch { /* reported as unhealthy */ }

  const [bed] = biometricsDb.select({ at: max(bedTemp.timestamp) }).from(bedTemp).all()
  const [frz] = biometricsDb.select({ at: max(freezerTemp.timestamp) }).from(freezerTemp).all()
  const envTimes = [toMs(bed?.at), toMs(frz?.at)].filter((t): t is number => t != null)

  let thermal: DataPathInputs['thermal'] = []
  try {
    thermal = readThermalTruth().sides.map(s => ({ side: s.side, verdict: s.verdict }))
  }
  catch { /* no device state yet */ }

  return {
    now,
    units,
    frameTimes: getSensorFrameTimes(),
    sensorSource: getServerPerformance().sensorSource,
    coreUptimeMs: process.uptime() * 1000,
    dacSocket,
    dacMonitor: { status: monitor ? monitor.getStatus() : 'not_initialized', lastPollAt: monitor?.getLastPollAt() ?? null, pollIntervalMs: monitor?.getPollIntervalMs() ?? null },
    database,
    scheduler,
    occupied: { left: getOccupancy('left').occupied, right: getOccupancy('right').occupied },
    stillness: stillnessPerSide(now),
    lastVitalAt: lastPerSide(vitals),
    lastMovementAt: lastPerSide(movement),
    lastEnvAt: envTimes.length ? Math.max(...envTimes) : null,
    thermal,
    streamClients: getStreamClientCount(),
    streamPort: getStreamPort(),
  }
}

// Several open Health tabs plus the sampler shouldn't each shell out to
// systemctl; one evaluation serves everyone for a few seconds.
const CACHE_MS = 4000
let cached: { at: number, value: Promise<DataPathState> } | null = null

export function getDataPath(now = Date.now()): Promise<DataPathState> {
  if (cached && now - cached.at < CACHE_MS) return cached.value
  const value = collect(now).then(evaluateDataPath)
  cached = { at: now, value }
  value.catch(() => {
    if (cached?.value === value) cached = null
  })
  return value
}

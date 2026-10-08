import type { Statement } from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { db, sqlite } from '@/src/db'
import { deviceState, temperatureHolds } from '@/src/db/schema'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { markSideMutated } from '@/src/hardware/deviceStateSync'
import { hasFirmwareSynced } from '@/src/hardware/sideMutations'
import { shouldBlock } from '@/src/hardware/pumpStallGuard'
import { withSideLock } from '@/src/hardware/sideLock'
import { fahrenheitToLevel, MAX_TEMP, MIN_TEMP, type Side } from '@/src/hardware/types'
import { activeSleeperSides, scheduleSourceSide, type BedConfiguration } from '@/src/lib/singleSleeper'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'
import { alarmTemperatureTargets, recurringTarget, sessionTarget, type AlarmOccurrenceCache, type RecurringOccurrenceCache, type WeeklyTarget } from './baseline'
import { TemperatureController, type TemperatureRequest } from './controller'

const invalidSessions: Record<Side, Map<number, string>> = { left: new Map(), right: new Map() }

const occurrenceCaches: Record<Side, RecurringOccurrenceCache> = { left: new Map(), right: new Map() }
const alarmCaches: Record<Side, AlarmOccurrenceCache> = { left: new Map(), right: new Map() }

const recurringCache: Partial<Record<Side, { key: string, target: TemperatureRequest | null }>> = {}

/**
 * The controller's hot reads run as prepared SQLite statements. `status()`
 * is evaluated for both sides on every `device.getStatus`, every 1 Hz status
 * broadcast and every 1 Hz reconcile tick; building these queries through
 * the ORM each time cost ~16 ms per side on the pod, the raw statements take
 * about 1 ms for all of them. Statements are cached per connection so a
 * test that reopens the database gets fresh ones.
 */
const statementState = globalThis as typeof globalThis & {
  __sp_temperatureStatements?: WeakMap<object, Map<string, Statement>>
}
const statementCache = statementState.__sp_temperatureStatements ??= new WeakMap<object, Map<string, Statement>>()
function statement(sql: string): Statement {
  let cache = statementCache.get(sqlite)
  if (!cache) {
    cache = new Map()
    statementCache.set(sqlite, cache)
  }
  let prepared = cache.get(sql)
  if (!prepared) {
    prepared = sqlite.prepare(sql)
    cache.set(sql, prepared)
  }
  return prepared
}

interface WeeklyRow { id: number, dayOfWeek: WeeklyTarget['dayOfWeek'], time: string, temperature: number }
interface SessionRow { id: number, setPoints: string, startedAt: number, expiresAt: number }

function readBaseline(side: Side, now: number): TemperatureRequest[] {
  const settings = statement('select timezone, bed_mode as bedMode, unused_zone_mode as unusedZoneMode from device_settings').get() as ({ timezone: string | null } & BedConfiguration) | undefined
  const timezone = settings?.timezone || 'America/Los_Angeles'
  const away = Object.fromEntries((statement('select side, away_mode as awayMode from side_settings').all() as { side: Side, awayMode: number }[])
    .map(r => [r.side, { awayMode: r.awayMode }]))
  const modes = { ...away, ...settings }
  const source = scheduleSourceSide(side, modes)
  const requests: TemperatureRequest[] = []
  if (source) {
    const alarms = statement('select id, day_of_week as dayOfWeek, time, alarm_temperature as temperature, wake_window as wakeWindow, duration from alarm_schedules where side = ? and enabled = 1').all(source) as (WeeklyRow & { wakeWindow: number, duration: number })[]
    const temps = statement('select id, day_of_week as dayOfWeek, time, temperature from temperature_schedules where side = ? and enabled = 1').all(source) as WeeklyRow[]
    const powers = statement('select id, day_of_week as dayOfWeek, on_time as time, on_temperature as temperature from power_schedules where side = ? and enabled = 1').all(source) as WeeklyRow[]
    // Alarm temperatures have their own bounded warm-up/hold spans.
    const rows: WeeklyTarget[] = [
      ...temps.map(r => ({ id: `temperature:${r.id}`, dayOfWeek: r.dayOfWeek, time: r.time, temperature: r.temperature })),
      ...powers.map(r => ({ id: `power:${r.id}`, dayOfWeek: r.dayOfWeek, time: r.time, temperature: r.temperature })),
    ]
    const key = JSON.stringify([timezone, Math.floor(now / 60_000), rows])
    const cached = recurringCache[side]
    const baseline = cached?.key === key ? cached.target : recurringTarget(rows, timezone, now, occurrenceCaches[side])
    recurringCache[side] = { key, target: baseline }
    if (baseline) requests.push(baseline)
    requests.push(...alarmTemperatureTargets(
      (activeSleeperSides(modes).includes(source) ? alarms : []).map(r => ({ id: `alarm:${r.id}`, dayOfWeek: r.dayOfWeek, time: r.time, temperature: r.temperature, wakeWindow: r.wakeWindow, duration: r.duration })),
      timezone, now, alarmCaches[side],
    ))
  }
  // run_once_sessions timestamps are drizzle `timestamp` columns: unix seconds.
  const sessions = (statement('select id, set_points as setPoints, started_at as startedAt, expires_at as expiresAt from run_once_sessions where side = ? and status = \'active\'').all(side) as SessionRow[])
    .map(row => ({ id: row.id, setPoints: row.setPoints, startedAt: new Date(row.startedAt * 1000), expiresAt: new Date(row.expiresAt * 1000) }))
  const activeIds = new Set(sessions.map(session => session.id))
  for (const id of invalidSessions[side].keys()) {
    if (!activeIds.has(id)) invalidSessions[side].delete(id)
  }
  for (const session of sessions) {
    try {
      const setPoints: unknown = JSON.parse(session.setPoints)
      if (!Array.isArray(setPoints) || setPoints.some(p => typeof p?.time !== 'string'
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time) || !Number.isFinite(p?.temperature)
        || p.temperature < MIN_TEMP || p.temperature > MAX_TEMP)) {
        throw new Error('Invalid set points')
      }
      const target = sessionTarget({ ...session, setPoints }, timezone, now)
      if (target) requests.push(target)
      invalidSessions[side].delete(session.id)
    }
    catch (error) {
      // Corrupt legacy rows must not break manual commands or status for either
      // side. Warn once per bad payload; a corrected row is retried immediately.
      if (invalidSessions[side].get(session.id) !== session.setPoints) {
        console.warn(`[temperature] ignoring invalid run-once session ${session.id}:`, error)
        invalidSessions[side].set(session.id, session.setPoints)
      }
    }
  }
  return requests
}

const globalState = globalThis as typeof globalThis & {
  __sp_temperatureController?: TemperatureController
  __sp_temperatureService?: {
    running: boolean
    timer?: ReturnType<typeof setInterval>
    pending: Set<Promise<void>>
  }
}

export function getTemperatureController(): TemperatureController {
  if (!globalState.__sp_temperatureController) {
    globalState.__sp_temperatureController = new TemperatureController({
      now: Date.now,
      withSideLock,
      readHold: (side) => {
        const row = statement('select temperature, started_at as startedAt, expires_at as expiresAt from temperature_holds where side = ?').get(side) as { temperature: number, startedAt: number, expiresAt: number } | undefined
        return row
          ? {
              id: 'manual', source: 'manual', temperature: row.temperature,
              startsAt: row.startedAt, expiresAt: row.expiresAt, createdAt: row.startedAt, priority: 0,
            }
          : null
      },
      writeHold: (side, hold) => {
        if (!hold) {
          db.delete(temperatureHolds).where(eq(temperatureHolds.side, side)).run()
          return
        }
        const values = { side, temperature: hold.temperature, startedAt: hold.startsAt, expiresAt: hold.expiresAt }
        db.insert(temperatureHolds).values(values).onConflictDoUpdate({ target: temperatureHolds.side, set: values }).run()
      },
      readBaseline,
      // A device_state row left over from before a restart is not evidence of
      // a live session until the firmware has reported in. Gating here covers
      // every reconcile path (the automation engine's startup tick, scheduler
      // temperature jobs, resume/submit/withdraw), not just the passive loop:
      // on Pod 88 the engine's first tick read a stale is_powered=1 row and
      // energized a side the moment frank connected. Explicit power-on and
      // manual commands do not consult this.
      isPowered: side => hasFirmwareSynced()
        && Boolean((statement('select is_powered as isPowered from device_state where side = ?').get(side) as { isPowered: number } | undefined)?.isPowered),
      readCurrentTarget: side => db.select().from(deviceState).where(eq(deviceState.side, side)).get()?.targetTemperature ?? null,
      readHardwareDeadline: side => db.select({ deadline: deviceState.hardwareDeadline }).from(deviceState).where(eq(deviceState.side, side)).get()?.deadline ?? null,
      writeHardwareDeadline: (side, hardwareDeadline) => {
        db.insert(deviceState).values({ side, hardwareDeadline }).onConflictDoUpdate({ target: deviceState.side, set: { hardwareDeadline } }).run()
      },
      isBlocked: shouldBlock,
      connect: () => getSharedHardwareClient().connect(),
      apply: async (side, temperature, durationSec) => {
        markSideMutated(side)
        if (durationSec === undefined) await getSharedHardwareClient().setTemperature(side, temperature)
        else await getSharedHardwareClient().setTemperature(side, temperature, durationSec)
        const previous = db.select().from(deviceState).where(eq(deviceState.side, side)).get()
        markSideMutated(side)
        const values = {
          side, targetTemperature: temperature, isPowered: true,
          poweredOnAt: previous?.isPowered ? previous.poweredOnAt : new Date(),
          lastUpdated: new Date(),
        }
        db.insert(deviceState).values(values).onConflictDoUpdate({ target: deviceState.side, set: values }).run()
        broadcastMutationStatus(side, { targetTemperature: temperature, targetLevel: fahrenheitToLevel(temperature) })
      },
      powerOff: async (side) => {
        // Hardware shutdown is always attempted, including when the DB is unavailable.
        markSideMutated(side)
        try {
          db.update(deviceState).set({
            isPowered: false, targetTemperature: null, poweredOnAt: null, lastUpdated: new Date(),
          }).where(eq(deviceState.side, side)).run()
        }
        finally {
          await getSharedHardwareClient().connect()
          await getSharedHardwareClient().setPower(side, false)
          broadcastMutationStatus(side, { targetLevel: 0 })
        }
      },
      publish: () => broadcastMutationStatus(),
    })
  }
  return globalState.__sp_temperatureController
}

export function getTemperatureControlStatus() {
  const controller = globalState.__sp_temperatureController
  return controller ? { left: controller.status('left'), right: controller.status('right') } : undefined
}

export function getTemperatureControllerIfRunning(): TemperatureController | undefined {
  return globalState.__sp_temperatureController
}

/** Start after migrations/state restoration. The non-overlapping loop also retries failed writes. */
export async function startTemperatureController(): Promise<void> {
  if (globalState.__sp_temperatureService?.running) return
  if (globalState.__sp_temperatureService) {
    await stopTemperatureController()
    return startTemperatureController()
  }
  const service = { running: true, pending: new Set<Promise<void>>(), timer: undefined as ReturnType<typeof setInterval> | undefined }
  globalState.__sp_temperatureService = service
  const ticking = new Set<Side>()
  let waitingLogged = false
  const tick = () => {
    // device_state is only trustworthy once the firmware has reported in
    // since this process started; before that a stale is_powered row would
    // make reconcile energize a side nobody asked for. Explicit commands
    // (power-on, manual, scheduler) don't pass through here and are unaffected.
    if (!hasFirmwareSynced()) {
      if (!waitingLogged) {
        console.log('[temperature] waiting for first firmware status before reconciling')
        waitingLogged = true
      }
      return Promise.all([...service.pending])
    }
    for (const side of ['left', 'right'] as const) {
      if (!service.running || ticking.has(side)) continue
      ticking.add(side)
      const work = getTemperatureController().reconcile(side, false, () => service.running)
        .then(() => {}, (error) => {
          console.warn(`[temperature] ${side} reconciliation failed:`, error)
        }).finally(() => {
          ticking.delete(side)
          service.pending.delete(work)
        })
      service.pending.add(work)
    }
    return Promise.all([...service.pending])
  }
  service.timer = setInterval(() => {
    void tick()
  }, 1_000)
  service.timer.unref()
  await tick()
}

/** Cancel queued writes and drain admitted work before hardware/database teardown. */
export async function stopTemperatureController(): Promise<void> {
  const service = globalState.__sp_temperatureService
  if (!service) return
  service.running = false
  clearInterval(service.timer)
  await Promise.all([...service.pending])
  if (globalState.__sp_temperatureService === service) globalState.__sp_temperatureService = undefined
}

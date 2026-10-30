import { ComfortApplicationAdapter } from './application'
import { createComfortOwner } from './owner'
import { readComfortHardwareIdentity } from './hardware-identity'
import { ownerIdentitySchema } from './owner-contract'
import { createPreviewReports } from './reports'
import { readFileSync } from 'node:fs'
import type { PreviewOrigin } from './report-evidence'
import { and, eq } from 'drizzle-orm'
import { biometricsDb, db, sqlite } from '@/src/db'
import { alarmSchedules, deviceSettings, deviceState, powerSchedules, sideSettings, temperatureSchedules } from '@/src/db/schema'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { getBaseControllerIfRunning } from '@/src/hardware/base/instance'
import { hasFirmwareSynced } from '@/src/hardware/sideMutations'
import { withSideLock } from '@/src/hardware/sideLock'
import type { Side } from '@/src/hardware/types'
import { getOccupancy } from '@/src/lib/occupancy'
import { scheduleSourceSide } from '@/src/lib/singleSleeper'
import { readSleeperPresence } from '@/src/lib/sleeperPresence'
import { getTemperatureControllerIfRunning } from '@/src/temperature/instance'
import { readAlarmContext } from '@/src/alarms/store'
import { effectiveAlarmTargets, validAlarmOverride } from '@/src/alarms/model'
import { DEVICE_MAX_AGE_MS, type ComfortContext, type ComfortState, type RoutineWindow } from './policy'
import { acknowledgeManualPause, pendingManualPause } from './manual'
import { comfortRoutineAt, comfortScheduleRevision } from './routines'
import { ComfortRuntime } from './runtime'
import { createComfortStore } from './store'
import { ComfortSignalReader } from './signal-reader'
import { getBedroom } from '@/src/bedroom/instance'
import { thermalContextSchema } from './thermal-learning'

const globals = globalThis as typeof globalThis & { __sp_comfortRuntime?: ComfortRuntime, __sp_comfortSignals?: ComfortSignalReader, __sp_comfortOwner?: ReturnType<typeof createComfortOwner>, __sp_comfortApplication?: ComfortApplicationAdapter }
function signalsReader() {
  return globals.__sp_comfortSignals ??= new ComfortSignalReader(biometricsDb.$client)
}

const routineCache: Partial<Record<Side, { key: string, window: RoutineWindow | null }>> = {}

function observedTimestamp(value: number | null | undefined, now: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= now ? value : null
}

function readComfortSchedules(side: Side) {
  const settings = db.select().from(deviceSettings).get()
  if (!settings) throw new Error('Device settings unavailable')
  const sides = db.select().from(sideSettings).all()
  const source = scheduleSourceSide(side, { ...settings, ...Object.fromEntries(sides.map(row => [row.side, row])) })
  const powers = source ? db.select().from(powerSchedules).where(and(eq(powerSchedules.side, source), eq(powerSchedules.enabled, true))).all() : []
  const targets = source ? db.select().from(temperatureSchedules).where(and(eq(temperatureSchedules.side, source), eq(temperatureSchedules.enabled, true))).all() : []
  const alarms = source ? db.select().from(alarmSchedules).where(and(eq(alarmSchedules.side, source), eq(alarmSchedules.enabled, true))).all() : []
  const timezone = settings.timezone
  const schedules = { powers, targets, alarms, timezone, source: JSON.stringify([source, settings.bedMode, settings.unusedZoneMode]) }
  return { settings, sides, source, timezone, schedules }
}

/** Read existing sensors and arbitration only; status evaluation never opens a hardware connection. */
export function readComfortContext(side: Side, state: ComfortState, now: number, includeArbitration = true): { context: ComfortContext, timezone: string } {
  const { settings, sides, source, timezone, schedules } = readComfortSchedules(side)
  const key = JSON.stringify([Math.floor(now / 60_000), schedules])
  const cached = routineCache[side]
  const window = cached?.key === key ? cached.window : comfortRoutineAt(schedules, now)
  routineCache[side] = { key, window }
  const control = includeArbitration ? getTemperatureControllerIfRunning()?.status(side) : undefined
  const monitor = getDacMonitorIfRunning()
  const status = monitor?.getFreshStatus(DEVICE_MAX_AGE_MS)
  const reported = side === 'left' ? status?.leftSide : status?.rightSide
  const deviceObservedAt = status ? observedTimestamp(monitor?.getLastPollAt(), now) : null
  const presence = readSleeperPresence(side, { ...settings, ...Object.fromEntries(sides.map(row => [row.side, row])) }, now, getOccupancy)
  const states = db.select().from(deviceState).all()
  const mirror = states.find(row => row.side === side)
  const base = getBaseControllerIfRunning()?.status()
  const baseFresh = base?.state === 'connected' && !base.stale && base.lastUpdate !== null
    && observedTimestamp(base.lastUpdate, now) !== null && now - base.lastUpdate <= 10_000
  const alarmContext = source ? readAlarmContext(sqlite, source) : null
  // The learner's weekly phases must not compete with a changed wake time on
  // the affected night. A skip next week does not suppress this week's Preview.
  const alarmChange = alarmContext ? validAlarmOverride(alarmContext, now) : null
  const affectedRoutine = alarmChange && window && [alarmChange.originalAt, alarmChange.at].some(at => at !== null && at >= window.start && at <= window.end)
  const alarmOverride = Boolean(affectedRoutine) || (alarmContext !== null && effectiveAlarmTargets(alarmContext, now).length > 0)
  const targetF = typeof reported?.targetTemperature === 'number' && Number.isFinite(reported.targetTemperature) ? reported.targetTemperature : null
  const room = state.config.roomAware ? getBedroom().status().aggregates : []
  const thermal = thermalContextSchema.safeParse({ targetF, waterF: reported?.currentTemperature,
    roomF: room.find(metric => metric.metric === 'temperature' && metric.status === 'ready')?.value,
    humidity: room.find(metric => metric.metric === 'humidity' && metric.status === 'ready')?.value })
  return {
    timezone,
    context: {
      now, window,
      device: {
        observedAt: deviceObservedAt, powered: hasFirmwareSynced() && mirror?.isPowered === true && (reported?.heatingDuration ?? 0) > 0,
        offConfirmed: hasFirmwareSynced() && mirror?.isPowered === false && reported?.heatingDuration === 0,
        waterAdequate: status?.waterLevel === 'ok' ? true : status?.waterLevel === 'low' ? false : null,
        priming: status?.isPriming !== false,
        vibrating: states.length !== 2 || states.some(row => row.isAlarmVibrating),
        baseMoving: baseFresh && typeof base?.moving === 'boolean' ? base.moving || base.busy : null,
        targetF,
      },
      presence,
      eitherAway: sides.length !== 2 || sides.some(row => row.awayMode),
      routinesPaused: source === null,
      alarmOverride,
      owner: control?.source ?? null,
      targetKnown: targetF !== null && (targetF === window?.baselineF || targetF === control?.targetTemperature
        || (state.lastSegment === window?.segment && state.lastTargetF === targetF && state.lastAppliedAt > 0 && state.lastAppliedAt <= now)),
      signals: state.config.sensorAware ? signalsReader().read(side, timezone, now) : undefined,
      bedroom: state.config.roomAware ? getBedroom().guidance() : undefined,
      thermalContext: thermal.success ? thermal.data : null,
    },
  }
}

function previewOrigin(): PreviewOrigin {
  let buildRevision: string | null = null
  try {
    const manifest: unknown = JSON.parse(readFileSync('.git-info', 'utf-8'))
    if (manifest && typeof manifest === 'object' && 'commitHash' in manifest
      && typeof manifest.commitHash === 'string' && /^[a-f0-9]{7,40}$/.test(manifest.commitHash)) buildRevision = manifest.commitHash
  }
  catch { /* Missing build identity stays visible in the report. */ }
  const environment = process.env.CI || process.env.NODE_ENV === 'test'
    ? 'test'
    : process.env.NODE_ENV === 'production' ? 'production' : 'development'
  return { environment, buildRevision, hardwareIdentity: readComfortHardwareIdentity() }
}

export function getComfortRuntime(): ComfortRuntime {
  return globals.__sp_comfortRuntime ??= new ComfortRuntime({
    now: Date.now, origin: previewOrigin(), store: createComfortStore(sqlite), withSideLock, readContext: readComfortContext,
    timezone: () => {
      const settings = db.select({ timezone: deviceSettings.timezone }).from(deviceSettings).get()
      if (!settings) throw new Error('Device timezone unavailable')
      return settings.timezone
    },
    prepareSignals: (side, now) => signalsReader().prepare(side, db.select().from(deviceSettings).get()?.timezone ?? 'UTC', now),
    pendingPause: pendingManualPause, acknowledgePause: acknowledgeManualPause,
    activation: {
      admitted: (side, state) => getComfortOwner().admission(side, state) !== null,
      revoke: (side, reason) => getComfortOwner().revoke(side, reason),
      revokeLease: side => globals.__sp_comfortApplication?.revoke(side),
      reconcile: async (side) => {
        if (createComfortStore(sqlite).read(side).config.mode === 'active' || globals.__sp_comfortApplication) await getComfortApplication()?.reconcile(side)
      },
    },
  })
}

export function getComfortRuntimeIfRunning(): ComfortRuntime | undefined {
  return globals.__sp_comfortRuntime
}
export async function startComfortPreview(): Promise<void> {
  await getComfortRuntime().start()
}
export async function stopComfortPreview(): Promise<void> {
  await globals.__sp_comfortRuntime?.stop()
}

/** Read/review endpoints do not start the Preview runtime or any hardware service. */
export function getPreviewReports() {
  return createPreviewReports(sqlite)
}

function autopilotEnabled(): boolean {
  return db.select({ enabled: deviceSettings.autopilotEnabled }).from(deviceSettings).get()?.enabled === true
}

/** These readers use existing services and never open a hardware connection. */
export function getComfortOwner() {
  return globals.__sp_comfortOwner ??= createComfortOwner({
    database: sqlite, store: createComfortStore(sqlite), now: Date.now, withSideLock, autopilotEnabled,
    running: () => globals.__sp_comfortRuntime?.isRunning() === true,
    revokeLease: side => globals.__sp_comfortApplication?.revoke(side),
    context: (side, state, now) => readComfortContext(side, state, now, false).context,
    identity: (side, state) => {
      const origin = previewOrigin()
      const { settings, sides, schedules } = readComfortSchedules(side)
      const calibration = readSleeperPresence(side, { ...settings, ...Object.fromEntries(sides.map(row => [row.side, row])) }, Date.now(), getOccupancy).entry?.sourceKey
      const schedule = comfortScheduleRevision(schedules)
      if (origin.environment !== 'production' || !origin.hardwareIdentity || !origin.buildRevision || !calibration || !schedule) return null
      return ownerIdentitySchema.parse({ hardware: origin.hardwareIdentity, build: origin.buildRevision, calibration, schedule,
        policy: { minimumF: state.config.minimumF, maximumF: state.config.maximumF,
          sensorAware: state.config.sensorAware === true, followBedtime: state.config.followBedtime === true, roomAware: state.config.roomAware === true },
        bedroomConfiguration: state.config.roomAware ? getBedroom().configurationDigest() : null })
    },
  })
}

function getComfortApplication(): ComfortApplicationAdapter | undefined {
  const authority = getTemperatureControllerIfRunning()
  if (!authority) return undefined
  return globals.__sp_comfortApplication ??= new ComfortApplicationAdapter({
    now: Date.now, monotonicNow: () => performance.now(), store: createComfortStore(sqlite), authority, withSideLock,
    autopilotEnabled, admission: (side, state) => getComfortOwner().admission(side, state), pendingPause: pendingManualPause,
    readContext: (side, state, now) => readComfortContext(side, state, now, false).context,
  })
}

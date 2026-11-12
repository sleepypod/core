import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { readOrCreateConnectionIdentity } from '@/src/connections/identity'
import { readAlarmContext } from '@/src/alarms/store'
import { createComfortLimitStore } from '@/src/temperature/limitStore'
import { createComfortStore } from '../store'
import { comfortScheduleRevision, type ComfortSchedules } from '../routines'
import { experimentContextSchema, type ExperimentContext } from './contract'

export interface ExperimentAccess {
  subjectKey: string
  scope: object
  binding: object
  routineSide: Side | null
  ready: boolean
}
export interface ExperimentAvailability { context: ExperimentContext | null, reason: string }

export function experimentDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Legacy owner records stay separate from personal accounts, including the same human's later account. */
export function legacyExperimentAccess(database: Database.Database): ExperimentAccess {
  const installationId = readOrCreateConnectionIdentity(database)
  const settings = database.prepare('SELECT bed_mode, unused_zone_mode FROM device_settings LIMIT 1').get() as {
    bed_mode: string
    unused_zone_mode: string
  } | undefined
  const routineSide = settings?.bed_mode === 'solo-left' ? 'left' : settings?.bed_mode === 'solo-right' ? 'right' : null
  const scope = { kind: 'legacy', installationId }
  return { subjectKey: experimentDigest(scope), scope, binding: { ...scope, settings }, routineSide,
    ready: routineSide !== null && settings?.unused_zone_mode === 'follow' }
}

/** Read persisted policies and routines in one snapshot. No sensor or hardware runtime is opened. */
export function readExperimentAvailability(database: Database.Database, access: ExperimentAccess): ExperimentAvailability {
  const side = access.routineSide
  if (!access.ready || !side)
    return { context: null, reason: 'Confirm your personal side, or the existing solo-anywhere arrangement, before planning a comparison.' }
  return database.transaction(() => {
    const alarm = readAlarmContext(database, side)
    if (!alarm.configured || !alarm.available)
      return { context: null, reason: 'Your routines are unavailable or paused while away.' }
    const limit = createComfortLimitStore(database).read(side)
    if (!limit.config.enabled)
      return { context: null, reason: 'Set an overnight comfort range before planning a comparison.' }
    const adaptive = createComfortStore(database).read(side).config
    const minimumF = Math.max(limit.config.minF, adaptive.minimumF)
    const maximumF = Math.min(limit.config.maxF, adaptive.maximumF)
    const powers = database.prepare(`SELECT id, day_of_week AS dayOfWeek, on_time AS onTime, off_time AS offTime,
      off_day_offset AS offDayOffset, end_action AS endAction, on_temperature AS onTemperature
      FROM power_schedules WHERE side = ? AND enabled = 1 ORDER BY id`).all(side) as ComfortSchedules['powers']
    const targets = database.prepare(`SELECT id, day_of_week AS dayOfWeek, time, temperature
      FROM temperature_schedules WHERE side = ? AND enabled = 1 ORDER BY id`).all(side) as ComfortSchedules['targets']
    const schedules: ComfortSchedules = { powers, targets, alarms: alarm.rows, timezone: alarm.timeZone, source: side }
    const revision = comfortScheduleRevision(schedules)
    const baselines = new Set([...powers.map(row => row.onTemperature), ...targets.map(row => row.temperature)])
    if (!revision || baselines.size !== 1)
      return { context: null, reason: 'A comparison needs one consistent scheduled overnight setting. Review your routine phases first; wake warming stays separate.' }
    const baselineF = [...baselines][0]
    if (baselineF < minimumF || baselineF > maximumF || minimumF === maximumF)
      return { context: null, reason: 'The overnight range must contain the scheduled setting and a nearby comparison setting.' }
    const policy = { minimumF: adaptive.minimumF, maximumF: adaptive.maximumF, sensorAware: adaptive.sensorAware,
      followBedtime: adaptive.followBedtime, roomAware: adaptive.roomAware }
    const context = experimentContextSchema.parse({ subjectKey: access.subjectKey,
      bindingHash: experimentDigest({ binding: access.binding, side, limit, policy }),
      routineHash: experimentDigest({ revision, powers, targets }),
      wakeHash: experimentDigest(alarm), timezone: alarm.timeZone, baselineF, minimumF, maximumF })
    return { context, reason: 'Review a nearby setting inside your existing overnight range. Saving a plan does not activate temperature adjustments.' }
  })()
}

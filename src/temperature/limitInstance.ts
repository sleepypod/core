import type Database from 'better-sqlite3'
import { sqlite } from '@/src/db'
import type { Side } from '@/src/hardware/types'
import { activeSleeperSides, scheduleSourceSide, type BedConfiguration } from '@/src/lib/singleSleeper'
import { readAlarmContext } from '@/src/alarms/store'
import { effectiveAlarmTargets } from '@/src/alarms/model'
import { alarmStore } from '@/src/alarms/instance'
import { alarmWarmupMinutes, type AlarmOccurrenceCache } from './baseline'
import type { TemperatureRequest } from './controller'
import { createComfortLimitStore, ComfortLimitConflict } from './limitStore'
import { resolveComfortLimit, type ComfortLimitConfig } from './limits'

const globals = globalThis as typeof globalThis & {
  __sp_comfortLimitStores?: WeakMap<Database.Database, ReturnType<typeof createComfortLimitStore>>
  __sp_comfortLimitStatements?: WeakMap<Database.Database, Map<string, Database.Statement>>
  __sp_comfortLimitAlarms?: Record<Side, AlarmOccurrenceCache>
}
function statement(query: string) {
  const caches = globals.__sp_comfortLimitStatements ??= new WeakMap()
  let cache = caches.get(sqlite)
  if (!cache) {
    cache = new Map()
    caches.set(sqlite, cache)
  }
  let prepared = cache.get(query)
  if (!prepared) {
    prepared = sqlite.prepare(query)
    cache.set(query, prepared)
  }
  return prepared
}
function store() {
  const stores = globals.__sp_comfortLimitStores ??= new WeakMap()
  let instance = stores.get(sqlite)
  if (!instance) {
    instance = createComfortLimitStore(sqlite)
    stores.set(sqlite, instance)
  }
  return instance
}

/** Follow the same source as the zone's schedule, including solo-anywhere mode. */
export function comfortLimitSource(side: Side) {
  const settings = statement('SELECT bed_mode AS bedMode, unused_zone_mode AS unusedZoneMode FROM device_settings').get() as BedConfiguration | undefined
  const rows = statement('SELECT side, away_mode AS awayMode FROM side_settings').all() as { side: Side, awayMode: number }[]
  const modes = { ...settings, ...Object.fromEntries(rows.map(row => [row.side, { awayMode: row.awayMode }])) }
  return { sourceSide: scheduleSourceSide(side, modes) ?? side, active: activeSleeperSides(modes) }
}

export function readComfortLimit(side: Side) {
  const { sourceSide } = comfortLimitSource(side)
  let wake = null, wakeAvailable = false
  try {
    const page = alarmStore().page(sourceSide, Date.now())
    wakeAvailable = true
    if (page.alarm) {
      const alarmAt = Date.parse(page.alarm.at)
      wake = { alarmAt, startsAt: alarmAt - alarmWarmupMinutes(page.alarm.wakeWindow) * 60_000,
        targetF: page.alarm.alarmTemperatureF, timeZone: page.timeZone }
    }
  }
  catch { /* A missing alarm is never permission to exceed the range. */ }
  return { apiVersion: 1 as const, side, sourceSide, ...store().read(sourceSide), wake, wakeAvailable }
}

export function saveComfortLimit(side: Side, expectedSourceSide: Side, expectedRevision: number, config: ComfortLimitConfig) {
  const { sourceSide } = comfortLimitSource(side)
  if (sourceSide !== expectedSourceSide) throw new ComfortLimitConflict('The sleeper arrangement changed. Refresh before saving.')
  store().save(sourceSide, expectedRevision, config)
  return readComfortLimit(side)
}

/** Only a currently enabled, persisted alarm span can exempt an automatic target. IDs alone confer no authority. */
export function resolvePersistedComfortLimit(side: Side, request: TemperatureRequest | null, requestedF: number, now: number) {
  try {
    const { sourceSide, active } = comfortLimitSource(side)
    const version = store().read(sourceSide)
    const alarmCaches = globals.__sp_comfortLimitAlarms ??= { left: new Map(), right: new Map() }
    const trustedWake = version.config.enabled && request?.source === 'schedule' && active.includes(sourceSide)
      && effectiveAlarmTargets(readAlarmContext(sqlite, sourceSide), now, alarmCaches[side]).some(target =>
        target.id === request.id && target.startsAt === request.startsAt && target.expiresAt === request.expiresAt
        && target.temperature === requestedF && target.createdAt === request.createdAt)
    return resolveComfortLimit(request, requestedF, version, Boolean(trustedWake))
  }
  catch { return resolveComfortLimit(request, requestedF, null, false) }
}

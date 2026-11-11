import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { sqlite } from '@/src/db'
import { getDacMonitorIfRunning, getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import type { Side } from '@/src/hardware/types'
import { scheduleSourceSide } from '@/src/lib/singleSleeper'
import { createAlarmStore, readAlarmContext } from '@/src/alarms/store'
import { effectiveAlarmTargets } from '@/src/alarms/model'
import { COOLING_SOURCE_MAX_AGE_MS, type CoolingContext, type CoolingPersistence } from './cooling'
import { createCoolingStore } from './coolingStore'

const queryGlobals = globalThis as typeof globalThis & { __sp_coolingQueries?: WeakMap<Database.Database, Map<string, Database.Statement>> }
function query(sql: string) {
  const connections = queryGlobals.__sp_coolingQueries ??= new WeakMap()
  let statements = connections.get(sqlite)
  if (!statements) {
    statements = new Map()
    connections.set(sqlite, statements)
  }
  let prepared = statements.get(sql)
  if (!prepared) {
    prepared = sqlite.prepare(sql)
    statements.set(sql, prepared)
  }
  return prepared
}

/** Preserve actual firmware countdowns and the same alarm source as normal arbitration. */
export function readCoolingContext(side: Side, now: number): CoolingContext {
  const settings = query('SELECT timezone,bed_mode AS bedMode,unused_zone_mode AS unusedZoneMode FROM device_settings LIMIT 1').get() as
    { timezone: string, bedMode: 'two' | 'solo-left' | 'solo-right', unusedZoneMode: 'follow' | 'off' | 'independent' } | undefined
  const sides = query('SELECT side,away_mode AS awayMode FROM side_settings ORDER BY side').all() as { side: Side, awayMode: number }[]
  const household = query('SELECT id,pod_id,assignment_revision,mode,source_side,effective_at FROM households ORDER BY id').all()
  const scope = createHash('sha256').update(JSON.stringify([side, settings, sides, household])).digest('hex')
  const source = scheduleSourceSide(side, { ...settings, ...Object.fromEntries(sides.map(row => [row.side, { awayMode: row.awayMode }])) })
  const monitor = getDacMonitorIfRunning()
  const observedAt = monitor?.getLastPollAt() ?? null
  // Our own two sequential DAC writes invalidate the mutation revision. Continue
  // checking the aged source during dispatch, while a new start needs a fresh revision.
  const status = monitor?.getLastStatus()
  const zone = status?.[side === 'left' ? 'leftSide' : 'rightSide']
  const duration = zone?.heatingDuration
  const sessionEndsAt = observedAt !== null && typeof duration === 'number' && Number.isSafeInteger(duration) && duration > 0 && duration <= 86_400
    ? observedAt + duration * 1_000
    : null
  let wakeStartsAt: number | null = null
  let wakeKnown = false
  if (settings?.timezone && source) {
    const context = readAlarmContext(sqlite, source)
    const active = effectiveAlarmTargets(context, now)
    const next = createAlarmStore(sqlite).page(source, now)
    wakeStartsAt = active.length ? now : next.warming ? Date.parse(next.warming.startsAt) : null
    wakeKnown = !next.alarm || next.state === 'skipped' || !!next.warming || !!next.execution
  }
  const connected = monitor?.getStatus() === 'running' && getSharedHardwareClient().isConnected()
  const available = Boolean(connected && status?.waterLevel === 'ok' && !status.isPriming && source && wakeKnown)
  return { scope, observedAt, available, readyToStart: Boolean(monitor?.getFreshStatus(COOLING_SOURCE_MAX_AGE_MS)), sessionEndsAt, wakeStartsAt,
    reason: !connected
      ? 'Waiting for a fresh Pod connection.'
      : status?.waterLevel !== 'ok'
        ? 'Check water before cooling.'
        : status.isPriming
          ? 'Wait for priming to finish.'
          : !wakeKnown
              ? 'Check the wake plan before temporary cooling.'
              : 'Cooling requires an active zone and ends before wake warming.' }
}

const globals = globalThis as typeof globalThis & { __sp_coolingStores?: WeakMap<Database.Database, CoolingPersistence> }
export function coolingPersistence(): CoolingPersistence {
  const stores = globals.__sp_coolingStores ??= new WeakMap()
  let value = stores.get(sqlite)
  if (!value) {
    value = { ...createCoolingStore(sqlite), context: readCoolingContext }
    stores.set(sqlite, value)
  }
  return value
}

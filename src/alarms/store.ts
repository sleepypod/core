import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { activeSleeperSides, type BedConfiguration } from '@/src/lib/singleSleeper'
import { NextAlarmError, nextAlarmSchema, nextAlarmWriteSchema, type NextAlarm, type NextAlarmWrite } from './contract'
import { alarmClock, alarmDigest, alarmHoldEnd, alarmPlan, alarmRowSchema, consistentAlarm, nextRoutineAlarm, occurrenceAt, overrideSchema,
  resolveAlarmClock, selectedAlarm, type AlarmContext, type AlarmExecution, type AlarmOccurrence, type AlarmOverride } from './model'

const globals = globalThis as typeof globalThis & { __sp_alarmStatements?: WeakMap<Database.Database, Map<string, Database.Statement>> }
const statementCaches = globals.__sp_alarmStatements ??= new WeakMap<Database.Database, Map<string, Database.Statement>>()
function statement(database: Database.Database, sql: string) {
  let cache = statementCaches.get(database)
  if (!cache) {
    cache = new Map()
    statementCaches.set(database, cache)
  }
  let prepared = cache.get(sql)
  if (!prepared) {
    prepared = database.prepare(sql)
    cache.set(sql, prepared)
  }
  return prepared
}

/** Prepared reads are also used by the 1 Hz temperature controller; no runtime is started. */
export function readAlarmContext(database: Database.Database, side: Side): AlarmContext {
  const settings = statement(database, 'SELECT timezone,bed_mode AS bedMode,unused_zone_mode AS unusedZoneMode FROM device_settings LIMIT 1').get() as ({ timezone: string } & BedConfiguration) | undefined
  if (!settings?.timezone) return { side, timeZone: 'UTC', configured: false, available: false, rows: [], revision: null, override: null }
  try {
    new Intl.DateTimeFormat('en', { timeZone: settings.timezone }).format(0)
  }
  catch { throw new NextAlarmError('The Pod time zone is unavailable.', 'PRECONDITION_FAILED') }
  const sides = statement(database, 'SELECT side,away_mode AS awayMode FROM side_settings').all() as { side: Side, awayMode: number }[]
  const modes = { ...settings, ...Object.fromEntries(sides.map(row => [row.side, { awayMode: !!row.awayMode }])) }
  const rows = statement(database, `SELECT id,side,day_of_week AS dayOfWeek,time,vibration_intensity AS vibrationIntensity,
    vibration_pattern AS vibrationPattern,duration,alarm_temperature AS alarmTemperature,wake_window AS wakeWindow,
    snooze_duration AS snoozeDuration,snooze_taper AS snoozeTaper FROM alarm_schedules WHERE side=? AND enabled=1 ORDER BY id`).all(side)
  const override = statement(database, 'SELECT revision,record FROM alarm_overrides WHERE side=?').get(side) as { revision: string, record: string | null } | undefined
  return { side, timeZone: settings.timezone, configured: true, available: activeSleeperSides(modes).includes(side),
    rows: rows.map(row => alarmRowSchema.parse(row)), revision: override?.revision ?? null,
    override: override?.record ? overrideSchema.parse(JSON.parse(override.record)) : null }
}

export function createAlarmStore(database: Database.Database) {
  const context = (side: Side) => readAlarmContext(database, side)
  const execution = (side: Side, occurrence: Pick<AlarmOccurrence, 'rows' | 'originalAt'>): AlarmExecution => {
    const states = occurrence.rows.map(row => (statement(database, 'SELECT outcome FROM alarm_occurrences WHERE side=? AND schedule_id=? AND original_at=?')
      .get(side, row.id, occurrence.originalAt) as { outcome: NonNullable<AlarmExecution> } | undefined)?.outcome)
    return states.includes('unknown') ? 'unknown' : states.includes('attempting') ? 'attempting' : states.includes('acknowledged') ? 'acknowledged' : null
  }
  const page = (side: Side, now: number): NextAlarm => {
    const current = context(side)
    if (!current.configured) throw new NextAlarmError('Set the Pod time zone before changing alarms.', 'PRECONDITION_FAILED')
    const selected = selectedAlarm(current, now)
    const status = selected ? execution(side, selected) : null
    const changed = current.override
    const change = changed
      ? { revision: current.revision, status: changed.expiresAt <= now ? 'expired' as const : changed.plan !== alarmPlan(current) ? 'invalidated' as const : 'active' as const,
          originalAt: new Date(changed.originalAt).toISOString(), at: changed.at === null ? null : new Date(changed.at).toISOString(), expiresAt: new Date(changed.expiresAt).toISOString() }
      : null
    const reason = !current.available
      ? 'This side is away or inactive.'
      : !selected
          ? 'No enabled alarm is scheduled.'
          : status
            ? 'This occurrence has already been attempted. Use the current alarm controls to stop or snooze it.'
            : selected.at <= now
              ? 'This occurrence has elapsed; it will not be replayed.'
              : !consistentAlarm(selected) ? 'Conflicting alarms share this wake time. Resolve them in Schedule before making a one-time change.' : ''
    const following = selected ? nextRoutineAlarm(current, Math.max(selected.at, selected.originalAt)) : null
    return nextAlarmSchema.parse({ apiVersion: 1, side, timeZone: current.timeZone,
      revision: alarmDigest([current, selected, status, change?.status]),
      state: !current.available ? 'away' : !selected ? 'none' : selected.skipped ? 'skipped' : 'scheduled',
      alarm: selected
        ? { scheduleIds: selected.rows.map(row => row.id), at: new Date(selected.at).toISOString(), originalAt: new Date(selected.originalAt).toISOString(),
            time: alarmClock(selected.at, current.timeZone), source: selected.source, duration: selected.rows[0].duration,
            wakeWindow: selected.rows[0].wakeWindow, alarmTemperatureF: selected.rows[0].alarmTemperature }
        : null,
      followingAt: following ? new Date(following.at).toISOString() : null,
      canChange: reason === '', reason, execution: status, acknowledgment: 'accepted_not_physically_verified', change })
  }
  const matches = (side: Side, candidate: AlarmOccurrence, now: number, early: boolean) => {
    const current = context(side)
    const live = occurrenceAt(current, candidate.originalAt, now)
    if (!current.available || !live || live.skipped || live.token !== candidate.token || live.at !== candidate.at) return false
    if (!candidate.rows.every(row => live.rows.some(saved => alarmDigest(saved) === alarmDigest(row)))) return false
    const earliest = live.at - (early ? candidate.rows[0].wakeWindow * 60_000 : 0)
    return now >= earliest && now <= live.at + 60_000
  }
  const eligible = (side: Side, candidate: AlarmOccurrence, now: number, early: boolean) => matches(side, candidate, now, early) && execution(side, candidate) === null
  return {
    context, execution, page, eligible,
    dispatchable: (side: Side, candidate: AlarmOccurrence, now: number, early: boolean) => matches(side, candidate, now, early) && execution(side, candidate) === 'attempting',
    write(request: NextAlarmWrite, now: number): NextAlarm {
      const input = nextAlarmWriteSchema.parse(request)
      return database.transaction(() => {
        const before = page(input.side, now)
        if (before.revision !== input.expectedRevision) throw new NextAlarmError('The next alarm changed. Refresh it before applying this change.', 'CONFLICT')
        const current = context(input.side)
        let record: AlarmOverride | null = null
        if (input.action === 'restore') {
          if (input.expectedAt !== undefined || input.time !== undefined || !input.expectedExpiresAt) throw new NextAlarmError('Restore requires only the displayed revision and expiry.', 'BAD_REQUEST')
          if (!before.change || before.change.expiresAt !== input.expectedExpiresAt) throw new NextAlarmError('That temporary change is no longer current.', 'CONFLICT')
        }
        else {
          if (input.expectedExpiresAt !== undefined || !input.expectedAt || (input.action === 'time') !== (input.time !== undefined)) throw new NextAlarmError('Specify the displayed occurrence and a clock time only for a time change.', 'BAD_REQUEST')
          if (!before.alarm || before.alarm.at !== input.expectedAt || !before.canChange) throw new NextAlarmError(before.reason || 'That alarm is no longer current.', 'CONFLICT')
          const selected = selectedAlarm(current, now)
          if (!selected) throw new NextAlarmError('That alarm is no longer current.', 'CONFLICT')
          const at = input.time ? resolveAlarmClock(selected.at, input.time, current.timeZone) : null
          if (at !== null) {
            if (at <= now) throw new NextAlarmError('Choose a future time on this alarm’s wake date.', 'BAD_REQUEST')
            const following = nextRoutineAlarm(current, selected.originalAt)
            if (following && at >= following.at) throw new NextAlarmError('This change would cross another scheduled alarm. Choose an earlier time or edit the weekly schedule.', 'BAD_REQUEST')
          }
          record = { plan: alarmPlan(current), ids: selected.rows.map(row => row.id), originalAt: selected.originalAt, at,
            expiresAt: Math.max(alarmHoldEnd(selected.originalAt, selected.rows), alarmHoldEnd(at ?? selected.originalAt, selected.rows)) }
        }
        statement(database, `INSERT INTO alarm_overrides(side,revision,record) VALUES (?,?,?)
          ON CONFLICT(side) DO UPDATE SET revision=excluded.revision,record=excluded.record`).run(input.side, randomUUID(), record ? JSON.stringify(record) : null)
        return page(input.side, now)
      }).immediate()
    },
    /** Claim before transport. Uncertain/crashed attempts remain consumed after restart. */
    claim(side: Side, candidate: AlarmOccurrence, now: number, early: boolean): boolean {
      return database.transaction(() => {
        if (!eligible(side, candidate, now, early)) return false
        for (const row of candidate.rows) statement(database, `INSERT INTO alarm_occurrences(side,schedule_id,original_at,effective_at,outcome,attempted_at) VALUES (?,?,?,?,?,?)`)
          .run(side, row.id, candidate.originalAt, candidate.at, 'attempting', now)
        statement(database, 'DELETE FROM alarm_occurrences WHERE attempted_at < ?').run(now - 30 * 86_400_000)
        return true
      }).immediate()
    },
    finish(side: Side, candidate: AlarmOccurrence, outcome: 'acknowledged' | 'unknown'): void {
      database.transaction(() => {
        for (const row of candidate.rows) statement(database, 'UPDATE alarm_occurrences SET outcome=? WHERE side=? AND schedule_id=? AND original_at=?')
          .run(outcome, side, row.id, candidate.originalAt)
      }).immediate()
    },
  }
}

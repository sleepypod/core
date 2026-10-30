import { required } from '@/src/alarms/tests/required'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAlarmStore } from '../store'
import { alarmDatabase, alarmFixture, insertAlarm } from './fixture'
import { effectiveAlarmTargets, occurrenceAt, resolveAlarmClock, selectedAlarm } from '../model'
import { changeNextAlarm } from '../service'
import { withSideLock } from '@/src/hardware/sideLock'

let fixture: ReturnType<typeof alarmFixture>
beforeEach(() => {
  fixture = alarmFixture()
})
afterEach(() => fixture.database.close())
const timestamp = (value: string) => Date.parse(`2026-10-26T${value}:00Z`)
function change(action: 'skip' | 'time', time?: string, now = fixture.now) {
  const before = fixture.store.page('left', now)
  return fixture.store.write({ side: 'left', action, time, expectedAt: required(before.alarm, 'alarm fixture').at, expectedRevision: before.revision }, now)
}
function restore(now = fixture.now) {
  const before = fixture.store.page('left', now)
  return fixture.store.write({ side: 'left', action: 'restore', expectedRevision: before.revision, expectedExpiresAt: required(before.change, 'alarm fixture').expiresAt }, now)
}

describe('persisted next-alarm occurrences', () => {
  it('skips just one event, restores without weekly mutations, and rejects replay after restore', () => {
    const { database, store, now } = fixture
    const rows = database.prepare('SELECT * FROM alarm_schedules').all()
    const original = store.page('left', now)
    const input = { side: 'left' as const, action: 'skip' as const, expectedAt: required(original.alarm, 'alarm fixture').at, expectedRevision: original.revision }
    const skipped = store.write(input, now)
    expect(skipped).toMatchObject({ state: 'skipped', change: { status: 'active', at: null }, followingAt: '2026-11-02T07:00:00.000Z' })
    expect(() => store.write(input, now)).toThrow('changed')
    expect(restore()).toMatchObject({ state: 'scheduled', change: null })
    expect(() => store.write(input, now)).toThrow('changed')
    expect(database.prepare('SELECT * FROM alarm_schedules').all()).toEqual(rows)
    change('skip')
    expect(store.page('left', timestamp('07:17'))).toMatchObject({ state: 'scheduled', change: { status: 'expired' }, alarm: { at: '2026-11-02T07:00:00.000Z' } })
  })
  it('moves warm-up and post-alarm hold to the selected absolute time', () => {
    change('time', '08:00')
    const context = fixture.store.context('left')
    expect(effectiveAlarmTargets(context, timestamp('06:45'))).toEqual([])
    expect(effectiveAlarmTargets(context, timestamp('07:30'))).toMatchObject([{ startsAt: timestamp('07:30'), expiresAt: timestamp('08:16'), temperature: 80 }])
    expect(effectiveAlarmTargets(context, timestamp('08:16'))).toEqual([])
    restore()
    expect(effectiveAlarmTargets(fixture.store.context('left'), timestamp('06:45'))).toMatchObject([{ startsAt: timestamp('06:30') }])
  })
  it('retains original suppression when moved earlier, including its whole hold', () => {
    change('time', '06:00')
    const context = fixture.store.context('left')
    expect(effectiveAlarmTargets(context, timestamp('05:45'))).toHaveLength(1)
    expect(effectiveAlarmTargets(context, timestamp('06:45'))).toEqual([])
    expect(fixture.store.page('left', timestamp('06:45')).canChange).toBe(false)
    expect(fixture.store.page('left', timestamp('07:15')).change?.status).toBe('active')
    expect(effectiveAlarmTargets(context, timestamp('07:15'))).toEqual([])
    expect(effectiveAlarmTargets(context, timestamp('07:16'))).toEqual([])
  })
  it('never suppresses the following week or the other physical side', () => {
    insertAlarm(fixture.database, 'right')
    change('skip')
    expect(fixture.store.page('right', fixture.now).state).toBe('scheduled')
    expect(effectiveAlarmTargets(fixture.store.context('right'), timestamp('06:40'))).toHaveLength(1)
    expect(effectiveAlarmTargets(fixture.store.context('left'), Date.parse('2026-11-02T06:40Z'))).toHaveLength(1)
  })
  it('rejects past, different-day, crossed-event and malformed changes', () => {
    expect(() => change('time', '04:59')).toThrow('future')
    insertAlarm(fixture.database, 'left', '08:00')
    expect(() => change('time', '08:00')).toThrow('cross')
    expect(() => change('time', '09:00')).toThrow('cross')
    const before = fixture.store.page('left', fixture.now)
    expect(() => fixture.store.write({ side: 'left', action: 'skip', time: '08:00', expectedAt: required(before.alarm, 'alarm fixture').at, expectedRevision: before.revision }, fixture.now)).toThrow('clock time')
    expect(() => fixture.store.write({ side: 'left', action: 'skip', expectedAt: '2026-10-27T07:00:00.000Z', expectedRevision: before.revision }, fixture.now)).toThrow('current')
  })
  it('invalidates temporary changes after weekly profile, ownership, or zone changes', () => {
    const changed = change('time', '08:00')
    fixture.database.exec('UPDATE alarm_schedules SET duration=90')
    expect(fixture.store.page('left', fixture.now)).toMatchObject({ change: { status: 'invalidated' }, alarm: { time: '07:00' } })
    expect(() => fixture.store.write({ side: 'left', action: 'restore', expectedRevision: changed.revision, expectedExpiresAt: required(changed.change, 'alarm fixture').expiresAt }, fixture.now)).toThrow('changed')
    restore()
    change('skip')
    fixture.database.exec('UPDATE side_settings SET away_mode=1 WHERE side=\'left\'')
    expect(fixture.store.page('left', fixture.now)).toMatchObject({ state: 'away', canChange: false })
    expect(effectiveAlarmTargets(fixture.store.context('left'), timestamp('06:45'))).toEqual([])
    fixture.database.exec('UPDATE device_settings SET timezone=\'America/Los_Angeles\'')
    expect(fixture.store.page('left', fixture.now).change?.status).toBe('invalidated')
  })
  it('groups identical simultaneous alarms and makes conflicting profiles uneditable', () => {
    const duplicate = insertAlarm(fixture.database)
    expect(fixture.store.page('left', fixture.now).alarm?.scheduleIds).toEqual([fixture.id, duplicate])
    change('skip')
    expect(effectiveAlarmTargets(fixture.store.context('left'), timestamp('06:45'))).toEqual([])
    restore()
    fixture.database.prepare('UPDATE alarm_schedules SET vibration_intensity=80 WHERE id=?').run(duplicate)
    expect(fixture.store.page('left', fixture.now)).toMatchObject({ canChange: false, reason: expect.stringContaining('Conflicting') })
  })
  it('fails closed on corrupt override storage instead of discarding the user’s skip', () => {
    change('skip')
    fixture.database.exec('UPDATE alarm_overrides SET record=\'{}\'')
    expect(() => fixture.store.page('left', fixture.now)).toThrow()
  })
  it('rejects skipped, stale, future and late execution candidates', () => {
    const { store, now } = fixture
    const candidate = required(selectedAlarm(store.context('left'), now), 'alarm fixture')
    expect(store.claim('left', candidate, now, false)).toBe(false)
    expect(store.claim('left', candidate, candidate.at + 60_001, false)).toBe(false)
    change('skip')
    expect(store.claim('left', candidate, candidate.at, false)).toBe(false)
    restore()
    expect(store.claim('left', candidate, candidate.at, false)).toBe(false)
    const current = required(selectedAlarm(store.context('left'), now), 'alarm fixture')
    expect(store.claim('left', current, current.at, false)).toBe(true)
    expect(store.claim('left', current, current.at, false)).toBe(false)
    expect(store.page('left', current.at - 1)).toMatchObject({ canChange: false, execution: 'attempting' })
  })
  it('uses one durable attempt across early wake, edited time, restore and clock callbacks', () => {
    fixture.database.exec('UPDATE alarm_schedules SET wake_window=30')
    change('time', '08:00')
    const candidate = required(selectedAlarm(fixture.store.context('left'), fixture.now), 'alarm fixture')
    expect(fixture.store.claim('left', candidate, timestamp('07:29'), true)).toBe(false)
    expect(fixture.store.claim('left', candidate, timestamp('07:30'), true)).toBe(true)
    fixture.store.finish('left', candidate, 'unknown')
    expect(fixture.store.page('left', timestamp('07:31'))).toMatchObject({ execution: 'unknown', canChange: false })
    restore(timestamp('07:31'))
    const original = required(occurrenceAt(fixture.store.context('left'), timestamp('07:00'), timestamp('07:31')), 'alarm fixture')
    expect(fixture.store.claim('left', original, timestamp('07:31'), false)).toBe(false)
    expect(fixture.store.claim('left', candidate, timestamp('08:00'), false)).toBe(false)
  })
  it('keeps two connections and restarts from consuming an already attempted event', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alarm-restart-'))
    try {
      const path = join(directory, 'config.db')
      let database = alarmDatabase(path)
      insertAlarm(database)
      let store = createAlarmStore(database)
      const page = store.page('left', fixture.now)
      store.write({ side: 'left', action: 'time', time: '08:00', expectedRevision: page.revision, expectedAt: required(page.alarm, 'alarm fixture').at }, fixture.now)
      database.close()
      database = alarmDatabase(path)
      store = createAlarmStore(database)
      const candidate = required(selectedAlarm(store.context('left'), fixture.now), 'alarm fixture')
      expect(candidate.at).toBe(timestamp('08:00'))
      expect(store.claim('left', candidate, timestamp('08:00'), false)).toBe(true)
      database.close()
      database = alarmDatabase(path)
      store = createAlarmStore(database)
      expect(store.claim('left', candidate, timestamp('08:00'), false)).toBe(false)
      expect(store.page('left', timestamp('07:59')).execution).toBe('attempting')
      database.close()
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('serializes concurrent edits and reports a failed scheduler update after persistence', async () => {
    const before = fixture.store.page('left', fixture.now)
    const input = { side: 'left' as const, action: 'skip' as const, expectedRevision: before.revision, expectedAt: required(before.alarm, 'alarm fixture').at }
    const deps = { store: fixture.store, now: () => fixture.now, withSideLock, synchronize: async () => false }
    const results = await Promise.allSettled([changeNextAlarm(input, deps), changeNextAlarm(input, deps)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'fulfilled')).toMatchObject({ value: { schedulerUpdated: false, state: 'skipped' } })
    expect(fixture.store.page('left', fixture.now).state).toBe('skipped')
  })
})

describe('user-selected wall clocks', () => {
  it('rejects nonexistent and repeated DST times without changing the saved wake date', () => {
    expect(() => resolveAlarmClock(Date.parse('2026-03-08T15:00Z'), '02:30', 'America/Los_Angeles')).toThrow('skipped or occurs twice')
    expect(() => resolveAlarmClock(Date.parse('2026-11-01T15:00Z'), '01:30', 'America/Los_Angeles')).toThrow('skipped or occurs twice')
    expect(resolveAlarmClock(Date.parse('2026-11-01T15:00Z'), '03:30', 'America/Los_Angeles')).toBe(Date.parse('2026-11-01T11:30Z'))
  })
  it('supports fractional offsets and non-hour daylight-saving changes', () => {
    expect(resolveAlarmClock(Date.parse('2026-10-26T01:15Z'), '08:00', 'Asia/Kathmandu')).toBe(Date.parse('2026-10-26T02:15Z'))
    expect(() => resolveAlarmClock(Date.parse('2026-10-04T00:00Z'), '02:15', 'Australia/Lord_Howe')).toThrow()
    expect(() => resolveAlarmClock(Date.parse('2026-04-05T00:00Z'), '01:45', 'Australia/Lord_Howe')).toThrow()
  })
})

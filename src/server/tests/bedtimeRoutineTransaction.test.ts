import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import * as schema from '@/src/db/schema'
import type { BedtimeDraft, RoutineSide } from '@/src/lib/bedtimeRoutines'
import { readBedtimeRoutineState, replaceBedtimeRoutineBatch } from '../bedtimeRoutineTransaction'

let database: Database.Database
const luca: BedtimeDraft = {
  power: { onTime: '22:00', offTime: '07:15', onTemperature: 70, enabled: true, endAction: 'maintain' },
  temperatures: [],
  alarm: { time: '07:00', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 20, alarmTemperature: 105, wakeWindow: 0, snoozeDuration: 540, snoozeTaper: 30, enabled: true },
  notes: 'Original routine',
}
const marissa: BedtimeDraft = {
  power: { onTime: '22:30', offTime: '08:30', onTemperature: 78, enabled: true, endAction: 'turn_off' },
  temperatures: [],
  alarm: { time: '08:15', vibrationIntensity: 25, vibrationPattern: 'double', duration: 10, alarmTemperature: 82, wakeWindow: 0, snoozeDuration: 300, snoozeTaper: 0, enabled: true },
  notes: 'Independent example preferences',
}
const state = (side: RoutineSide) => readBedtimeRoutineState(drizzle(database, { schema }), side).records.map(record => record.snapshot)
const create = (side: RoutineSide, draft: BedtimeDraft) => ({ side, changes: [{ dayOfWeek: 'sunday' as const, expectedRevision: null, replacement: draft }] })
const replace = (side: RoutineSide, draft: BedtimeDraft) => ({ side, changes: [{ dayOfWeek: 'sunday' as const, expectedRevision: state(side)[0].revision, replacement: draft }] })
const rawRows = () => ['bedtime_routines', 'power_schedules', 'temperature_schedules', 'alarm_schedules'].map(table => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all())

beforeEach(() => {
  database = migratedComfortDatabase()
  replaceBedtimeRoutineBatch(database, [create('left', luca), create('right', marissa)])
})
afterEach(() => database.close())

describe('atomic multi-side routine changes', () => {
  it('moves complete independent nights together without copying the hot wake preference to the other person', () => {
    const result = replaceBedtimeRoutineBatch(database, [replace('left', marissa), replace('right', luca)])
    expect(state('left')[0].draft).toEqual(marissa)
    expect(state('right')[0].draft).toEqual(luca)
    expect(result.snapshots.map(snapshot => snapshot.side)).toEqual(['left', 'right'])
    expect(result.removed.power).toHaveLength(2)
    expect(result.created.alarm).toEqual([
      expect.objectContaining({ side: 'left', dayOfWeek: 'monday', time: '08:15', alarmTemperature: 82, duration: 10 }),
      expect.objectContaining({ side: 'right', dayOfWeek: 'monday', time: '07:00', alarmTemperature: 105, duration: 20, snoozeDuration: 540, snoozeTaper: 30 }),
    ])
  })

  it('rolls back the first side when the second side changed after review', () => {
    const before = rawRows()
    const outdated = replace('right', luca)
    outdated.changes[0].expectedRevision = '0'.repeat(64)
    expect(() => replaceBedtimeRoutineBatch(database, [replace('left', marissa), outdated])).toThrow('routine changed')
    expect(rawRows()).toEqual(before)
  })

  it('rolls back both sides when any new schedule row cannot be persisted', () => {
    const before = rawRows()
    database.exec('CREATE TRIGGER reject_right_alarm BEFORE INSERT ON alarm_schedules WHEN NEW.side = \'right\' BEGIN SELECT RAISE(ABORT, \'simulated_storage_failure\'); END')
    expect(() => replaceBedtimeRoutineBatch(database, [replace('left', marissa), replace('right', luca)])).toThrow('simulated_storage_failure')
    expect(rawRows()).toEqual(before)
  })

  it('participates in the outer identity transaction and rolls back when its final assignment write fails', () => {
    const before = rawRows()
    expect(() => database.transaction(() => {
      replaceBedtimeRoutineBatch(database, [replace('left', marissa), replace('right', luca)])
      throw new Error('assignment_commit_failed')
    }).immediate()).toThrow('assignment_commit_failed')
    expect(rawRows()).toEqual(before)
  })

  it('does not erase a custom snooze configuration when a stale client cannot represent it', () => {
    const before = rawRows()
    if (!luca.alarm) throw new Error('Expected the seeded wake alarm')
    const incomplete = { ...luca, alarm: { ...luca.alarm, snoozeDuration: undefined, snoozeTaper: undefined } }
    expect(() => replaceBedtimeRoutineBatch(database, [replace('right', marissa), replace('left', incomplete)])).toThrow('custom snooze settings')
    expect(rawRows()).toEqual(before)
  })

  it('rejects a second side whose compiled alarm changed outside its routine', () => {
    const request = [replace('left', marissa), replace('right', luca)]
    database.exec('UPDATE alarm_schedules SET time = \'09:00\' WHERE side = \'right\'')
    const before = rawRows()
    expect(() => replaceBedtimeRoutineBatch(database, request)).toThrow('outside the bedtime editor')
    expect(rawRows()).toEqual(before)
  })

  it('rejects duplicate side entries before writing any changes', () => {
    const before = rawRows()
    expect(() => replaceBedtimeRoutineBatch(database, [replace('left', marissa), replace('left', luca)])).toThrow('only once')
    expect(rawRows()).toEqual(before)
  })

  it('validates the entire second week rather than only each individual new draft', () => {
    const before = rawRows()
    const longMonday: BedtimeDraft = { ...marissa, power: { ...marissa.power, onTime: '08:00', offTime: '12:00' }, alarm: null }
    expect(() => replaceBedtimeRoutineBatch(database, [replace('left', marissa), {
      side: 'right', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: longMonday }],
    }])).toThrow()
    expect(rawRows()).toEqual(before)
  })
})

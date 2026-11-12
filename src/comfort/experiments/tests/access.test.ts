import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { migratedComfortDatabase } from '../../tests/databaseFixture'
import { createComfortLimitStore } from '@/src/temperature/limitStore'
import { createComfortStore } from '../../store'
import { legacyExperimentAccess, readExperimentAvailability } from '../access'

let database: Database.Database
beforeEach(() => {
  database = migratedComfortDatabase()
  database.exec(`INSERT INTO device_settings (id, bed_mode, unused_zone_mode, timezone) VALUES (1, 'solo-left', 'follow', 'America/Los_Angeles');
    INSERT INTO side_settings (side, name) VALUES ('left', 'Left'), ('right', 'Right');
    INSERT INTO power_schedules (side, day_of_week, on_time, off_time, off_day_offset, on_temperature) VALUES ('left', 'monday', '22:00', '07:15', 1, 70);
    INSERT INTO alarm_schedules (side, day_of_week, time, vibration_intensity, duration, alarm_temperature) VALUES ('left', 'tuesday', '07:00', 50, 20, 105);`)
  createComfortLimitStore(database).save('left', 0, { enabled: true, minF: 68, maxF: 72 })
})
afterEach(() => database.close())
const read = () => readExperimentAvailability(database, legacyExperimentAccess(database))
function requiredContext() {
  const value = read().context
  if (!value) throw new Error('Fixture context unavailable')
  return value
}

it('derives the solo source, persisted bounds and fixed wake policy without changing any routines', () => {
  const before = database.prepare('SELECT * FROM alarm_schedules').all()
  expect(read().context).toMatchObject({ baselineF: 70, minimumF: 70, maximumF: 72, timezone: 'America/Los_Angeles' })
  expect(database.prepare('SELECT * FROM alarm_schedules').all()).toEqual(before)
  expect(legacyExperimentAccess(database).subjectKey).toBe(legacyExperimentAccess(database).subjectKey)
})

it.each(['two', 'solo-right'])('does not infer an owner treatment from an unsupported or unconfigured %s arrangement', (mode) => {
  database.prepare('UPDATE device_settings SET bed_mode = ?').run(mode)
  expect(read().context).toBeNull()
})

it('requires a real enabled range and never treats malformed settings as permissive defaults', () => {
  database.exec('DELETE FROM temperature_limits')
  expect(read()).toMatchObject({ context: null, reason: expect.stringContaining('range') })
  database.prepare('INSERT INTO temperature_limits VALUES (?, ?, ?)').run('left', 1, '{broken')
  expect(() => read()).toThrow()
})

it('binds the context to wake time, vibration duration, one-time override, range and adaptive policy changes', () => {
  const first = requiredContext()
  database.exec('UPDATE alarm_schedules SET time = \'08:00\'')
  expect(requiredContext().wakeHash).not.toBe(first.wakeHash)
  database.exec('UPDATE alarm_schedules SET time = \'07:00\', duration = 30')
  expect(requiredContext().wakeHash).not.toBe(first.wakeHash)
  database.exec('UPDATE alarm_schedules SET duration = 20')
  expect(requiredContext().wakeHash).toBe(first.wakeHash)
  database.prepare('INSERT INTO alarm_overrides(side, revision, record) VALUES (?, ?, NULL)').run('left', 'different-review')
  expect(requiredContext().wakeHash).not.toBe(first.wakeHash)
  createComfortLimitStore(database).save('left', 1, { enabled: true, minF: 69, maxF: 71 })
  expect(requiredContext().maximumF).toBe(71)
  expect(requiredContext().bindingHash).not.toBe(first.bindingHash)
  const store = createComfortStore(database), state = store.read('left')
  store.commit('left', { ...state, config: { ...state.config, sensorAware: true } })
  expect(requiredContext().bindingHash).not.toBe(first.bindingHash)
})

it('refuses inconsistent phases, an out-of-band baseline and away mode', () => {
  database.exec('INSERT INTO temperature_schedules (side, day_of_week, time, temperature) VALUES (\'left\', \'tuesday\', \'01:00\', 80)')
  expect(read().context).toBeNull()
  database.exec('DELETE FROM temperature_schedules; UPDATE power_schedules SET on_temperature = 80')
  expect(read().context).toBeNull()
  database.exec('UPDATE power_schedules SET on_temperature = 70; UPDATE side_settings SET away_mode = 1 WHERE side = \'left\'')
  expect(read().context).toBeNull()
})

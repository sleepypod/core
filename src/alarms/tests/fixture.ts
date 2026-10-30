import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { createAlarmStore } from '../store'

export function alarmDatabase(filename?: string) {
  const database = migratedComfortDatabase(filename)
  database.exec('INSERT OR IGNORE INTO device_settings(id,timezone) VALUES (1,\'UTC\'); INSERT OR IGNORE INTO side_settings(side,name) VALUES (\'left\',\'Left\'),(\'right\',\'Right\')')
  return database
}
export function insertAlarm(database: ReturnType<typeof alarmDatabase>, side = 'left', time = '07:00', day = 'monday', window = 0) {
  return Number(database.prepare(`INSERT INTO alarm_schedules(side,day_of_week,time,vibration_intensity,vibration_pattern,duration,alarm_temperature,wake_window)
    VALUES (?,?,?,50,'rise',60,80,?)`).run(side, day, time, window).lastInsertRowid)
}
export function alarmFixture() {
  const database = alarmDatabase()
  const id = insertAlarm(database)
  const store = createAlarmStore(database)
  const now = Date.parse('2026-10-26T05:00:00Z')
  return { database, store, id, now }
}

// @vitest-environment node
import Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { MechanicalStore } from '@/src/biometrics/mechanical/store'
import { mechanicalStateSchema } from '@/src/biometrics/mechanical/context'
import { readHomeVitals } from '../vitals'

it('publishes proven live observations and withdraws them after interference or missing proof', () => {
  const database = new Database(':memory:')
  try {
    migrate(drizzle(database), { migrationsFolder: fileURLToPath(new URL('../../db/biometrics-migrations/', import.meta.url)) })
    const store = new MechanicalStore(database), start = 1700000000000
    const observe = (now: number, moving = false) => store.observe({ now, deviceAt: now, baseAt: now,
      priming: false, baseMoving: moving, vibrationCommandActive: false })
    for (let now = start; now <= start + 80000; now += 1000) observe(now)
    const state = mechanicalStateSchema.parse(store.read()), at = start + 75000
    database.prepare('INSERT INTO biometric_processing_runs (id, side, kind, bundle, config_hash, input_identity, started_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('test-run', 'left', 'live', '{}', 'a'.repeat(64), JSON.stringify({ sourceSide: 'left', timestampBasis: 'firmware_event_time_v1', mechanicalContext: 'mechanical-context-v1' }), start)
    const id = Number(database.prepare('INSERT INTO vitals (side, timestamp, heart_rate, breathing_rate, processing_run_id) VALUES (?, ?, 60, 12, ?)').run('left', at / 1000, 'test-run').lastInsertRowid)
    expect(readHomeVitals(database, 'left', start + 80000)).toMatchObject({ available: false, heartRate: null })
    const flags = JSON.stringify([`mechanical_context_v1:${state.epoch}:${state.spanId}:${at - 61000}:${at + 1000}`])
    database.prepare('INSERT INTO vitals_quality (vitals_id, side, timestamp, quality_score, flags, created_at) VALUES (?, ?, ?, 0.9, ?, ?)').run(id, 'left', at / 1000, flags, at / 1000)
    expect(readHomeVitals(database, 'left', start + 80000)).toMatchObject({ available: true, ts: at,
      expiresAt: state.validUntilMs, heartRate: 60, breathingRate: 12, hrv: null, variabilityMetric: 'window_ibi_variability_v1' })
    expect(readHomeVitals(database, 'right', start + 80000)).toMatchObject({ available: false, heartRate: null })
    expect(readHomeVitals(database, 'left', start + 90000)).toMatchObject({ available: false, heartRate: null })
    observe(start + 81000, true)
    expect(readHomeVitals(database, 'left', start + 81000)).toMatchObject({ available: false, heartRate: null })
    expect(database.prepare('SELECT heart_rate FROM vitals').get()).toEqual({ heart_rate: 60 })
  }
  finally { database.close() }
  expect(readHomeVitals(database, 'left', 1700000000000).available).toBe(false)
})

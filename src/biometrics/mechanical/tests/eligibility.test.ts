// @vitest-environment node
import Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { MechanicalStore } from '../store'
import { mechanicalStateSchema } from '../context'
import { isMechanicallyQualifiedVital } from '../eligibility'

it('requires current quiet evidence and one compatible live receipt before automation uses a row', () => {
  const database = new Database(':memory:')
  try {
    migrate(drizzle(database), { migrationsFolder: fileURLToPath(new URL('../../../db/biometrics-migrations/', import.meta.url)) })
    const store = new MechanicalStore(database), start = 1700000000000
    const observe = (now: number, moving = false) => store.observe({ now, deviceAt: now, baseAt: now,
      priming: false, baseMoving: moving, vibrationCommandActive: false })
    for (let now = start; now <= start + 80000; now += 1000) observe(now)
    const state = mechanicalStateSchema.parse(store.read()), run = randomUUID(), at = start + 75000
    database.prepare('INSERT INTO biometric_processing_runs (id, side, kind, bundle, config_hash, input_identity, started_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(run, 'left', 'live', '{}', 'a'.repeat(64), JSON.stringify({ sourceSide: 'left', timestampBasis: 'firmware_event_time_v1', mechanicalContext: 'mechanical-context-v1' }), start)
    const id = Number(database.prepare('INSERT INTO vitals (side, timestamp, heart_rate, breathing_rate, processing_run_id) VALUES (?, ?, 60, 12, ?)').run('left', at / 1000, run).lastInsertRowid)
    const flags = JSON.stringify([`mechanical_context_v1:${state.epoch}:${state.spanId}:${at - 61000}:${at + 1000}`])
    database.prepare('INSERT INTO vitals_quality (vitals_id, side, timestamp, quality_score, flags, created_at) VALUES (?, ?, ?, 0.9, ?, ?)').run(id, 'left', at / 1000, flags, at / 1000)
    expect(isMechanicallyQualifiedVital(database, id, start + 80000)).toBe(true)
    database.prepare('UPDATE vitals_quality SET flags=NULL').run()
    expect(isMechanicallyQualifiedVital(database, id, start + 80000)).toBe(false)
    database.prepare('UPDATE vitals_quality SET flags=?').run(flags)
    expect(isMechanicallyQualifiedVital(database, id, start + 90000)).toBe(false) // Stale context.
    observe(start + 81000, true)
    expect(isMechanicallyQualifiedVital(database, id, start + 81000)).toBe(false)
    for (let now = start + 82000; now <= start + 95000; now += 1000) observe(now)
    expect(isMechanicallyQualifiedVital(database, id, start + 95000)).toBe(false) // Older quiet interval.
    expect(database.prepare('SELECT COUNT(*) AS count FROM vitals').get()).toEqual({ count: 1 })
  }
  finally { database.close() }
})

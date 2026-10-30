import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../src/db/biometrics-schema'
import * as configSchema from '../../src/db/schema'
import { executeNextBacktest } from '../../src/biometrics/backtest/runner'
import { packagedWorkerPath } from '../../src/biometrics/backtest/location'
import { tickBiometricRuntime } from '../../src/biometrics/profiles/runtime-host'
import { consumeStageView } from '../../src/biometrics/profiles/stage-view'
import { createNotificationStore } from '../../src/notifications/store'
import { randomUUID } from 'node:crypto'
import { createComfortStore, comfortEvent } from '../../src/comfort/store'
import { defaultComfortState, type ComfortContext } from '../../src/comfort/policy'
import { capturePreviewEvidence } from '../../src/comfort/report-evidence'
import { createHistoryFixture } from '../fixtures/importedHistory'

const root = process.env.SLEEPYPOD_BROWSER_FIXTURE
const bioPath = process.env.BIOMETRICS_DATABASE_URL
const configPath = process.env.DATABASE_URL
assert(root && bioPath && configPath && dirname(bioPath) === root && dirname(configPath) === root, 'Isolated browser fixture paths required')
const sqlite = new Database(bioPath, { fileMustExist: true })
const configSqlite = new Database(configPath, { fileMustExist: true })
const db = drizzle(sqlite, { schema })
const config = drizzle(configSqlite, { schema: configSchema })
try {
  if (process.argv[2] === 'seed') {
    const start = Date.parse('2026-10-10T23:00:00Z')
    db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(start + 600_000), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
    for (let minute = 0; minute < 10; minute++) {
      db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(start + minute * 60_000), heartRate: 60, breathingRate: 14, hrv: 30 }).run()
    }
  }
  else if (process.argv[2] === 'imported-history') {
    createHistoryFixture(root)
  }
  else if (process.argv[2] === 'replay') {
    const before = sqlite.prepare('SELECT * FROM vitals ORDER BY id').all()
    const result = await executeNextBacktest(db, { owner: 'browser-fixture', workerPath: packagedWorkerPath(), timeoutMs: 30_000,
      // Test-only admission: this does not assert measured pod resource health.
      admit: async () => true })
    assert.equal(result.state, 'succeeded')
    assert.deepEqual(sqlite.prepare('SELECT * FROM vitals ORDER BY id').all(), before)
    console.log(JSON.stringify(result))
  }
  else if (process.argv[2] === 'adopt') {
    assert.deepEqual(tickBiometricRuntime(config, db).errors, [])
    // Run shipped Python consumers on one synthetic empty-bed frame, without
    // starting the daemon, DAC transport, or live hardware services.
    execFileSync(resolve('modules/piezo-processor/.venv/bin/python'), ['-c', `
import sqlite3, sys
sys.path.insert(0, 'modules')
sys.path.insert(0, 'modules/piezo-processor')
import numpy as np
from main import DBHolder, SideProcessor
from runtime_adapter import RuntimeCoordinator
connection = sqlite3.connect(sys.argv[1])
holder = DBHolder(connection)
processors = {side: SideProcessor(side, holder) for side in ('left', 'right')}
runtime = RuntimeCoordinator(holder, processors)
runtime.before_frame(None, lambda side: False, 1791673200000)
assert runtime.enabled and runtime.problem is None
for processor in processors.values():
    processor.ingest(np.zeros(500))
runtime.after_frame(1791673200000)
connection.close()
`, bioPath], { timeout: 15_000, maxBuffer: 65536 })
    consumeStageView(config, db, 'left')
    assert.deepEqual(tickBiometricRuntime(config, db).errors, [])
  }
  else if (process.argv[2] === 'comfort-report') {
    // Simulated production provenance exists only in this isolated browser database.
    // It tests review behavior and is never evidence of an actual Preview night.
    const store = createComfortStore(configSqlite)
    const state = { ...defaultComfortState(), config: { mode: 'preview' as const, minimumF: 70, maximumF: 95 } }
    const start = Date.now() - 86_400_000
    const runId = randomUUID()
    for (let minute = 0; minute <= 240; minute++) {
      const now = start + minute * 60_000
      const context: ComfortContext = { now,
        window: { session: `synthetic-browser:${start}`, start, end: start + 8 * 3_600_000, baselineF: 75, segment: 'initial', alarmAt: null,
          phases: { revision: 'b'.repeat(64), startF: 75, changes: [] } },
        device: { observedAt: now, powered: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false, targetF: 75 },
        presence: { observedAt: now, occupied: true, available: true, entry: { measuredAt: now, sourceKey: 'c'.repeat(64), state: 'present' } },
        eitherAway: false, routinesPaused: false, alarmOverride: false, owner: 'schedule', targetKnown: true }
      const preview = capturePreviewEvidence(state, context, 75, 'America/Los_Angeles', runId,
        { environment: 'production', buildRevision: 'a'.repeat(40) })
      assert(preview)
      store.commit('left', state, { ...comfortEvent(now, 'preview', 'Synthetic browser proposal; not an actual night.'),
        session: preview.session, eligible: true, proposedF: 74, reportedF: 75, deviceObservedAt: now, presenceObservedAt: now,
        owner: 'schedule', preview })
    }
  }
  else if (process.argv[2] === 'notify') {
    // Persist a synthetic service event through the production store; no public
    // API can forge an alert and no automation or hardware daemon is started.
    const store = createNotificationStore(configSqlite)
    store.publish({ sourceId: 9876, title: 'Browser fixture alert', message: 'Synthetic bedroom humidity notification.' })
  }
  else if (process.argv[2] === 'household-prepare') {
    configSqlite.prepare('INSERT OR IGNORE INTO device_settings (id) VALUES (1)').run()
    const original = configSqlite.prepare('SELECT bed_mode, unused_zone_mode FROM device_settings WHERE id = 1').get()
    configSqlite.prepare('UPDATE device_settings SET bed_mode = \'solo-left\', unused_zone_mode = \'follow\' WHERE id = 1').run()
    console.log(JSON.stringify(original))
  }
  else if (process.argv[2] === 'household-cleanup') {
    const original = JSON.parse(process.argv[3]) as { bed_mode: string, unused_zone_mode: string }
    assert(['two', 'solo-left', 'solo-right'].includes(original.bed_mode))
    assert(['off', 'follow', 'independent'].includes(original.unused_zone_mode))
    configSqlite.transaction(() => {
      for (const table of ['household_invitations', 'household_mutation_receipts', 'household_personal_settings', 'household_devices', 'household_accounts', 'households']) configSqlite.prepare(`DELETE FROM ${table}`).run()
      configSqlite.prepare('UPDATE device_settings SET bed_mode = ?, unused_zone_mode = ? WHERE id = 1').run(original.bed_mode, original.unused_zone_mode)
    })()
  }
  else throw new Error('Unknown browser fixture action')
}
finally {
  sqlite.close()
  configSqlite.close()
}

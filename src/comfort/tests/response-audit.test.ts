import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { describe, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from './databaseFixture'
import { responseFixture } from './responseFixture'
import { readResponseAudit } from '../response-audit'
import { responseAuditSchema } from '../response-contract'
import { temperatureApplicationInputSchema } from '@/src/temperature/applications'
import { createComfortStore, comfortEvent } from '../store'
import { defaultComfortState } from '../policy'
import { createPreviewReports } from '../reports'

function databaseFixture() {
  const database = migratedComfortDatabase(), biometrics = new Database(':memory:'), fixture = responseFixture()
  migrate(drizzle(biometrics), { migrationsFolder: path.resolve('src/db/biometrics-migrations') })
  const { side, targetF, durationSec, reason, source, requestId } = fixture.application
  const request = temperatureApplicationInputSchema.parse({ side, targetF, durationSec, reason, source, requestId })
  database.prepare(`INSERT INTO temperature_applications (attempt_id,side,attempted_at,finished_at,outcome,request)
    VALUES (?,?,?,?,?,?)`).run(fixture.application.attemptId, side, fixture.at, fixture.at + 100, 'acknowledged', JSON.stringify(request))
  const insert = biometrics.prepare('INSERT INTO thermal_state (timestamp,side,is_powered,target_temp_f,current_temp_f) VALUES (?,?,?,?,?)')
  for (const sample of fixture.samples) insert.run(sample.at / 1000, side, Number(sample.powered), sample.targetF, sample.waterF)
  const read = () => readResponseAudit(database, biometrics, 'left', fixture.now, () => fixture.audit)
  const close = () => {
    database.close()
    biometrics.close()
  }
  return { database, biometrics, fixture, request, read, close }
}

describe('retained observed response audit', () => {
  it('joins real command and water tables without writing, then withdraws a removed actual outcome', () => {
    const test = databaseFixture()
    try {
      const changes = [test.database, test.biometrics].map(database => database.prepare('SELECT total_changes() AS count').get())
      const result = responseAuditSchema.parse(test.read())
      expect(result).toMatchObject({ status: 'read', reviewedNights: 1, responseNights: 1, warmingWindows: 1,
        coolingWindows: 0, modelAvailable: false, activationAvailable: false, attribution: 'physical_zone_only', exclusions: [] })
      expect(result.datasetHash).not.toBe('0'.repeat(64))
      expect(test.read()).toEqual(result)
      expect([test.database, test.biometrics].map(database => database.prepare('SELECT total_changes() AS count').get())).toEqual(changes)
      test.biometrics.prepare('DELETE FROM thermal_state WHERE timestamp >= ?').run((test.fixture.at + 1_740_000) / 1000)
      expect(test.read()).toMatchObject({ responseNights: 0, warmingWindows: 0 })
      expect(test.read().datasetHash).not.toBe(result.datasetHash)
    }
    finally { test.close() }
  })

  it('does not combine opposite bed sides and binds the digest to actual observations', () => {
    const test = databaseFixture()
    try {
      expect(readResponseAudit(test.database, test.biometrics, 'right', test.fixture.now, () => test.fixture.audit)).toMatchObject({ responseNights: 0 })
      const before = test.read().datasetHash
      test.biometrics.prepare('UPDATE thermal_state SET current_temp_f=current_temp_f+0.1 WHERE timestamp > ?').run(test.fixture.at / 1000)
      expect(test.read().responseNights).toBe(1)
      expect(test.read().datasetHash).not.toBe(before)
    }
    finally { test.close() }
  })

  it.each(['malformed', 'wrong-side', 'future', 'oversized', 'water-value', 'water-count', 'command-count', 'change-count'])(
    'excludes %s source evidence, without claiming a fitted model', (failure) => {
      const test = databaseFixture()
      try {
        if (failure === 'malformed') test.database.prepare('UPDATE temperature_applications SET request=\'{\' ').run()
        if (failure === 'wrong-side') test.database.prepare('UPDATE temperature_applications SET request=json_set(request,\'$.side\',\'right\')').run()
        if (failure === 'future') test.database.prepare('UPDATE temperature_applications SET finished_at=?').run(test.fixture.now + 1)
        if (failure === 'oversized') test.database.prepare('UPDATE temperature_applications SET request=?').run(' '.repeat(65_537))
        if (failure === 'water-value') test.biometrics.prepare('UPDATE thermal_state SET current_temp_f=400 WHERE id=40').run()
        if (failure === 'water-count') {
          for (let offset = 1; offset <= 301; offset++) test.biometrics.prepare('INSERT INTO thermal_state (timestamp,side,is_powered,target_temp_f,current_temp_f) VALUES (?,\'left\',1,71,70)')
            .run((test.fixture.at + offset) / 1000)
        }
        if (failure === 'command-count' || failure === 'change-count') {
          const count = failure === 'command-count' ? 1000 : 64
          for (let index = 0; index < count; index++) test.database.prepare(`INSERT INTO temperature_applications (attempt_id,side,attempted_at,finished_at,outcome,request)
            VALUES (?, 'left', ?, ?, 'acknowledged', ?)`).run(randomUUID(), test.fixture.at + index, test.fixture.at + index + 100, JSON.stringify(test.request))
        }
        expect(test.read()).toMatchObject({ status: 'partial', responseNights: 0, modelAvailable: false, activationAvailable: false })
        expect(test.read().exclusions.length).toBeGreaterThan(0)
      }
      finally { test.close() }
    })

  it('bounds total command payload bytes before allocating a water audit', () => {
    const test = databaseFixture()
    try {
      const payload = JSON.stringify({ ...test.request, reason: 'keepalive' }).padEnd(60_000, ' ')
      for (let index = 1; index <= 75; index++) test.database.prepare(`INSERT INTO temperature_applications (attempt_id,side,attempted_at,finished_at,outcome,request)
        VALUES (?, 'left', ?, ?, 'acknowledged', ?)`).run(randomUUID(), test.fixture.at + index, test.fixture.at + index + 100, payload)
      const reads = vi.spyOn(test.biometrics, 'prepare')
      expect(test.read()).toMatchObject({ status: 'partial', responseNights: 0 })
      expect(reads).not.toHaveBeenCalled()
    }
    finally { test.close() }
  })

  it('stops water queries before the shared 50,000-row inspection budget is exceeded', () => {
    const test = databaseFixture()
    try {
      for (let index = 1; index < 64; index++) test.database.prepare(`INSERT INTO temperature_applications (attempt_id,side,attempted_at,finished_at,outcome,request)
        VALUES (?, 'left', ?, ?, 'acknowledged', ?)`).run(randomUUID(), test.fixture.at + index, test.fixture.at + index + 100, JSON.stringify(test.request))
      for (let offset = 1; offset <= 301; offset++) test.biometrics.prepare('INSERT INTO thermal_state (timestamp,side,is_powered,target_temp_f,current_temp_f) VALUES (?,\'left\',1,71,70)')
        .run((test.fixture.at + offset) / 1000)
      // Inject distinct source groups to isolate the global read budget; real review validity is tested below.
      test.fixture.audit.recordings = [8, 9, 10].map(day => ({ ...test.fixture.recording, date: `2026-11-${String(day).padStart(2, '0')}` }))
      test.fixture.audit.proofs = test.fixture.audit.recordings.map(night => ({ ...test.fixture.audit.proofs[0], date: night.date }))
      const reads = vi.spyOn(test.biometrics, 'prepare')
      const result = test.read()
      expect(reads.mock.calls.filter(([query]) => query.includes('FROM thermal_state'))).toHaveLength(166)
      expect(result).toMatchObject({ status: 'partial', responseNights: 0 })
      expect(result.exclusions.some(item => item.reason.includes('budget is exhausted'))).toBe(true)
    }
    finally { test.close() }
  })

  it('withdraws all counts on unreadable storage, and excludes nights outside retained receipts', () => {
    const test = databaseFixture()
    try {
      expect(readResponseAudit(test.database, test.biometrics, 'left', test.fixture.now + 31 * 86_400_000, () => test.fixture.audit))
        .toMatchObject({ responseNights: 0, exclusions: [expect.objectContaining({ reason: expect.stringContaining('30-day') })] })
      test.biometrics.exec('DROP TABLE thermal_state')
      expect(test.read()).toMatchObject({ status: 'unavailable', reviewedNights: 0, responseNights: 0, datasetHash: '0'.repeat(64) })
    }
    finally { test.close() }
  })

  it('requires the real reviewed night digest and withdraws later-edited records', async () => {
    const test = databaseFixture()
    try {
      const store = createComfortStore(test.database), state = defaultComfortState(), runId = randomUUID()
      for (let minute = 0; minute < 480; minute++) {
        const at = test.fixture.start + minute * 60_000
        const context = test.fixture.recording.samples[Math.floor(minute / 5)].context
        store.commit('left', state, { ...comfortEvent(at, 'preview', 'Synthetic target-response integration fixture'),
          eligible: true, session: test.fixture.recording.date, thermalContext: context,
          preview: { format: 1, runId, environment: 'production', buildRevision: 'a'.repeat(40), hardwareIdentity: 'b'.repeat(64),
            session: test.fixture.recording.date, start: test.fixture.start, end: test.fixture.start + 8 * 3_600_000,
            timezone: 'UTC', scheduleRevision: 'c'.repeat(64), policy: { minimumF: 69, maximumF: 71, sensorAware: true, followBedtime: false, offsetF: 0 },
            scheduledBaselineF: 70, decisionBaselineF: 70, presence: 'occupied', presenceSourceKey: 'd'.repeat(64),
            mechanicallyQuiet: true, deviceFresh: true, sensorReady: true, manualPaused: false },
        })
      }
      store.saveFeedback('left', { date: test.fixture.recording.date, comfort: 'comfortable' }, comfortEvent(test.fixture.now, 'feedback', 'Synthetic fixture'))
      const read = () => readResponseAudit(test.database, test.biometrics, 'left', test.fixture.now)
      expect(read().responseNights).toBe(0)
      const reports = createPreviewReports(test.database, () => test.fixture.now)
      const report = (await reports.list('left')).items[0].summary
      expect(report.reviewable).toBe(true)
      await reports.review({ side: 'left', id: report.id, digest: report.digest, expectedReviewId: null,
        outcome: 'reviewed', confirmedActualNight: true, note: 'Synthetic fixture, no real personal data' })
      expect(read()).toMatchObject({ reviewedNights: 1, responseNights: 1, warmingWindows: 1 })
      test.database.prepare('UPDATE comfort_events SET event=json_set(event,\'$.message\',\'Edited after review\') WHERE observed_at=?').run(test.fixture.start)
      expect(read()).toMatchObject({ reviewedNights: 0, responseNights: 0 })
    }
    finally { test.close() }
  })
})

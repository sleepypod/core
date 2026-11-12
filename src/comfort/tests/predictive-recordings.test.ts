import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migratedComfortDatabase } from './databaseFixture'
import { predictiveRecordingFixture } from './predictiveRecordingFixture'
import { createPredictiveRecordings } from '../predictive-recording-store'
import { PREDICTIVE_RECORDING_RETENTION_MS, predictiveRecordingSchema, predictiveWorkerResultSchema } from '../predictive-recording-contract'

let database: Database.Database
beforeEach(() => {
  database = migratedComfortDatabase()
})
afterEach(() => database.close())
const now = 1_800_000_000_000

describe('prospective recordings', () => {
  it('stores the exact source and model identities before an outcome exists without changing control state', () => {
    const { record } = predictiveRecordingFixture(now), store = createPredictiveRecordings(database)
    expect(store.append(record, now)).toBe(true)
    expect(store.status('left', now)).toMatchObject({ records: 1, sessions: 1, candidates: 1, holds: 0,
      withheld: 0, activationAvailable: false, latestAt: now })
    expect(store.status('right', now)).toMatchObject({ records: 0, latestAt: null })
    const saved = JSON.parse((database.prepare('SELECT record FROM predictive_recordings').get() as { record: string }).record)
    expect(saved).toEqual(record)
    expect(database.prepare('SELECT count(*) AS count FROM comfort_states').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT count(*) AS count FROM temperature_applications').get()).toEqual({ count: 0 })
  })
  it('deduplicates restarts and rapid samples, but retains the next five-minute comparison', () => {
    const store = createPredictiveRecordings(database)
    expect(store.append(predictiveRecordingFixture(now).record, now)).toBe(true)
    expect(store.append(predictiveRecordingFixture(now).record, now)).toBe(false)
    expect(store.append(predictiveRecordingFixture(now + 299_999).record, now + 299_999)).toBe(false)
    expect(store.append(predictiveRecordingFixture(now + 300_000).record, now + 300_000)).toBe(true)
    expect(store.status('left', now + 300_000).records).toBe(2)
  })
  it.each(['expired', 'future', 'other input', 'applied', 'synthetic', 'unidentified', 'wrong side'] as const)('rejects %s evidence', (kind) => {
    const { record } = predictiveRecordingFixture(now)
    if (kind === 'future') record.recordedAt++
    if (kind === 'other input') record.forecasts.requestHash = 'f'.repeat(64)
    if (kind === 'applied') (record as unknown as { applied: boolean }).applied = true
    if (kind === 'synthetic') record.source.environment = 'test'
    if (kind === 'unidentified') record.source.hardwareIdentity = null
    if (kind === 'wrong side') record.selection.side = 'right'
    expect(() => createPredictiveRecordings(database).append(record, kind === 'expired' ? now + 15_000 : now)).toThrow()
  })
  it('rejects predictions without their corresponding artifact identity', () => {
    const { forecasts } = predictiveRecordingFixture(now)
    expect(predictiveWorkerResultSchema.safeParse({ ...forecasts, holdIdentity: null }).success).toBe(false)
    expect(predictiveWorkerResultSchema.safeParse({ ...forecasts, responseIdentity: null }).success).toBe(false)
  })
  it('detects changed bytes, contradictory indexed metadata and future retained rows', () => {
    const store = createPredictiveRecordings(database), { record } = predictiveRecordingFixture(now)
    store.append(record, now)
    database.prepare('UPDATE predictive_recordings SET content_hash=?').run('f'.repeat(64))
    expect(() => store.status('left', now)).toThrow('integrity')
    database.prepare('DELETE FROM predictive_recordings').run()
    store.append(record, now)
    database.prepare('UPDATE predictive_recordings SET session=?').run('different-night')
    expect(() => store.status('left', now)).toThrow('integrity')
    expect(() => store.status('left', now - 1)).toThrow()
  })
  it('expires source records without altering schedules or fitting a model', () => {
    const store = createPredictiveRecordings(database)
    store.append(predictiveRecordingFixture(now).record, now)
    store.prune(now + PREDICTIVE_RECORDING_RETENTION_MS + 1)
    expect(store.status('left', now + PREDICTIVE_RECORDING_RETENTION_MS + 1).records).toBe(0)
    expect(database.prepare('SELECT count(*) AS count FROM thermal_forecasts').get()).toEqual({ count: 0 })
  })
  it('does not accept synthetic success by changing a withheld record into an applied command', () => {
    const { record } = predictiveRecordingFixture(now)
    expect(predictiveRecordingSchema.safeParse({ ...record, applied: true }).success).toBe(false)
  })
})

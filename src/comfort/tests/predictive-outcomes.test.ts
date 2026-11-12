import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { predictiveOutcomeFixture } from './predictiveOutcomeFixture'
import { migratedComfortDatabase } from './databaseFixture'
import { createPredictiveRecordings, predictiveContentHash } from '../predictive-recording-store'
import { assessPredictiveOutcome } from '../predictive-outcome-window'
import { evaluatePredictiveOutcomes } from '../predictive-outcomes'
import { predictiveOutcomeSchema } from '../predictive-outcome-contract'
import { createComfortStore, comfortEvent } from '../store'
import { comfortLocalDate, defaultComfortState } from '../policy'
import { createPreviewReports } from '../reports'

describe('prospective unchanged-target outcomes', () => {
  it('scores actual holding at both horizons and leaves the unapplied candidate without an outcome', () => {
    const value = predictiveOutcomeFixture()
    const before = structuredClone(value)
    expect(value.record.selection.disposition).toBe('candidate')
    expect(assessPredictiveOutcome(value.record, value.review, value.samples, [], value.now)).toMatchObject({ state: 'scored',
      score: { horizons: [{ minutes: 15, actualWaterF: 73.5, errorF: 0.5, persistenceErrorF: 0.5, insideRange: false },
        { minutes: 30, actualWaterF: 74, errorF: 1, persistenceErrorF: 1, insideRange: false }] } })
    expect(value).toEqual(before)
  })
  it('waits for the night to finish and requires the unchanged reviewed source', () => {
    const value = predictiveOutcomeFixture(), { record, review, samples, now } = value
    expect(assessPredictiveOutcome(record, null, [], [], record.recordedAt)).toEqual({ state: 'pending' })
    expect(assessPredictiveOutcome(record, null, samples, [], now)).toMatchObject({ reason: 'no_review' })
    review.proof.reportId = 'e'.repeat(64)
    expect(assessPredictiveOutcome(record, review, samples, [], now)).toMatchObject({ reason: 'no_review' })
  })
  it.each(['power', 'target', 'water', 'gap', 'duplicate', 'room', 'context gap', 'configuration', 'origin', 'future clock'] as const)('rejects %s changes', (kind) => {
    const value = predictiveOutcomeFixture()
    if (kind === 'power') value.samples[10].powered = false
    if (kind === 'target') value.samples[10].targetF = 69
    if (kind === 'water') value.samples[10].waterF = null
    if (kind === 'gap') value.samples.splice(10, 4)
    if (kind === 'duplicate') value.samples[10].at = value.samples[9].at
    if (kind === 'room') value.review.recording.samples[15].context.roomF = 78
    if (kind === 'context gap') value.review.recording.samples.splice(15, 2)
    if (kind === 'configuration') value.review.proof.configuration = 'f'.repeat(64)
    if (kind === 'origin') value.samples[3].waterF = 76
    if (kind === 'future clock') value.samples[10].at = value.now + 1
    expect(assessPredictiveOutcome(value.record, value.review, value.samples, [], value.now).state).toBe('withheld')
  })
  it.each(['manual', 'unknown', 'another side', 'slow acknowledgment', 'same-temperature reconcile'] as const)('excludes %s command evidence', (kind) => {
    const value = predictiveOutcomeFixture(), at = value.record.request.observedAt + 60_000
    const command = { id: 1, attemptId: randomUUID(), attemptedAt: at, finishedAt: at + 100, side: 'left' as const,
      reason: 'keepalive' as const, source: 'schedule' as const, targetF: 70, durationSec: null, requestId: null,
      outcome: 'acknowledged' as const, acknowledgment: 'accepted_not_physically_verified' as const }
    const changed = { ...command, ...(kind === 'manual'
      ? { reason: 'manual' as const }
      : kind === 'unknown'
        ? { outcome: 'unknown' as const }
        : kind === 'another side'
          ? { side: 'right' as const }
          : kind === 'slow acknowledgment' ? { finishedAt: at + 31_000 } : { reason: 'reconcile' as const }) }
    expect(assessPredictiveOutcome(value.record, value.review, value.samples, [command], value.now).state).toBe('scored')
    expect(assessPredictiveOutcome(value.record, value.review, value.samples, [changed], value.now)).toMatchObject({ reason: 'command_changed' })
  })
})

let database: Database.Database, biometrics: Database.Database
beforeEach(() => {
  database = migratedComfortDatabase()
  biometrics = new Database(':memory:')
  biometrics.exec('CREATE TABLE thermal_state(id INTEGER PRIMARY KEY, timestamp INTEGER,side TEXT,is_powered INTEGER,target_temp_f REAL,current_temp_f REAL)')
})
afterEach(() => {
  database.close()
  biometrics.close()
})
function seed(value = predictiveOutcomeFixture()) {
  createPredictiveRecordings(database).append(value.record, value.record.recordedAt)
  const insert = biometrics.prepare('INSERT INTO thermal_state(timestamp,side,is_powered,target_temp_f,current_temp_f) VALUES (?,?,?,?,?)')
  for (const sample of value.samples) insert.run(sample.at / 1000, 'left', 1, sample.targetF, sample.waterF)
  return value
}
describe('prospective read-only audit', () => {
  it('joins the real source-review pipeline and withdraws a subsequently edited night', async () => {
    const value = seed(), source = value.record.source
    const store = createComfortStore(database), state = defaultComfortState()
    for (let at = source.start; at < source.end; at += 60_000) {
      const context = value.review.recording.samples[Math.floor((at - source.start) / 300_000)].context
      store.commit('left', state, { ...comfortEvent(at, 'preview', 'Synthetic prospective audit fixture'),
        eligible: true, session: source.session, thermalContext: context,
        preview: { ...source, bedroom: source.bedroom ? { ...source.bedroom, expiresAt: at + 60_000 } : null } })
    }
    store.saveFeedback('left', { date: comfortLocalDate(source.end, source.timezone), comfort: 'comfortable' },
      comfortEvent(value.now, 'feedback', 'Synthetic complete-night check-in'))
    expect(evaluatePredictiveOutcomes(database, biometrics, 'left', value.now)).toMatchObject({ scored: 0, withheld: 1 })
    const reports = createPreviewReports(database, () => value.now)
    const [item] = (await reports.list('left')).items
    expect(item.summary.reviewable).toBe(true)
    await reports.review({ side: 'left', id: item.summary.id, digest: item.summary.digest,
      expectedReviewId: null, outcome: 'reviewed', confirmedActualNight: true, note: 'Synthetic fixture only' })
    const before = database.serialize(), waterBefore = biometrics.serialize()
    expect(evaluatePredictiveOutcomes(database, biometrics, 'left', value.now)).toMatchObject({ scored: 1, withheld: 0,
      models: [{ reviewedNights: 1, horizons: [{ minutes: 15, meanNightErrorF: 0.5 }, { minutes: 30, meanNightErrorF: 1 }] }] })
    expect(database.serialize().equals(before)).toBe(true)
    expect(biometrics.serialize().equals(waterBefore)).toBe(true)
    database.prepare('UPDATE comfort_events SET event=json_set(event,?,?) WHERE side=? AND observed_at=?')
      .run('$.message', 'Changed after review', 'left', source.start)
    expect(evaluatePredictiveOutcomes(database, biometrics, 'left', value.now)).toMatchObject({ scored: 0, withheld: 1, models: [] })
  })
  it('binds current reviews to persisted forecasts without creating model or control rows', () => {
    const value = seed()
    const before = database.serialize(), waterBefore = biometrics.serialize()
    const result = evaluatePredictiveOutcomes(database, biometrics, 'left', value.now, () => value.audit)
    expect(result).toMatchObject({ considered: 1, scored: 1, pending: 0, withheld: 0, activationAvailable: false,
      models: [{ artifactId: value.record.forecasts.holdIdentity?.id, comparisons: 1, reviewedNights: 1,
        horizons: [{ minutes: 15, meanNightErrorF: 0.5, meanNightPersistenceErrorF: 0.5 }, { minutes: 30, meanNightErrorF: 1 }] }] })
    expect(database.serialize().equals(before)).toBe(true)
    expect(biometrics.serialize().equals(waterBefore)).toBe(true)
    value.audit.proofs[0].configuration = 'f'.repeat(64)
    expect(evaluatePredictiveOutcomes(database, biometrics, 'left', value.now, () => value.audit)).toMatchObject({ scored: 0, withheld: 1, models: [] })
  })
  it('does not silently promote fabricated fixture reviews in the actual audit', () => {
    const value = seed()
    expect(evaluatePredictiveOutcomes(database, biometrics, 'left', value.now)).toMatchObject({ considered: 1, scored: 0,
      withheld: 1, models: [], exclusions: [{ code: 'no_review', count: 1 }] })
  })
  it('rejects corrupt evidence rather than returning favorable partial statistics', () => {
    const value = seed()
    database.prepare('UPDATE predictive_recordings SET content_hash=?').run('f'.repeat(64))
    expect(() => evaluatePredictiveOutcomes(database, biometrics, 'left', value.now, () => value.audit)).toThrow('integrity')
  })
  it('keeps different model versions separate and never treats comparisons as independent nights', () => {
    const first = seed(), second = predictiveOutcomeFixture(first.record.recordedAt + 86_400_000)
    if (!second.record.forecasts.holdIdentity) throw new Error('Fixture requires a model identity.')
    second.record.forecasts.holdIdentity.id = 'e'.repeat(64)
    seed(second)
    const source = { ...first.audit, proofs: [...first.audit.proofs, ...second.audit.proofs], recordings: [...first.audit.recordings, ...second.audit.recordings] }
    const result = evaluatePredictiveOutcomes(database, biometrics, 'left', second.now, () => source)
    expect(result.models).toHaveLength(2)
    expect(result.models.map(model => model.reviewedNights)).toEqual([1, 1])
    expect(predictiveOutcomeSchema.safeParse({ ...result, scored: 100 }).success).toBe(false)
    expect(predictiveOutcomeSchema.safeParse({ ...result, activationAvailable: true }).success).toBe(false)
  })
  it('weights nights equally when one night has more overlapping comparisons', () => {
    const first = seed(), at = first.record.recordedAt
    const overlapping = predictiveOutcomeFixture(at + 300_000).record
    overlapping.source = structuredClone(first.record.source)
    overlapping.runId = overlapping.source.runId
    overlapping.request.input.waterF = 73 + 1 / 6
    overlapping.forecasts.requestHash = predictiveContentHash(overlapping.request)
    createPredictiveRecordings(database).append(overlapping, overlapping.recordedAt)
    const insert = biometrics.prepare('INSERT INTO thermal_state(timestamp,side,is_powered,target_temp_f,current_temp_f) VALUES (?,?,?,?,?)')
    for (let index = 67; index <= 76; index++) insert.run((at - 90_000 + index * 30_000) / 1000, 'left', 1, 70, 74)
    const second = predictiveOutcomeFixture(at + 86_400_000)
    second.record.forecasts.hold.predictions[0].waterF = 73.5
    second.record.forecasts.hold.predictions[0].upperF = 73.75
    second.record.forecasts.hold.predictions[1].waterF = 74
    second.record.forecasts.hold.predictions[1].upperF = 74.25
    seed(second)
    const source = { ...first.audit, proofs: [...first.audit.proofs, ...second.audit.proofs], recordings: [...first.audit.recordings, ...second.audit.recordings] }
    const result = evaluatePredictiveOutcomes(database, biometrics, 'left', second.now, () => source)
    expect(result).toMatchObject({ scored: 3, models: [{ comparisons: 3, reviewedNights: 2 }] })
    expect(result.models[0].horizons[0].meanNightErrorF).toBeCloseTo(7 / 24)
    expect(result.models[0].horizons[1].meanNightErrorF).toBeCloseTo(0.5)
  })
  it('withholds missing forecasts instead of counting them as zero prediction error', () => {
    const value = predictiveOutcomeFixture()
    value.record.forecasts.holdIdentity = null
    value.record.forecasts.hold.predictions = []
    value.record.forecasts.requestHash = predictiveContentHash(value.record.request)
    seed(value)
    expect(evaluatePredictiveOutcomes(database, biometrics, 'left', value.now)).toMatchObject({ scored: 0, withheld: 1, models: [],
      exclusions: [{ code: 'no_forecast', count: 1 }] })
  })
})

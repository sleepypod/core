import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { migratedComfortDatabase } from './databaseFixture'
import { forecastRecordings } from './forecastFixture'
import { createComfortStore, comfortEvent } from '../store'
import { defaultComfortState } from '../policy'
import { createPreviewReports } from '../reports'
import { createThermalForecasts } from '../thermal-forecast-store'
import { thermalDatasetAudit } from '../thermal-dataset'

describe('reviewed SQL recordings through water forecasting', () => {
  it('fits only after actual source review, reloads its registry and withdraws edited references', async () => {
    const database = migratedComfortDatabase()
    try {
      const recordings = forecastRecordings(24)
      const finalObservation = recordings.at(-1)?.samples.at(-1)?.at
      if (finalObservation === undefined) throw new Error('Synthetic fixture is incomplete')
      const now = finalObservation + 86_400_000
      const store = createComfortStore(database), state = defaultComfortState()
      // These heat-equation series are test fixtures, never a source of personal model weights.
      for (const recording of recordings) {
        const start = recording.samples[0].at, end = start + 8 * 3_600_000, runId = randomUUID()
        for (let minute = 0; minute < 480; minute++) {
          const at = start + minute * 60_000, context = recording.samples[Math.floor(minute / 5)].context
          store.commit('left', state, { ...comfortEvent(at, 'preview', 'Synthetic forecast integration fixture'),
            eligible: true, session: recording.date, thermalContext: context,
            preview: { format: 1, runId, environment: 'production', buildRevision: 'a'.repeat(40),
              hardwareIdentity: 'b'.repeat(64), session: recording.date, start, end, timezone: 'UTC', scheduleRevision: 'c'.repeat(64),
              policy: { minimumF: 69, maximumF: 71, sensorAware: true, followBedtime: false, offsetF: 0 },
              scheduledBaselineF: 70, decisionBaselineF: 70, presence: 'occupied', presenceSourceKey: 'd'.repeat(64),
              mechanicallyQuiet: true, deviceFresh: true, sensorReady: true, manualPaused: false },
          })
        }
        store.saveFeedback('left', { date: new Date(end).toISOString().slice(0, 10), comfort: 'comfortable' }, comfortEvent(now, 'feedback', 'Synthetic fixture'))
      }
      const registry = createThermalForecasts(database, () => now)
      expect(registry.status('left').completeNights).toBe(0)
      const reports = createPreviewReports(database, () => now)
      for (const item of (await reports.list('left')).items) {
        expect(item.summary.reviewable).toBe(true)
        await reports.review({ side: 'left', id: item.summary.id, digest: item.summary.digest,
          expectedReviewId: null, outcome: 'reviewed', confirmedActualNight: true, note: 'Synthetic fixture review' })
      }
      const audit = thermalDatasetAudit(database, 'left', now)
      expect(audit.recordings).toHaveLength(24)
      expect(audit.recordings.every(recording => recording.samples.length === 96)).toBe(true)
      expect(audit.recordings.every(recording => recording.samples.every(sample => sample.at % 300_000 === 240_000))).toBe(true)
      const before = store.read('left')
      const readiness = registry.status('left')
      expect(readiness).toMatchObject({ canTrain: true, completeNights: 24 })
      const fitted = registry.train('left', readiness.datasetHash)
      expect(fitted.model?.current).toBe(true)
      expect(fitted.model?.horizons.every(horizon => horizon.validation.passes)).toBe(true)
      expect(createThermalForecasts(database, () => now).status('left').model?.id).toBe(fitted.model?.id)
      expect(registry.status('right').model).toBeNull()
      expect(store.read('left')).toEqual(before)
      database.prepare('UPDATE comfort_events SET event=json_set(event, \'$.message\', \'Edited after review\') WHERE observed_at=? AND side=\'left\'').run(recordings[0].samples[0].at)
      expect(registry.status('left').model?.current).toBe(false)
      expect(registry.status('left').completeNights).toBe(23)
    }
    finally { database.close() }
  }, 30_000)
})

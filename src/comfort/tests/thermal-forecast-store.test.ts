import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from './databaseFixture'
import { forecastRecordings } from './forecastFixture'
import type { ThermalDatasetAudit } from '../thermal-dataset'

const source = vi.hoisted(() => ({ audit: null as ThermalDatasetAudit | null }))
vi.mock('../thermal-dataset', () => ({ thermalDatasetAudit: () => structuredClone(source.audit) }))
const { createThermalForecasts } = await import('../thermal-forecast-store')
const databases: ReturnType<typeof migratedComfortDatabase>[] = []
const now = Date.parse('2026-11-01')
afterEach(() => databases.splice(0).forEach(database => database.close()))
function audit(count = 24): ThermalDatasetAudit {
  const recordings = forecastRecordings(count)
  return { recordings, nights: [], collection: { feedbackNights: count, excluded: [], policy: 'complete-reviewed-nights-v1' },
    proofs: recordings.map((recording, index) => ({ date: recording.date, configuration: 'b'.repeat(64), reportId: String(index).padStart(64, '0'), digest: 'c'.repeat(64), reviewId: index + 1 })) }
}
beforeEach(() => {
  source.audit = audit()
})
function fixture() {
  const database = migratedComfortDatabase()
  databases.push(database)
  return { database, models: createThermalForecasts(database, () => now) }
}

describe('private water forecast registry', () => {
  it('viewing is inert and explicit fitting persists an artifact without changing controls', () => {
    const { database, models } = fixture()
    const status = models.status('left')
    expect(status).toMatchObject({ completeNights: 24, canTrain: true, model: null })
    expect(models.train('left', status.datasetHash).model).toMatchObject({ current: true, mode: 'research_preview' })
    models.train('left', status.datasetHash)
    expect(database.prepare('SELECT COUNT(*) AS count FROM thermal_forecasts').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM comfort_states').get()).toEqual({ count: 0 })
    expect(models.status('right').model).toBeNull()
    expect(createThermalForecasts(database, () => now).status('left').model?.current).toBe(true)
  })
  it('new nights preserve an unchanged reference model, but edited or deleted references invalidate it', () => {
    const { models } = fixture()
    const before = models.status('left')
    models.train('left', before.datasetHash)
    source.audit = audit(25)
    expect(models.status('left').model?.current).toBe(true)
    expect(() => models.train('left', before.datasetHash)).toThrow(/changed/)
    source.audit.proofs[0].digest = 'd'.repeat(64)
    expect(models.status('left').model?.current).toBe(false)
    source.audit = audit()
    source.audit.recordings.shift()
    expect(models.status('left').model?.current).toBe(false)
  })
  it('rejects incomplete cohorts, different configurations and artifact corruption', () => {
    const { database, models } = fixture()
    models.train('left', models.status('left').datasetHash)
    source.audit = audit(19)
    expect(models.status('left').canTrain).toBe(false)
    expect(() => models.train('left', models.status('left').datasetHash)).toThrow(/Twenty/)
    source.audit = audit()
    source.audit.proofs[0].configuration = 'e'.repeat(64)
    expect(models.status('left').completeNights).toBe(23)
    expect(models.preview('left', null, 'f'.repeat(64)).predictions).toEqual([])
    database.prepare('UPDATE thermal_forecasts SET record = json_set(record, \'$.model.horizons[0].coefficients[0]\', 100)').run()
    expect(() => models.status('left')).toThrow(/integrity/)
  })
  it('withholds future and stale artifacts', () => {
    const { database, models } = fixture()
    models.train('left', models.status('left').datasetHash)
    expect(createThermalForecasts(database, () => now - 1).status('left').model?.current).toBe(false)
    expect(createThermalForecasts(database, () => now + 46 * 86_400_000).status('left').model?.current).toBe(false)
  })
})

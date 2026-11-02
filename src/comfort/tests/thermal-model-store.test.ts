import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from './databaseFixture'
import type { ThermalDatasetAudit } from '../thermal-dataset'

const source = vi.hoisted(() => ({ audit: null as ThermalDatasetAudit | null }))
vi.mock('../thermal-dataset', () => ({ thermalDatasetAudit: () => structuredClone(source.audit) }))
const { createThermalModels } = await import('../thermal-model-store')
const databases: ReturnType<typeof migratedComfortDatabase>[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
beforeEach(() => {
  source.audit = {
    recordings: [],
    nights: Array.from({ length: 24 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`,
      targetF: 70, waterF: 71, humidity: 45, roomF: index % 2 ? 76 : 68, correction: index % 2 ? -1 : 1 })),
    proofs: Array.from({ length: 24 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`,
      reportId: String(index).padStart(64, '0'), digest: 'a'.repeat(64), reviewId: index + 1, configuration: 'b'.repeat(64) })),
    collection: { feedbackNights: 24, excluded: [], policy: 'complete-reviewed-nights-v1' },
  }
})
function fixture() {
  const database = migratedComfortDatabase()
  databases.push(database)
  return { database, models: createThermalModels(database, () => Date.parse('2026-11-01T12:00:00Z')) }
}
function audit() {
  if (!source.audit) throw new Error('Test audit is unavailable')
  return source.audit
}

describe('durable thermal model registry', () => {
  it('viewing readiness never trains; an explicit fit persists once and survives a new service instance', () => {
    const { database, models } = fixture()
    const before = models.status('left')
    expect(before).toMatchObject({ completeNights: 24, canTrain: true, model: null })
    const after = models.train('left', before.datasetHash)
    expect(after.model).toMatchObject({ current: true, mode: 'research_preview', validation: { passesFeedbackCheck: true } })
    expect(createThermalModels(database).status('left').model?.id).toBe(after.model?.id)
    models.train('left', before.datasetHash)
    expect(database.prepare('SELECT COUNT(*) AS count FROM comfort_models').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM comfort_states').get()).toEqual({ count: 0 })
    expect(models.preview('left', { targetF: 70, waterF: 71, roomF: 68, humidity: 45 }, 'b'.repeat(64)).offsetF).toBe(1)
  })
  it('source edits, review changes and wrong configurations invalidate a model and stale requests', () => {
    const { models } = fixture()
    const before = models.status('left')
    models.train('left', before.datasetHash)
    expect(models.preview('left', audit().nights[0], 'c'.repeat(64)).offsetF).toBeNull()
    audit().proofs[0].digest = 'd'.repeat(64)
    expect(models.status('left').model?.current).toBe(false)
    expect(models.preview('left', audit().nights[0], 'b'.repeat(64)).offsetF).toBeNull()
    expect(() => models.train('left', before.datasetHash)).toThrow(/changed/)
  })
  it('keeps sides isolated, refuses insufficient complete nights and excludes older configurations', () => {
    const { models } = fixture()
    models.train('left', models.status('left').datasetHash)
    expect(models.status('right').model).toBeNull()
    audit().proofs.slice(0, 10).forEach((proof) => {
      proof.configuration = 'e'.repeat(64)
    })
    const current = models.status('left')
    expect(current).toMatchObject({ completeNights: 14, canTrain: false })
    expect(current.excluded).toHaveLength(10)
    expect(() => models.train('left', current.datasetHash)).toThrow(/Twenty complete/)
  })
  it('fails visibly on corrupted artifacts instead of accepting modified validation results', () => {
    const { database, models } = fixture()
    models.train('left', models.status('left').datasetHash)
    database.prepare('UPDATE comfort_models SET record = json_set(record, \'$.coefficients[0]\', 100)').run()
    expect(() => models.status('left')).toThrow(/integrity/)
    expect(() => models.preview('left', audit().nights[0], 'b'.repeat(64))).toThrow(/integrity/)
  })
  it('refuses a model from the future after a controller clock rollback', () => {
    const { database, models } = fixture()
    models.train('left', models.status('left').datasetHash)
    const earlier = createThermalModels(database, () => Date.parse('2026-10-31T12:00:00Z'))
    expect(earlier.status('left').model?.current).toBe(false)
    expect(earlier.preview('left', { targetF: 70, waterF: 71, roomF: 68, humidity: 45 }, 'b'.repeat(64)).offsetF).toBeNull()
    expect(() => earlier.train('left', earlier.status('left').datasetHash)).toThrow(/clock/)
  })
})

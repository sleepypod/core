import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Side } from '@/src/hardware/types'
import { createResponseModels } from '../response-model-store'
import { responseEvidenceHash, type ResponseEvidence } from '../response-audit'
import { RESPONSE_POLICY } from '../response-contract'
import { migratedComfortDatabase } from './databaseFixture'
import { responseModelWindows } from './responseModelFixture'

const now = Date.UTC(2026, 9, 22, 22), configuration = 'b'.repeat(64)
const databases: ReturnType<typeof migratedComfortDatabase>[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
function evidence(windows = responseModelWindows(), side: Side = 'left'): ResponseEvidence {
  const references = windows.map(window => ({ window, sourceHash: 'c'.repeat(64) }))
  const count = new Set(windows.map(window => window.date)).size
  return { configuration, windows: references,
    audit: { apiVersion: 1, policy: RESPONSE_POLICY, generatedAt: now, side, attribution: 'physical_zone_only',
      status: 'read', reviewedNights: count, responseNights: count,
      coolingWindows: windows.filter(window => window.requestedTargetF < window.previousTargetF).length,
      warmingWindows: windows.filter(window => window.requestedTargetF > window.previousTargetF).length,
      requiredNights: 20, datasetHash: responseEvidenceHash(side, configuration, references),
      modelAvailable: false, activationAvailable: false, exclusions: [], exclusionsTruncated: false, reason: 'Synthetic fixture' } }
}
function fixture() {
  const database = migratedComfortDatabase()
  databases.push(database)
  const source = { value: evidence(), now }
  const read = vi.fn((_database, _biometrics, side: Side, clock: number) => {
    const result = side === 'left' ? structuredClone(source.value) : evidence([], side)
    result.audit.generatedAt = clock
    return result
  })
  const models = createResponseModels(database, database, () => source.now, read)
  return { database, source, read, models }
}

describe('durable target-response research registry', () => {
  it('canonicalizes window order and object keys without ignoring changed evidence', () => {
    const source = evidence()
    const reordered = [...source.windows].reverse().map(item => ({ ...item,
      window: Object.fromEntries(Object.entries(item.window).reverse()) as typeof item.window }))
    expect(responseEvidenceHash('left', configuration, reordered)).toBe(source.audit.datasetHash)
    reordered[0].sourceHash = 'd'.repeat(64)
    expect(responseEvidenceHash('left', configuration, reordered)).not.toBe(source.audit.datasetHash)
  })
  it('keeps reads inert and explicit training idempotent, private to the physical side', () => {
    const { database, models, read } = fixture()
    const before = database.prepare('SELECT total_changes() AS count').get()
    const status = models.status('left')
    expect(status).toMatchObject({ model: null, canTrain: true, completeNights: 20, activationAvailable: false })
    expect(database.prepare('SELECT total_changes() AS count').get()).toEqual(before)
    expect(models.train('left', status.datasetHash).model).toMatchObject({ current: true, mode: 'research_preview', attribution: 'physical_zone_only' })
    models.train('left', status.datasetHash)
    expect(database.prepare('SELECT COUNT(*) AS count FROM target_response_models').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM comfort_states').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM temperature_applications').get()).toEqual({ count: 0 })
    expect(models.status('right').model).toBeNull()
    const restored = createResponseModels(database, database, () => now, read).status('left')
    expect(restored.model?.current).toBe(true)
    expect(restored.model).not.toHaveProperty('support')
    expect(restored.model?.horizons[0]).not.toHaveProperty('coefficients')
  })

  it('keeps unchanged references current when a new night arrives, but rejects the old fit token', () => {
    const { models, source } = fixture()
    const status = models.status('left')
    models.train('left', status.datasetHash)
    const latest = structuredClone(source.value.windows.at(-1)?.window)
    if (!latest) throw new Error('Fixture missing')
    latest.date = '2026-10-22'
    latest.attemptId = 'd0803244-c9ca-45bd-91ee-c77ab3a3c185'
    for (const key of ['at', 'beforeAt', 'contextAt', 'acknowledgedAt', 'confirmationAt'] as const) latest[key] += 86_400_000
    for (const result of latest.outcomes) result.at += 86_400_000
    source.value = evidence([...source.value.windows.map(item => item.window), latest])
    expect(models.status('left').model?.current).toBe(true)
    expect(() => models.train('left', status.datasetHash)).toThrow(/changed/)
    source.value.windows[0].sourceHash = 'd'.repeat(64)
    source.value.audit.datasetHash = responseEvidenceHash('left', configuration, source.value.windows)
    expect(models.status('left').model?.current).toBe(false)
  })

  it('withdraws removed references, changed configuration and incomplete source reads', () => {
    const { models, source } = fixture()
    models.train('left', models.status('left').datasetHash)
    const original = structuredClone(source.value)
    source.value = evidence(source.value.windows.slice(4).map(item => item.window))
    expect(models.status('left')).toMatchObject({ canTrain: false, model: { current: false } })
    source.value = structuredClone(original)
    source.value.configuration = 'd'.repeat(64)
    source.value.audit.datasetHash = responseEvidenceHash('left', source.value.configuration, source.value.windows)
    expect(models.status('left').model?.current).toBe(false)
    source.value = structuredClone(original)
    source.value.audit.status = 'partial'
    expect(models.status('left')).toMatchObject({ canTrain: false, model: { current: false } })
    expect(() => models.train('left', source.value.audit.datasetHash)).toThrow(/complete evidence read/)
    expect(models.preview('left', null, configuration).predictions).toEqual([])
  })

  it('rechecks evidence under the save transaction and leaves no artifact after a race', () => {
    const { database, models, read, source } = fixture()
    const expected = source.value.audit.datasetHash, original = structuredClone(source.value)
    const changed = evidence(source.value.windows.slice(4).map(item => item.window))
    read.mockReturnValueOnce(original).mockReturnValueOnce(changed)
    expect(() => models.train('left', expected)).toThrow(/changed before saving/)
    expect(database.prepare('SELECT COUNT(*) AS count FROM target_response_models').get()).toEqual({ count: 0 })
  })

  it('rejects an evidence payload with a mismatched identity or digest', () => {
    const { models, source } = fixture()
    source.value.audit.side = 'right'
    expect(() => models.status('left')).toThrow(/identity/)
    source.value.audit.side = 'left'
    source.value.audit.datasetHash = 'f'.repeat(64)
    expect(() => models.status('left')).toThrow(/identity/)
  })

  it('checks artifact integrity before reading predictions or fitting another model', () => {
    const { database, models } = fixture()
    models.train('left', models.status('left').datasetHash)
    database.prepare('UPDATE target_response_models SET record=json_set(record,\'$.model.horizons[0].coefficients[0]\',100)').run()
    expect(() => models.status('left')).toThrow(/integrity/)
    expect(() => models.preview('left', null, configuration)).toThrow(/integrity/)
  })

  it('bounds stored payload reads and withdraws future or expired artifacts', () => {
    const { database, models, source } = fixture()
    models.train('left', models.status('left').datasetHash)
    source.now = now - 1
    expect(models.status('left').model?.current).toBe(false)
    expect(() => models.train('left', source.value.audit.datasetHash)).toThrow(/clock/)
    source.now = now + 31 * 86_400_000
    expect(models.status('left').model?.current).toBe(false)
    database.prepare('UPDATE target_response_models SET record=?').run('x'.repeat(8 * 1024 ** 2 + 1))
    expect(() => models.status('left')).toThrow(/read limit/)
  })

  it('uses only matching live configuration for research predictions', () => {
    const { models, source } = fixture()
    const window = source.value.windows[0].window
    const input = { observedAt: now, previousTargetF: window.previousTargetF, requestedTargetF: window.requestedTargetF,
      waterBeforeF: window.waterBeforeF, waterChange5mF: window.waterChange5mF, roomF: window.roomF, humidity: window.humidity }
    models.train('left', models.status('left').datasetHash)
    expect(models.preview('left', input, configuration).predictions).toHaveLength(2)
    expect(models.preview('left', input, 'f'.repeat(64)).predictions).toEqual([])
    expect(models.preview('right', input, configuration).predictions).toEqual([])
  })
  it('retains only three research artifacts per side without deleting source records', () => {
    const { database, models, source } = fixture()
    const identifiers: string[] = []
    for (const version of ['1', '2', '3', '4']) {
      source.value.windows[0].sourceHash = version.repeat(64)
      source.value.audit.datasetHash = responseEvidenceHash('left', configuration, source.value.windows)
      const result = models.train('left', source.value.audit.datasetHash)
      if (!result.model) throw new Error('Expected an inert artifact')
      identifiers.push(result.model.id)
    }
    const rows = database.prepare('SELECT id FROM target_response_models ORDER BY rowid').all() as Array<{ id: string }>
    expect(rows.map(row => row.id)).toEqual(identifiers.slice(1))
    expect(source.value.windows).toHaveLength(80)
    expect(database.prepare('SELECT COUNT(*) AS count FROM thermal_forecasts').get()).toEqual({ count: 0 })
  })
  it('uses one bounded evidence read for both candidate targets', () => {
    const { models, read } = fixture()
    read.mockClear()
    expect(models.compare('left', [null, null], configuration)).toHaveLength(2)
    expect(read).toHaveBeenCalledTimes(1)
    expect(() => models.compare('left', [null, null, null], configuration)).toThrow(/two/)
    expect(read).toHaveBeenCalledTimes(1)
  })
})

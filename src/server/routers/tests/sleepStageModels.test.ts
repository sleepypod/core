import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as mainSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { stageModelSchema } from '@/src/lib/personal-stage-model'
import { DEFAULT_STAGE_RULESET } from '@/src/lib/sleep-stage-rules'
import { stageNight } from '@/src/biometrics/stage-night'

const holder = vi.hoisted(() => ({ main: null as unknown, bio: null as unknown }))
vi.mock('@/src/db', () => ({
  get db() { return holder.main },
  get biometricsDb() { return holder.bio },
}))
const { sleepStagesRouter } = await import('../sleepStages')
const { loadActiveStageModel } = await import('@/src/biometrics/stage-model-store')
const caller = sleepStagesRouter.createCaller({})

function candidate(version = 'candidate', stage = 1) {
  return stageModelSchema.parse({ version, kind: 'forest', classes: ['wake', 'light', 'deep', 'rem'],
    featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction'],
    trees: [{ f: [-1], t: [0], l: [-1], r: [-1], v: [[0, 0, 0, 0].map((_, index) => index === stage ? 1 : 0)] }],
    metrics: { nestedSelection: { kappa: 0.4, nights: 8 }, notes: 'Synthetic fixture, not a clinical score' },
    testVectors: [{ inputs: { hrZ: 0, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: stage }],
  })
}

let configRaw: Database.Database, bioRaw: Database.Database
let bio: ReturnType<typeof drizzle<typeof bioSchema>>
beforeEach(() => {
  configRaw = new Database(':memory:')
  const config = drizzle(configRaw, { schema: mainSchema })
  migrate(config, { migrationsFolder: path.resolve('src/db/migrations') })
  config.insert(mainSchema.sideSettings).values([{ side: 'left', name: 'Left' }, { side: 'right', name: 'Right' }]).run()
  holder.main = config
  bioRaw = new Database(':memory:')
  bio = drizzle(bioRaw, { schema: bioSchema })
  migrate(bio, { migrationsFolder: path.resolve('src/db/biometrics-migrations') })
  holder.bio = bio
})
afterEach(() => {
  configRaw.close()
  bioRaw.close()
})

function seedNight() {
  const start = new Date('2026-10-01T22:00:00Z')
  const end = new Date(start.getTime() + 3600000)
  const record = bio.insert(bioSchema.sleepRecords).values({ side: 'left', enteredBedAt: start, leftBedAt: end,
    sleepDurationSeconds: 3600, timesExitedBed: 0, presentIntervals: [], notPresentIntervals: [] }).returning().get()
  const samples = Array.from({ length: 12 }, (_, index) => ({ side: 'left' as const,
    timestamp: new Date(start.getTime() + index * 300000), heartRate: 60 + index % 2, hrv: 40, breathingRate: 14 }))
  bio.insert(bioSchema.vitals).values(samples).run()
  return { record, start, end, samples }
}

describe('personal stage model lifecycle', () => {
  it('saves candidates without selecting or activating, preserving full metadata', async () => {
    const model = candidate()
    await caller.uploadModel({ side: 'left', model })
    expect(await caller.getModel({ side: 'left' })).toMatchObject({ model: null, active: false })
    expect(await caller.listModels({ side: 'left' })).toMatchObject([{ selected: false, active: false, metrics: model.metrics }])
    expect(await caller.listModels({ side: 'right' })).toEqual([])
  })

  it('deduplicates semantic JSON but distinguishes artifacts sharing a display version', async () => {
    const model = candidate()
    const first = await caller.uploadModel({ side: 'left', model })
    const reordered = Object.fromEntries(Object.entries(model).reverse()) as typeof model
    expect(await caller.uploadModel({ side: 'left', model: reordered })).toEqual(first)
    const second = await caller.uploadModel({ side: 'left', model: candidate('candidate', 2) })
    expect(second.id).not.toBe(first.id)
    expect(await caller.listModels({ side: 'left' })).toHaveLength(2)
  })

  it('requires side-owned explicit selection and leaves an active selection untouched by a new candidate', async () => {
    const first = await caller.uploadModel({ side: 'left', model: candidate() })
    await expect(caller.selectModel({ side: 'right', id: first.id, active: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await caller.selectModel({ side: 'left', id: first.id, active: true })
    await caller.uploadModel({ side: 'left', model: candidate('later', 2) })
    expect(await caller.getModel({ side: 'left' })).toMatchObject({ active: true, model: { version: 'candidate' } })
    expect(loadActiveStageModel('right')).toBeNull()
  })

  it('legacy replacement always disables activation and retains the earlier library candidate', async () => {
    await caller.setModel({ side: 'left', model: candidate() })
    await caller.setModelActive({ side: 'left', active: true })
    await caller.setModel({ side: 'left', model: candidate('replacement', 2) })
    expect(await caller.getModel({ side: 'left' })).toMatchObject({ active: false, model: { version: 'replacement' } })
    expect(await caller.listModels({ side: 'left' })).toHaveLength(2)
    expect(loadActiveStageModel('left')).toBeNull()
  })

  it('rejects bad vectors and unknown contracts before any model is stored', async () => {
    const wrong = candidate()
    wrong.testVectors[0].expected = 3
    await expect(caller.uploadModel({ side: 'left', model: wrong })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const unknown = candidate()
    unknown.featureContract[0] = 'unavailable'
    unknown.testVectors[0].inputs.unavailable = 0
    await expect(caller.uploadModel({ side: 'left', model: unknown })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(await caller.listModels({ side: 'left' })).toEqual([])
  })

  it('rechecks disk content and self-tests before activation or inference', async () => {
    await caller.setModel({ side: 'left', model: candidate() })
    await caller.setModelActive({ side: 'left', active: true })
    configRaw.prepare('UPDATE side_stage_models SET model_hash = \'corrupt\' WHERE side = \'left\'').run()
    expect(loadActiveStageModel('left')).toBeNull()
    expect(await caller.getModel({ side: 'left' })).toMatchObject({ model: null, active: false })
    await expect(caller.setModelActive({ side: 'left', active: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await caller.setModelActive({ side: 'left', active: false })
    expect(configRaw.prepare('SELECT active FROM side_stage_models WHERE side=\'left\'').get()).toEqual({ active: 0 })
  })

  it('refuses a corrupted library row and clears selection without deleting saved candidates', async () => {
    const saved = await caller.uploadModel({ side: 'left', model: candidate() })
    await caller.selectModel({ side: 'left', id: saved.id, active: true })
    await caller.setModel({ side: 'left', model: null })
    expect(await caller.listModels({ side: 'left' })).toHaveLength(1)
    configRaw.prepare('UPDATE stage_model_library SET model_hash=\'corrupt\'').run()
    expect(await caller.listModels({ side: 'left' })).toEqual([])
    await expect(caller.selectModel({ side: 'left', id: saved.id, active: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('isolates malformed stored JSON so valid library rows and rules fallback remain available', async () => {
    const broken = await caller.uploadModel({ side: 'left', model: candidate('broken') })
    await caller.selectModel({ side: 'left', id: broken.id, active: true })
    await caller.uploadModel({ side: 'left', model: candidate('intact') })
    configRaw.prepare('UPDATE side_stage_models SET model = ?').run('{broken')
    configRaw.prepare('UPDATE stage_model_library SET model = ? WHERE id = ?').run('{broken', broken.id)
    expect(loadActiveStageModel('left')).toBeNull()
    expect(await caller.getModel({ side: 'left' })).toMatchObject({ model: null, active: false })
    expect(await caller.listModels({ side: 'left' })).toMatchObject([{ version: 'intact', active: false }])
    await expect(caller.selectModel({ side: 'left', id: broken.id, active: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await caller.setModelActive({ side: 'left', active: false })
    expect(configRaw.prepare('SELECT active FROM side_stage_models').get()).toEqual({ active: 0 })
  })

  it('previews the same recorded window without selecting, saving, or claiming Watch agreement', async () => {
    const night = seedNight()
    const result = await caller.previewModel({ side: 'left', model: candidate(), sleepRecordId: night.record.id })
    expect(result.nights).toHaveLength(1)
    expect(result.nights[0]).toMatchObject({ sleepRecordId: night.record.id, agreement: null, rulesAgreement: null })
    expect(result.nights[0].blocks).toEqual([{ start: night.start.getTime(), end: night.end.getTime(), stage: 'light' }])
    expect(await caller.listModels({ side: 'left' })).toEqual([])
    expect(await caller.getModel({ side: 'left' })).toMatchObject({ model: null, active: false })
    await expect(caller.previewModel({ side: 'right', model: candidate(), sleepRecordId: night.record.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('previews a library candidate without changing the active selection and rejects a cross-side id', async () => {
    const night = seedNight()
    await caller.setModel({ side: 'left', model: candidate('active') })
    await caller.setModelActive({ side: 'left', active: true })
    const saved = await caller.uploadModel({ side: 'left', model: candidate('candidate', 2) })
    const preview = await caller.previewModel({ side: 'left', modelId: saved.id, sleepRecordId: night.record.id })
    expect(preview.version).toBe('candidate')
    expect(await caller.getModel({ side: 'left' })).toMatchObject({ active: true, model: { version: 'active' } })
    await expect(caller.previewModel({ side: 'right', modelId: saved.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(caller.previewModel({ side: 'left', modelId: saved.id, model: candidate() })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('reports the actual classifier and hash, with explicit rule fallback on failed inference', () => {
    const night = seedNight()
    const model = candidate()
    const result = stageNight(night.samples, [], 1, DEFAULT_STAGE_RULESET, model, night)
    expect(result.stagedBy).toMatchObject({ engine: 'model', version: model.version, reason: 'active_model' })
    expect(result.stagedBy.modelHash).toMatch(/^[a-f0-9]{64}$/)
    const failed = stageNight(night.samples, [], 1, DEFAULT_STAGE_RULESET, { ...model, featureContract: ['unsupported'] }, night)
    expect(failed.epochs.length).toBeGreaterThan(0)
    expect(failed.stagedBy).toEqual({ engine: 'rules', version: null, modelHash: null, reason: 'model_evaluation_failed' })
  })
})

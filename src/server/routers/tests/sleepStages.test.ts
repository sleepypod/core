/**
 * sleepStages router against real in-memory sleepypod.db and biometrics.db
 * with migrations applied: the stored classifier round-trips through the
 * side_settings JSON column, and the preview classifies a stored night.
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TRPCError } from '@trpc/server'
import * as mainSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { writeLegacyStageClassifier } from '@/src/biometrics/profiles/legacy-stage'
import { deliverRuntimeOutbox } from '@/src/biometrics/profiles/runtime'
import {
  DEFAULT_STAGE_CLASSIFIER,
  DEFAULT_STAGE_RULESET,
  MOVEMENT_ONLY_STAGE_RULESET,
  type StageClassifier,
} from '@/src/lib/sleep-stage-rules'

const dbHolder = vi.hoisted(() => ({ main: null as unknown, bio: null as unknown }))

vi.mock('@/src/db', () => ({
  get db() { return dbHolder.main },
  get biometricsDb() { return dbHolder.bio },
}))

const { sleepStagesRouter, loadStageClassifier } = await import('@/src/server/routers/sleepStages')
const caller = sleepStagesRouter.createCaller({})

const MIN = 60_000
// 2026-10-10 23:00:00 UTC
const BED = new Date(Date.UTC(2026, 9, 10, 23))
const at = (minutes: number) => new Date(BED.getTime() + minutes * MIN)

const movementOnly: StageClassifier = { engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }

/** Await a procedure expected to reject, returning the TRPCError for
 * code/message assertions. */
async function rejectionOf(promise: Promise<unknown>): Promise<TRPCError> {
  try {
    await promise
  }
  catch (error) {
    return error as TRPCError
  }
  throw new Error('expected the call to reject')
}

/** A stand-in db whose first query throws `error`, for the catch blocks. */
function throwing(error: unknown) {
  return {
    select: () => {
      throw error
    },
  }
}

describe('sleepStages router', () => {
  let mainRaw: Database.Database
  let bioRaw: Database.Database
  let bio: ReturnType<typeof drizzle<typeof bioSchema>>

  beforeEach(() => {
    mainRaw = new Database(':memory:')
    const main = drizzle(mainRaw, { schema: mainSchema })
    migrate(main, { migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations') })
    main.insert(mainSchema.sideSettings).values([
      { side: 'left', name: 'Left' },
      { side: 'right', name: 'Right' },
    ]).run()
    dbHolder.main = main

    bioRaw = new Database(':memory:')
    bio = drizzle(bioRaw, { schema: bioSchema })
    migrate(bio, { migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations') })
    dbHolder.bio = bio
  })

  afterEach(() => {
    mainRaw.close()
    bioRaw.close()
  })

  /** One 60-minute night: HR dips in the middle 20 minutes, calm movement. */
  function seedNight(side: 'left' | 'right' = 'left', startMinutes = 0) {
    const at = (minutes: number) => new Date(BED.getTime() + (startMinutes + minutes) * MIN)
    const [record] = bio.insert(bioSchema.sleepRecords).values({
      side,
      enteredBedAt: at(0),
      leftBedAt: at(60),
      sleepDurationSeconds: 3600,
      timesExitedBed: 0,
      presentIntervals: [],
      notPresentIntervals: [],
    }).returning().all()
    const hrs = [70, 70, 70, 70, 60, 60, 60, 60, 70, 70, 70, 70]
    bio.insert(bioSchema.vitals).values(hrs.map((heartRate, i) => ({
      side, timestamp: at(i * 5), heartRate, hrv: 60, breathingRate: 14,
    }))).run()
    bio.insert(bioSchema.movement).values(hrs.map((_, i) => ({ side, timestamp: at(i * 5), totalMovement: 10 }))).run()
    return record
  }

  describe('getClassifier', () => {
    it('reports the defaults for a side with nothing stored', async () => {
      const out = await caller.getClassifier({ side: 'left' })
      expect(out.classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
      expect(out.isDefault).toBe(true)
      expect(out.engines.map(e => e.id)).toEqual(['rules'])
      expect(out.presets.map(p => p.id)).toEqual(['default', 'movementOnly', 'hrvFirst'])
    })

    it('falls back to the defaults when the stored value no longer validates', async () => {
      mainRaw.prepare('UPDATE side_settings SET stage_classifier = ? WHERE side = ?').run(JSON.stringify({ engine: 'neural' }), 'left')
      const out = await caller.getClassifier({ side: 'left' })
      expect(out.classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
      expect(out.isDefault).toBe(true)
    })

    it('resolves a recorded "before" that no longer validates to the defaults', async () => {
      mainRaw.prepare('INSERT INTO stage_classifier_changes (side, before, after, summary) VALUES (?, ?, ?, ?)')
        .run('left', JSON.stringify({ engine: 'neural' }), null, 'Reset to default')
      const { changes } = await caller.getClassifier({ side: 'left' })
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ summary: 'Reset to default', before: DEFAULT_STAGE_CLASSIFIER, agreementBefore: null, agreementAfter: null })
    })

    it('wraps unexpected failures as INTERNAL_SERVER_ERROR', async () => {
      dbHolder.main = throwing(new Error('disk gone'))
      const error = await rejectionOf(caller.getClassifier({ side: 'left' }))
      expect(error.code).toBe('INTERNAL_SERVER_ERROR')
      expect(error.message).toBe('Failed to load stage classifier: disk gone')
    })

    it('falls back to "Unknown error" for non-Error throws', async () => {
      dbHolder.main = throwing('not an Error instance')
      const error = await rejectionOf(caller.getClassifier({ side: 'left' }))
      expect(error.message).toBe('Failed to load stage classifier: Unknown error')
    })
  })

  describe('setClassifier', () => {
    it('stores a classifier per side and resets with null', async () => {
      const saved = await caller.setClassifier({ side: 'right', classifier: movementOnly })
      expect(saved).toMatchObject({ classifier: movementOnly, isDefault: false, activation: { generation: 1, state: 'pending_delivery' } })
      expect((await caller.getClassifier({ side: 'right' })).classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
      deliverRuntimeOutbox(dbHolder.main as ReturnType<typeof drizzle<typeof mainSchema>>, bio)
      const projected = bio.select().from(bioSchema.biometricRuntimeConfigs).get()
      if (!projected) throw new Error('Missing runtime projection')
      for (const component of ['heart_rate', 'breathing_rate', 'hrv_index']) bio.insert(bioSchema.biometricRuntimeReceipts).values({
        side: 'right', component, generation: 1, appliedHash: projected.resolvedHash, effectiveSampleTimeMs: BED.getTime(), state: 'applied', heartbeatAtMs: Date.now(),
      }).run()
      const applied = await caller.getClassifier({ side: 'right' })
      expect(applied.classifier).toEqual(movementOnly)
      expect(applied.provenance.generation).toBe(1)
      expect((await caller.getClassifier({ side: 'left' })).isDefault).toBe(true)
      expect(await loadStageClassifier('right')).toEqual(movementOnly)
      expect(await caller.setClassifier({ side: 'right', classifier: null })).toMatchObject({ classifier: DEFAULT_STAGE_CLASSIFIER, isDefault: true, activation: { generation: 2 } })
      expect(mainRaw.prepare('SELECT stage_classifier FROM side_settings WHERE side = ?').get('right')).toEqual({ stage_classifier: null })
    })

    it('rejects an invalid ruleset at the boundary', async () => {
      const bad = { engine: 'rules', ruleset: { ...DEFAULT_STAGE_RULESET, outliers: { ...DEFAULT_STAGE_RULESET.outliers, heartRate: { min: 130, max: 45 } } } }
      await expect(caller.setClassifier({ side: 'left', classifier: bad as StageClassifier })).rejects.toThrow(/min must be less than or equal to max/)
    })

    it('records each save with a summary and lists recent changes, latest first', async () => {
      seedNight()
      bio.insert(bioSchema.referenceStages).values({ side: 'left', source: 'apple_watch', start: BED, end: at(60), stage: 'light' }).run()
      expect((await caller.getClassifier({ side: 'left' })).changes).toEqual([])

      await caller.setClassifier({ side: 'left', classifier: movementOnly })
      let changes = (await caller.getClassifier({ side: 'left' })).changes
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ summary: 'Removed rule 2: Deep +4 more', before: null, agreementAfter: 1 })
      expect(changes[0].agreementBefore).toBeLessThan(1)

      // Saving the same thing again records nothing.
      await caller.setClassifier({ side: 'left', classifier: movementOnly })
      expect((await caller.getClassifier({ side: 'left' })).changes).toHaveLength(1)

      await caller.setClassifier({ side: 'left', classifier: null })
      changes = (await caller.getClassifier({ side: 'left' })).changes
      expect(changes).toHaveLength(2)
      expect(changes[0]).toMatchObject({ summary: 'Reset to default', before: movementOnly })
      expect(changes[0].changedAt).toBeGreaterThanOrEqual(changes[1].changedAt)
      expect((await caller.getClassifier({ side: 'right' })).changes).toEqual([])
    })

    it('rejects with CONFLICT and writes nothing when another save lands first', async () => {
      // The agreement lookups read biometrics.db between the first read and
      // the write; a save that slips in there must not be overwritten.
      const realBio = dbHolder.bio as { select: (...args: unknown[]) => unknown }
      let raced = false
      dbHolder.bio = new Proxy(realBio, {
        get(target, prop, receiver) {
          if (prop === 'select' && !raced) {
            raced = true
            mainRaw.prepare('UPDATE side_settings SET stage_classifier = ? WHERE side = ?').run(JSON.stringify(DEFAULT_STAGE_CLASSIFIER), 'left')
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      const error = await rejectionOf(caller.setClassifier({ side: 'left', classifier: movementOnly }))
      expect(error.code).toBe('CONFLICT')
      expect(error.message).toBe('Stage classifier for left changed during save; reload and try again')
      expect((await caller.getClassifier({ side: 'left' })).isDefault).toBe(false)
      expect((await caller.getClassifier({ side: 'left' })).classifier).toEqual(DEFAULT_STAGE_CLASSIFIER)
      expect((await caller.getClassifier({ side: 'left' })).changes).toEqual([])
    })

    it('rejects a profile activation that races with agreement calculation', async () => {
      const main = dbHolder.main as ReturnType<typeof drizzle<typeof mainSchema>>
      const realBio = dbHolder.bio as { select: (...args: unknown[]) => unknown }
      let raced = false
      dbHolder.bio = new Proxy(realBio, {
        get(target, prop, receiver) {
          if (prop === 'select' && !raced) {
            raced = true
            writeLegacyStageClassifier(main, 'left', DEFAULT_STAGE_CLASSIFIER)
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      const error = await rejectionOf(caller.setClassifier({ side: 'left', classifier: movementOnly }))
      expect(error.code).toBe('CONFLICT')
      expect(main.select().from(mainSchema.biometricActivationEvents).all()).toHaveLength(1)
      expect(main.select().from(mainSchema.stageClassifierChanges).all()).toHaveLength(0)
    })

    it('rolls back profile intent and outbox if recording the change fails', async () => {
      mainRaw.exec(`CREATE TRIGGER reject_stage_history BEFORE INSERT ON stage_classifier_changes
        BEGIN SELECT RAISE(ABORT, 'history unavailable'); END`)
      const error = await rejectionOf(caller.setClassifier({ side: 'left', classifier: movementOnly }))
      expect(error.message).toContain('history unavailable')
      for (const table of ['biometric_activation_events', 'biometric_config_outbox', 'biometric_profile_revisions']) {
        expect(mainRaw.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
      }
    })

    it('throws NOT_FOUND when the side has no settings row', async () => {
      mainRaw.prepare('DELETE FROM side_settings WHERE side = ?').run('left')
      const error = await rejectionOf(caller.setClassifier({ side: 'left', classifier: movementOnly }))
      expect(error.code).toBe('NOT_FOUND')
      expect(error.message).toBe('Side settings for left not found')
    })

    it('records null agreement when the side has no nights', async () => {
      await caller.setClassifier({ side: 'left', classifier: movementOnly })
      const { changes } = await caller.getClassifier({ side: 'left' })
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ agreementBefore: null, agreementAfter: null })
    })

    it('records null agreement when the latest night has no reference stages', async () => {
      seedNight()
      await caller.setClassifier({ side: 'left', classifier: movementOnly })
      const { changes } = await caller.getClassifier({ side: 'left' })
      expect(changes[0]).toMatchObject({ summary: 'Removed rule 2: Deep +4 more', agreementBefore: null, agreementAfter: null })
    })

    it('records null agreement when the latest night has reference stages but no vitals', async () => {
      bio.insert(bioSchema.sleepRecords).values({
        side: 'left', enteredBedAt: at(0), leftBedAt: at(60), sleepDurationSeconds: 3600, timesExitedBed: 0, presentIntervals: [], notPresentIntervals: [],
      }).run()
      bio.insert(bioSchema.referenceStages).values({ side: 'left', source: 'apple_watch', start: BED, end: at(60), stage: 'light' }).run()
      await caller.setClassifier({ side: 'left', classifier: movementOnly })
      const { changes } = await caller.getClassifier({ side: 'left' })
      expect(changes[0]).toMatchObject({ agreementBefore: null, agreementAfter: null })
    })

    it('treats a stored value that no longer validates as nothing stored', async () => {
      mainRaw.prepare('UPDATE side_settings SET stage_classifier = ? WHERE side = ?').run(JSON.stringify({ engine: 'neural' }), 'left')

      // Resetting records nothing: there was no valid classifier to reset.
      expect(await caller.setClassifier({ side: 'left', classifier: null })).toMatchObject({ classifier: DEFAULT_STAGE_CLASSIFIER, isDefault: true, activation: { generation: 1, state: 'pending_delivery' } })
      expect((await caller.getClassifier({ side: 'left' })).changes).toEqual([])

      // Saving records a change from the defaults, with no "before".
      mainRaw.prepare('UPDATE side_settings SET stage_classifier = ? WHERE side = ?').run(JSON.stringify({ engine: 'neural' }), 'left')
      await caller.setClassifier({ side: 'left', classifier: movementOnly })
      const { changes } = await caller.getClassifier({ side: 'left' })
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ summary: 'Removed rule 2: Deep +4 more', before: null })
    })

    it('wraps unexpected failures as INTERNAL_SERVER_ERROR', async () => {
      dbHolder.main = throwing(new Error('locked'))
      const error = await rejectionOf(caller.setClassifier({ side: 'left', classifier: movementOnly }))
      expect(error.code).toBe('INTERNAL_SERVER_ERROR')
      expect(error.message).toBe('Failed to save stage classifier: locked')
    })

    it('falls back to "Unknown error" for non-Error throws', async () => {
      dbHolder.main = throwing('not an Error instance')
      const error = await rejectionOf(caller.setClassifier({ side: 'left', classifier: null }))
      expect(error.message).toBe('Failed to save stage classifier: Unknown error')
    })
  })

  describe('previewClassifier', () => {
    it('returns empty results when the side has no nights', async () => {
      const out = await caller.previewClassifier({ side: 'left', classifier: movementOnly })
      expect(out).toEqual({ sleepRecordId: null, enteredBedAt: null, leftBedAt: null, nights: 0, hasReference: false, saved: null, candidate: null, changed: null })
    })

    it('throws NOT_FOUND for another side\'s night', async () => {
      const record = seedNight('right')
      const error = await rejectionOf(caller.previewClassifier({ side: 'left', sleepRecordId: record.id, classifier: movementOnly }))
      expect(error.code).toBe('NOT_FOUND')
      expect(error.message).toBe(`Sleep record ${record.id} not found for side 'left'`)
    })

    it('previews one night by id, ignoring `nights`', async () => {
      const older = seedNight('left', -24 * 60)
      seedNight('left')
      const out = await caller.previewClassifier({ side: 'left', sleepRecordId: older.id, nights: 7, classifier: DEFAULT_STAGE_CLASSIFIER })
      expect(out.nights).toBe(1)
      expect(out.sleepRecordId).toBe(older.id)
      expect(out.enteredBedAt).toBe(older.enteredBedAt.getTime())
      expect(out.leftBedAt).toBe(older.leftBedAt.getTime())
      expect(out.candidate?.stats).toMatchObject({ epochs: 12, nights: 1 })
    })

    it('returns null results for a night without vitals', async () => {
      const [record] = bio.insert(bioSchema.sleepRecords).values({
        side: 'left', enteredBedAt: at(0), leftBedAt: at(60), sleepDurationSeconds: 3600, timesExitedBed: 0, presentIntervals: [], notPresentIntervals: [],
      }).returning().all()
      const out = await caller.previewClassifier({ side: 'left', classifier: movementOnly })
      expect(out).toEqual({
        sleepRecordId: record.id,
        enteredBedAt: BED.getTime(),
        leftBedAt: at(60).getTime(),
        nights: 1,
        hasReference: false,
        saved: null,
        candidate: null,
        changed: null,
      })
    })

    it('wraps unexpected failures as INTERNAL_SERVER_ERROR', async () => {
      dbHolder.bio = throwing(new Error('disk gone'))
      const error = await rejectionOf(caller.previewClassifier({ side: 'left', classifier: movementOnly }))
      expect(error.code).toBe('INTERNAL_SERVER_ERROR')
      expect(error.message).toBe('Failed to preview stage classifier: disk gone')
    })

    it('falls back to "Unknown error" for non-Error throws', async () => {
      dbHolder.bio = throwing('not an Error instance')
      const error = await rejectionOf(caller.previewClassifier({ side: 'left', classifier: movementOnly }))
      expect(error.message).toBe('Failed to preview stage classifier: Unknown error')
    })

    it('classifies the latest night with the saved and candidate rules', async () => {
      const record = seedNight()
      const out = await caller.previewClassifier({ side: 'left', classifier: movementOnly })
      expect(out.sleepRecordId).toBe(record.id)
      expect(out.enteredBedAt).toBe(BED.getTime())
      expect(out.saved?.distribution.deep).toBeGreaterThan(0)
      expect(out.candidate?.distribution).toEqual({ wake: 0, light: 100, deep: 0, rem: 0 })
      expect(out.hasReference).toBe(false)
      expect(out.saved?.agreement).toBeNull()
    })

    it('reports per-rule statistics and where the candidate differs', async () => {
      seedNight()
      const out = await caller.previewClassifier({ side: 'left', classifier: DEFAULT_STAGE_CLASSIFIER })
      expect(out.nights).toBe(1)
      const stats = out.candidate?.stats
      expect(stats).toMatchObject({ epochs: 12, nights: 1, lowSignalNights: 0, lowSignalRules: null })
      const rules = stats?.rules ?? { hits: [], fallbackHits: 0 }
      expect(rules.hits).toHaveLength(DEFAULT_STAGE_RULESET.rules.length)
      expect(rules.hits.reduce((a, b) => a + b, 0) + rules.fallbackHits).toBe(12)
      expect(stats?.metricRanges.heartRate).toEqual({ min: 60, max: 70 })
      expect(out.candidate?.durations.deep).toBeGreaterThan(0)
      expect(out.changed).toEqual({ segments: [], changed: 0, total: 12 })

      const moved = await caller.previewClassifier({ side: 'left', classifier: movementOnly })
      expect(moved.changed?.changed).toBeGreaterThan(0)
      expect(moved.changed?.segments.length).toBeGreaterThan(0)
    })

    it('aggregates the latest N nights, latest first', async () => {
      const older = seedNight('left', -24 * 60)
      const latest = seedNight('left')
      const out = await caller.previewClassifier({ side: 'left', nights: 7, classifier: DEFAULT_STAGE_CLASSIFIER })
      expect(out.nights).toBe(2)
      expect(out.sleepRecordId).toBe(latest.id)
      expect(out.sleepRecordId).not.toBe(older.id)
      expect(out.candidate?.stats).toMatchObject({ epochs: 24, nights: 2 })
      expect(out.candidate?.totalSleepMs).toBe(60 * MIN)
      expect(out.candidate?.blocks[0].start).toBe(BED.getTime())
    })

    it('scores both against reference stages', async () => {
      seedNight()
      bio.insert(bioSchema.referenceStages).values({ side: 'left', source: 'apple_watch', start: BED, end: at(60), stage: 'light' }).run()
      const out = await caller.previewClassifier({ side: 'left', classifier: movementOnly })
      expect(out.hasReference).toBe(true)
      expect(out.candidate?.agreement).toMatchObject({ epochs: 12, accuracy: 1 })
      // The confusion matrix and recall must survive the router's output schema.
      expect(out.candidate?.agreement?.confusion.light).toEqual({ wake: 0, light: 12, deep: 0, rem: 0 })
      expect(out.candidate?.agreement?.recall).toEqual({ wake: null, light: 1, deep: null, rem: null })
      expect(out.saved?.agreement?.accuracy).toBeLessThan(1)
    })
  })
  describe('personal stage model', () => {
    /** One tree: deep when hrZ <= -0.5, else light. */
    const model = {
      version: 'test-forest',
      kind: 'forest' as const,
      classes: ['wake', 'light', 'deep', 'rem'] as ['wake', 'light', 'deep', 'rem'],
      featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction'],
      trees: [{ f: [0, -1, -1], t: [-0.5, 0, 0], l: [1, -1, -1], r: [2, -1, -1], v: [[0, 0, 0, 0], [0, 1, 9, 0], [1, 8, 1, 0]] }],
      testVectors: [
        { inputs: { hrZ: -1, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 2 },
        { inputs: { hrZ: 1, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 1 },
      ],
    }

    it('keeps multiple uploads without changing staging, deduplicates, and switches per side', async () => {
      const first = await caller.uploadModel({ side: 'left', model })
      expect(await caller.uploadModel({ side: 'left', model })).toEqual(first)
      expect((await caller.getModel({ side: 'left' })).model).toBeNull()
      await caller.selectModel({ side: 'left', id: first.id, active: true })
      const second = await caller.uploadModel({ side: 'left', model: { ...model, version: 'second' } })
      expect((await caller.getModel({ side: 'left' })).model?.version).toBe('test-forest')
      expect((await caller.getModel({ side: 'left' })).active).toBe(true)
      expect(await caller.listModels({ side: 'right' })).toEqual([])
      expect((await rejectionOf(caller.selectModel({ side: 'right', id: first.id, active: true }))).code).toBe('NOT_FOUND')
      await caller.selectModel({ side: 'left', id: second.id, active: true })
      const list = await caller.listModels({ side: 'left' })
      expect(list).toHaveLength(2)
      expect(list.filter(m => m.active).map(m => m.version)).toEqual(['second'])
      await caller.selectModel({ side: 'left', id: first.id, active: false })
      expect((await caller.getModel({ side: 'left' })).active).toBe(false)
      expect((await caller.getModel({ side: 'left' })).model?.version).toBe('test-forest')
      expect(await caller.listModels({ side: 'left' })).toHaveLength(2)
    })

    it('rejects invalid library uploads without storing a candidate or changing the active model', async () => {
      await caller.setModel({ side: 'left', model })
      await caller.setModelActive({ side: 'left', active: true })
      const wrong = { ...model, testVectors: [{ inputs: { hrZ: -1, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 1 }] }
      expect((await rejectionOf(caller.uploadModel({ side: 'left', model: wrong }))).code).toBe('BAD_REQUEST')
      expect(await caller.listModels({ side: 'left' })).toHaveLength(1)
      expect((await caller.getModel({ side: 'left' })).active).toBe(true)
    })

    it('archives legacy uploads and preserves the existing active-state contract', async () => {
      await caller.setModel({ side: 'left', model })
      await caller.setModelActive({ side: 'left', active: true })
      await caller.setModel({ side: 'left', model: { ...model, version: 'legacy replacement' } })
      expect(await caller.listModels({ side: 'left' })).toHaveLength(2)
      expect((await caller.getModel({ side: 'left' })).active).toBe(true)
      await caller.setModel({ side: 'left', model: null })
      expect(await caller.listModels({ side: 'left' })).toHaveLength(2)
    })

    it('stores a validated model per side and removes it with null', async () => {
      expect(await caller.getModel({ side: 'left' })).toEqual({ model: null, uploadedAt: null, active: false })
      const stored = await caller.setModel({ side: 'left', model })
      expect(stored).toEqual({ stored: true, version: 'test-forest' })
      const out = await caller.getModel({ side: 'left' })
      expect(out.model?.version).toBe('test-forest')
      expect(out.uploadedAt).not.toBeNull()
      expect(out.active).toBe(false)
      expect((await caller.getModel({ side: 'right' })).model).toBeNull()
      expect(await caller.setModel({ side: 'left', model: null })).toEqual({ stored: false, version: null })
      expect((await caller.getModel({ side: 'left' })).model).toBeNull()
    })

    it('refuses a model that fails its own vectors or names an unknown contract', async () => {
      const wrong = { ...model, testVectors: [{ inputs: { hrZ: -1, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 1 }] }
      expect((await rejectionOf(caller.setModel({ side: 'left', model: wrong }))).code).toBe('BAD_REQUEST')
      const unknown = { ...model, featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction', 'extra'],
        trees: [{ f: [4, -1, -1], t: [0, 0, 0], l: [1, -1, -1], r: [2, -1, -1], v: [[0, 0, 0, 0], [0, 1, 9, 0], [1, 8, 1, 0]] }],
        testVectors: [{ inputs: { hrZ: 0, hrStdZ: 0, motionZ: 0, nightFraction: 0, extra: -1 }, expected: 2 }] }
      expect((await rejectionOf(caller.setModel({ side: 'left', model: unknown }))).code).toBe('BAD_REQUEST')
    })

    it('scores the model and the rules against the Watch on the same nights', async () => {
      seedNight()
      bio.insert(bioSchema.referenceStages).values([
        { side: 'left', source: 'apple_watch', start: BED, end: at(20), stage: 'light' },
        { side: 'left', source: 'apple_watch', start: at(20), end: at(40), stage: 'deep' },
        { side: 'left', source: 'apple_watch', start: at(40), end: at(60), stage: 'light' },
      ]).run()
      expect((await rejectionOf(caller.previewModel({ side: 'left' }))).code).toBe('NOT_FOUND')
      await caller.setModel({ side: 'left', model })
      const out = await caller.previewModel({ side: 'left' })
      expect(out.version).toBe('test-forest')
      expect(out.nights).toHaveLength(1)
      // The HR dip in minutes 20–40 is the only low-z stretch: the tree calls it deep, matching the Watch exactly.
      expect(out.nights[0].blocks.map(b => b.stage)).toEqual(['light', 'deep', 'light'])
      expect(out.nights[0].agreement?.accuracy).toBe(1)
      expect(out.pooled?.epochs).toBe(12)
      expect(out.rulesPooled?.epochs).toBe(12)
      const inline = await caller.previewModel({ side: 'right', model, nights: 3 })
      expect(inline.nights).toHaveLength(0)
    })

    it('stages the side with the model once it is made active, and falls back to the rules without one', async () => {
      const { biometricsRouter } = await import('@/src/server/routers/biometrics')
      const bio = biometricsRouter.createCaller({})
      const record = seedNight()
      expect((await rejectionOf(caller.setModelActive({ side: 'left', active: true }))).code).toBe('NOT_FOUND')
      expect(await caller.setModelActive({ side: 'left', active: false })).toEqual({ active: false, version: null })
      await caller.setModel({ side: 'left', model })
      const rules = await bio.getSleepStages({ side: 'left', sleepRecordId: record.id })
      expect(rules.stagedBy).toEqual({ engine: 'rules', version: null })
      expect(await caller.setModelActive({ side: 'left', active: true })).toEqual({ active: true, version: 'test-forest' })
      expect((await caller.getModel({ side: 'left' })).active).toBe(true)
      const staged = await bio.getSleepStages({ side: 'left', sleepRecordId: record.id })
      expect(staged.stagedBy).toEqual({ engine: 'model', version: 'test-forest' })
      // The model works in 5-minute epochs from bed entry over the 60-minute record.
      expect(staged.epochs).toHaveLength(12)
      expect(staged.epochs.every(e => e.duration === 300_000)).toBe(true)
      expect(staged.blocks.map(b => b.stage)).toEqual(['light', 'deep', 'light'])
      // The "last night" lookup finds no overnight record in this fixture and answers empty, before any staging.
      const latest = await bio.getSleepStages({ side: 'left' })
      expect(latest.sleepRecordId).toBeNull()
      expect(latest.stagedBy).toBeUndefined()
      // Removing the model returns the side to the rules.
      await caller.setModel({ side: 'left', model: null })
      expect((await bio.getSleepStages({ side: 'left', sleepRecordId: record.id })).stagedBy?.engine).toBe('rules')
      // A stored model the evaluator cannot run (an unknown contract written straight to the table) falls back to the rules.
      const main = dbHolder.main as ReturnType<typeof drizzle<typeof mainSchema>>
      const odd = { ...model, version: 'odd', featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction', 'extra'],
        trees: [{ f: [4, -1, -1], t: [0, 0, 0], l: [1, -1, -1], r: [2, -1, -1], v: [[0, 0, 0, 0], [0, 1, 9, 0], [1, 8, 1, 0]] }],
        testVectors: [{ inputs: { hrZ: 0, hrStdZ: 0, motionZ: 0, nightFraction: 0, extra: -1 }, expected: 2 }] }
      main.insert(mainSchema.sideStageModels).values({ side: 'left', model: odd, version: 'odd', uploadedAt: new Date(), active: true }).run()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect((await bio.getSleepStages({ side: 'left', sleepRecordId: record.id })).stagedBy).toEqual({ engine: 'rules', version: null })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('personal model odd failed'))
      warn.mockRestore()
    })

    it('refuses an inline model that fails its vectors and wraps unexpected failures', async () => {
      const main = dbHolder.main as ReturnType<typeof drizzle<typeof mainSchema>>
      const wrong = { ...model, testVectors: [{ inputs: { hrZ: -1, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 1 }] }
      expect((await rejectionOf(caller.previewModel({ side: 'left', model: wrong }))).code).toBe('BAD_REQUEST')
      // An unknown feature contract is bad input too, even when its own vectors pass.
      const rename = (name: string) => `${name}_unknown`
      const unknown = {
        ...model,
        featureContract: model.featureContract.map(rename),
        testVectors: model.testVectors.map(v => ({ ...v, inputs: Object.fromEntries(Object.entries(v.inputs).map(([k, x]) => [rename(k), x])) })),
      }
      expect((await rejectionOf(caller.previewModel({ side: 'left', model: unknown }))).code).toBe('BAD_REQUEST')
      // A stored document that no longer validates reads back as nothing stored, and cannot be active.
      main.insert(mainSchema.sideStageModels).values({ side: 'right', model: { nonsense: true }, version: 'x', uploadedAt: new Date(), active: true }).run()
      expect(await caller.getModel({ side: 'right' })).toEqual({ model: null, uploadedAt: expect.any(Number), active: false })
      expect((await rejectionOf(caller.previewModel({ side: 'right' }))).code).toBe('NOT_FOUND')
      dbHolder.bio = throwing(new Error('disk gone'))
      const error = await rejectionOf(caller.previewModel({ side: 'left', model }))
      expect(error.code).toBe('INTERNAL_SERVER_ERROR')
      expect(error.message).toBe('Failed to preview stage model: disk gone')
    })
  })
})

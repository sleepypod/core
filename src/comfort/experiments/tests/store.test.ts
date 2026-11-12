import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migratedComfortDatabase } from '../../tests/databaseFixture'
import { ComfortExperimentStore } from '../store'
import { EXPERIMENT_REVIEW_MS, experimentPlanSchema } from '../contract'
import { experimentPlanHash } from '../plan'
import { completeExperiment, context, createdAt, fixturePlan } from './fixture'

let database: Database.Database
let now: number
let store: ComfortExperimentStore
beforeEach(() => {
  database = migratedComfortDatabase()
  now = createdAt
  store = new ComfortExperimentStore(database, context.subjectKey, () => now)
})
afterEach(() => {
  if (database?.open) database.close()
})

describe('durable personal comfort experiment records', () => {
  it('persists the same assignment on retry and rejects reused IDs with changed treatments', () => {
    const plan = fixturePlan(), record = store.create(plan)
    now += 60_000
    expect(store.create(plan)).toEqual(record)
    expect(() => store.create({ ...plan, variantF: 71 })).toThrow('changed')
    expect(store.list()).toEqual([record])
  })

  it('keeps subjects isolated for reads, writes and active-plan admission', () => {
    const plan = fixturePlan(), record = store.create(plan)
    const other = new ComfortExperimentStore(database, 'f'.repeat(64), () => now)
    expect(other.read(plan.id)).toBeNull()
    expect(other.list()).toEqual([])
    expect(() => other.stop(plan.id, record.revision)).toThrow()
    expect(() => other.create(plan)).toThrow('scope')
    const second = { ...fixturePlan(), context: { ...context, subjectKey: 'f'.repeat(64) } }
    expect(other.create(second).plan.id).toBe(second.id)
    expect(store.list()).toHaveLength(1)
  })

  it('allows one open plan per person and cannot resurrect a stopped plan on retry', () => {
    const plan = fixturePlan(), original = store.create(plan)
    expect(() => store.create(fixturePlan())).toThrow('Stop')
    const stopped = store.stop(plan.id, original.revision)
    expect(store.create(plan)).toEqual(stopped)
    expect(store.create(fixturePlan()).status).toBe('planned')
  })

  it('rejects stale revisions and preserves newer feedback', () => {
    const plan = fixturePlan(), original = store.create(plan)
    now = Date.parse('2026-11-14T08:00:00Z')
    const saved = store.saveFeedback(plan.id, original.revision, { nightDate: '2026-11-13',
      confirmedFullNight: true, comfort: 8, unwantedAdjustments: 0, problem: false })
    expect(() => store.stop(plan.id, original.revision)).toThrow('changed')
    expect(store.read(plan.id)).toEqual(saved)
    const stopped = store.stop(plan.id, saved.revision)
    expect(stopped.feedback).toEqual(saved.feedback)
    expect(stopped.stoppedAt).toBe(now)
  })

  it('timestamps feedback on the server and rejects future, foreign and extra measurement fields', () => {
    const plan = fixturePlan(), record = store.create(plan)
    const feedback = { nightDate: '2026-11-13', confirmedFullNight: true, comfort: 8, unwantedAdjustments: 0, problem: false }
    expect(() => store.saveFeedback(plan.id, record.revision, feedback)).toThrow('completed')
    now = Date.parse('2026-11-14T08:00:00Z')
    expect(() => store.saveFeedback(plan.id, record.revision, { ...feedback, observedMs: 20_000_000 })).toThrow()
    expect(() => store.saveFeedback(plan.id, record.revision, { ...feedback, recordedAt: now })).toThrow()
    expect(() => store.saveFeedback(plan.id, record.revision, { ...feedback, nightDate: '2026-11-12' })).toThrow('unassigned')
    const saved = store.saveFeedback(plan.id, record.revision, feedback)
    expect(saved.feedback[0].recordedAt).toBe(now)
    now = Date.parse('2026-12-01T08:00:00Z')
    expect(() => store.saveFeedback(plan.id, saved.revision, feedback)).toThrow('fourteen')
  })

  it('withdraws and replaces a collector observation without rerandomizing or deleting the original plan', () => {
    const source = completeExperiment(), plan = source.plan, original = store.create(plan)
    const exposure = source.exposures[0]
    now = exposure.recordedAt
    const saved = store.saveExposure(plan.id, original.revision, exposure)
    now += 1000
    const withdrawn = store.saveExposure(plan.id, saved.revision, { ...exposure, recordedAt: now, sourceState: 'withdrawn' })
    expect(withdrawn.plan).toEqual(plan)
    expect(withdrawn.exposures).toHaveLength(1)
    expect(withdrawn.exposures[0].sourceState).toBe('withdrawn')
    expect(() => store.saveExposure(plan.id, withdrawn.revision, exposure)).toThrow('newer')
  })

  it('rejects collector evidence from the future, another plan or an unassigned night', () => {
    const source = completeExperiment(), original = store.create(source.plan), exposure = source.exposures[0]
    expect(() => store.saveExposure(source.plan.id, original.revision, exposure)).toThrow('completed')
    now = exposure.recordedAt
    expect(() => store.saveExposure(source.plan.id, original.revision, { ...exposure, planHash: 'f'.repeat(64) })).toThrow()
    expect(() => store.saveExposure(source.plan.id, original.revision, { ...exposure, nightDate: '2026-11-12' })).toThrow()
    expect(store.read(source.plan.id)?.exposures).toEqual([])
  })

  it('rolls back failed durable updates instead of acknowledging an unsaved stop', () => {
    const plan = fixturePlan(), record = store.create(plan)
    database.exec('CREATE TRIGGER fail_experiment_update BEFORE UPDATE ON comfort_experiments BEGIN SELECT RAISE(ABORT, \'fixture disk failure\'); END;')
    expect(() => store.stop(plan.id, record.revision)).toThrow('fixture disk failure')
    expect(store.read(plan.id)).toEqual(record)
  })

  it('preserves the plan and cancellation across a database reopen', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'sleepypod-experiment-'))
    const filename = path.join(folder, 'fixture.db')
    let disk = migratedComfortDatabase(filename)
    try {
      const first = new ComfortExperimentStore(disk, context.subjectKey, () => now)
      const plan = fixturePlan(), record = first.create(plan)
      const stopped = first.stop(plan.id, record.revision)
      disk.close()
      disk = migratedComfortDatabase(filename)
      const restored = new ComfortExperimentStore(disk, context.subjectKey, () => now)
      expect(restored.read(plan.id)).toEqual(stopped)
      expect(experimentPlanHash(experimentPlanSchema.parse(restored.read(plan.id)?.plan))).toBe(experimentPlanHash(plan))
    }
    finally {
      if (disk.open) disk.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('fails closed on corrupted row identity, revision and future clock', () => {
    const plan = fixturePlan(), record = store.create(plan)
    database.prepare('UPDATE comfort_experiments SET revision = ? WHERE id = ?').run(randomUUID(), plan.id)
    expect(() => store.read(plan.id)).toThrow('inconsistent')
    database.prepare('UPDATE comfort_experiments SET revision = ? WHERE id = ?').run(record.revision, plan.id)
    now -= 1
    expect(() => store.read(plan.id)).toThrow('inconsistent')
  })

  it('never changes schedule, alarm, control or calibration tables', () => {
    const names = (database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name != \'comfort_experiments\'').all() as { name: string }[])
      .map(row => row.name)
    const capture = () => names.map(name => ({ name, rows: database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }))
    const before = capture(), plan = fixturePlan(), record = store.create(plan)
    store.stop(plan.id, record.revision)
    expect(capture()).toEqual(before)
  })

  it('refuses expired and future previews without leaving partial records', () => {
    const plan = fixturePlan()
    now = createdAt + EXPERIMENT_REVIEW_MS
    expect(() => store.create(plan)).toThrow('expired')
    now = createdAt - 1
    expect(() => store.create(plan)).toThrow('expired')
    expect(store.list()).toEqual([])
  })
})

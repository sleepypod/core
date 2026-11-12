import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { comfortEvent } from '../../store'
import { ExperimentExecutionHost } from '../execution'
import { observationSourceReader } from '../observation-source'
import { ExperimentObservationJournal } from '../observations'
import { ComfortExperimentService } from '../service'
import { executionFixture } from './executionFixture'

const fixtures: Awaited<ReturnType<typeof executionFixture>>[] = []
async function fixture() {
  const test = await executionFixture()
  fixtures.push(test)
  return test
}
afterEach(async () => {
  for (const test of fixtures.splice(0)) {
    await test.host.stop()
    test.database.close()
  }
  vi.restoreAllMocks()
})

it('records real selection provenance before and during treatment, preserves gaps, and publishes after the actual end', async () => {
  const test = await fixture(), grant = await test.admit(), window = test.plan.schedule.windows[0]
  for (const offset of [1, 5001, 10_001, 60_001]) {
    test.advance(window.windowStart + offset)
    await test.host.tick()
  }
  const row = test.database.prepare('SELECT id FROM comfort_experiment_observation_windows').get() as { id: string }
  const reader = observationSourceReader(test.database, test.now, test.access.subjectKey)
  const before = reader.journal.read(row.id)
  expect(before?.observations.map(packet => packet.at - window.windowStart)).toEqual([1, 10_001, 60_001])
  expect(before?.observations[0].zones[0].sample.targetF).toBe(75)
  expect(before?.observations[0].zones[0].sample.selectedRequestId).not.toContain('comfort-experiment')
  expect(before?.observations[1].zones[0].sample.targetF).toBe(74)
  expect(before?.observations[1].zones[0].sample.selectedRequestId).toContain('comfort-experiment')
  expect(before?.observations[2].zones[0].sample.selectedRequestId).toContain('comfort-experiment')
  expect(test.plans.read(test.plan.id)?.exposures).toHaveLength(0)
  test.advance(window.windowEnd)
  await test.host.tick()
  const exposure = test.plans.read(test.plan.id)?.exposures[0]
  expect(exposure).toMatchObject({ observationWindowId: row.id, windowStart: window.windowStart,
    windowEnd: window.windowEnd, wakeStartsAt: window.wake?.startsAt, observedMs: 30_000,
    qualifiedMs: 20_000, sourceState: 'current', execution: 'active' })
  expect(reader.admissions.read(test.access.subjectKey, grant.review.id).revokedAt).toBeNull()
  const service = new ComfortExperimentService(test.database, test.now)
  const read = vi.spyOn(ExperimentObservationJournal.prototype, 'read')
  expect(service.detail(test.access, test.plan.id).record.exposures[0]).toEqual(exposure)
  const verifiedReads = read.mock.calls.length
  expect(verifiedReads).toBeGreaterThan(0)
  expect(service.detail(test.access, test.plan.id).record.exposures[0]).toEqual(exposure)
  expect(read.mock.calls).toHaveLength(verifiedReads)
  test.database.prepare('UPDATE comfort_experiments SET record = json_remove(record, \'$.exposures[0].observationWindowId\') WHERE id = ?').run(test.plan.id)
  expect(service.detail(test.access, test.plan.id).record.exposures[0].sourceState).toBe('withdrawn')
  test.database.prepare('UPDATE comfort_experiments SET record = json_set(record, \'$.exposures[0].observationWindowId\', ?) WHERE id = ?').run(row.id, test.plan.id)
  // Removing one retained observation withdraws the saved result, even with its old summary still present.
  test.database.prepare('DELETE FROM comfort_experiment_observations WHERE window_id = ? AND position = 1').run(row.id)
  expect(service.detail(test.access, test.plan.id).record.exposures[0].sourceState).toBe('withdrawn')
})

it('withholds experimental writes if the first observation cannot be durably recorded', async () => {
  const test = await fixture()
  await test.qualifyRight()
  await test.admit()
  test.database.exec(`CREATE TRIGGER fail_observation BEFORE INSERT ON comfort_experiment_observations
    BEGIN SELECT RAISE(ABORT, 'Synthetic recording failure'); END`)
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  await test.host.tick()
  expect(test.writes).not.toHaveBeenCalled()
  expect(test.host.admissions.claim('left')).toBeNull()
  expect(test.host.admissions.claim('right')).toBeNull()
  expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_observation_windows').get()).toEqual({ count: 0 })
})

it('does not double count two occupied halves or duplicate a packet after controller restart', async () => {
  const test = await fixture()
  await test.qualifyRight()
  await test.admit()
  const window = test.plan.schedule.windows[0]
  test.advance(window.windowStart + 1)
  await test.host.tick()
  test.advance(window.windowStart + 5001)
  await test.host.tick()
  test.advance(window.windowStart + 10_001)
  await test.host.tick()
  await test.host.stop()
  const restarted = new ExperimentExecutionHost(test.deps)
  try {
    await restarted.start()
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_observations').get()).toEqual({ count: 2 })
    test.advance(window.windowEnd)
    await restarted.tick()
    expect(test.plans.read(test.plan.id)?.exposures[0]).toMatchObject({ observedMs: 20_000, occupiedMs: 20_000, qualifiedMs: 10_000 })
  }
  finally { await restarted.stop() }
})

it('retains an interrupted incomplete night and rejects a comparison after its manual source is deleted', async () => {
  const test = await fixture()
  await test.admit()
  const window = test.plan.schedule.windows[0]
  test.advance(window.windowStart + 1)
  await test.host.tick()
  test.advance(window.windowStart + 10_001)
  test.store.commit('left', test.store.read('left'), comfortEvent(test.now(), 'manual_pause', 'Synthetic manual control'))
  await test.host.tick()
  expect(test.host.admissions.claim('left')).toBeNull()
  test.advance(window.windowEnd)
  await test.host.tick()
  const service = new ComfortExperimentService(test.database, test.now)
  expect(service.detail(test.access, test.plan.id).record.exposures[0])
    .toMatchObject({ manualChanges: 1, safetyInterruptions: 1, qualifiedMs: 0, sourceState: 'current' })
  test.database.prepare('DELETE FROM comfort_events WHERE json_extract(event, \'$.kind\') = \'manual_pause\'').run()
  expect(service.detail(test.access, test.plan.id).record.exposures[0].sourceState).toBe('withdrawn')
})

it('revokes the current admission when a retained source changes before the periodic audit', async () => {
  const test = await fixture()
  await test.admit()
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  await test.host.tick()
  test.database.prepare('UPDATE comfort_experiment_observations SET record = json_set(record, \'$.zones[0].sample.targetF\', 70)').run()
  test.advance(test.now() + 60_000)
  await test.host.tick()
  expect(test.host.admissions.claim('left')).toBeNull()
  expect(test.writes).toHaveBeenLastCalledWith('left', 75)
})

it('rolls back sealing when summary publication fails, then retries without losing the original observation window', async () => {
  const test = await fixture()
  await test.admit()
  const window = test.plan.schedule.windows[0]
  test.advance(window.windowStart + 1)
  await test.host.tick()
  test.database.exec(`CREATE TRIGGER fail_experiment_summary BEFORE UPDATE ON comfort_experiments
    BEGIN SELECT RAISE(ABORT, 'Synthetic summary failure'); END`)
  test.advance(window.windowEnd)
  await test.host.tick()
  expect(test.plans.read(test.plan.id)?.exposures).toHaveLength(0)
  expect(test.database.prepare('SELECT finalized_at FROM comfort_experiment_observation_windows').get()).toEqual({ finalized_at: null })
  test.database.exec('DROP TRIGGER fail_experiment_summary')
  await test.host.tick()
  expect(test.plans.read(test.plan.id)?.exposures[0]).toMatchObject({ windowStart: window.windowStart,
    windowEnd: window.windowEnd, observedMs: 10_000, qualifiedMs: 0 })
})

it('invalidates a cached source verification after another database connection removes a packet', async () => {
  const test = await fixture()
  await test.admit()
  const window = test.plan.schedule.windows[0]
  test.advance(window.windowStart + 1)
  await test.host.tick()
  test.advance(window.windowEnd)
  await test.host.tick()
  const directory = mkdtempSync(join(tmpdir(), 'sleepypod-observation-audit-'))
  let reader: Database.Database | undefined, writer: Database.Database | undefined
  try {
    const path = join(directory, 'source.sqlite')
    await test.database.backup(path)
    reader = new Database(path)
    writer = new Database(path)
    const service = new ComfortExperimentService(reader, test.now)
    expect(service.detail(test.access, test.plan.id).record.exposures[0].sourceState).toBe('current')
    writer.prepare('DELETE FROM comfort_experiment_observations').run()
    expect(service.detail(test.access, test.plan.id).record.exposures[0].sourceState).toBe('withdrawn')
  }
  finally {
    reader?.close()
    writer?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

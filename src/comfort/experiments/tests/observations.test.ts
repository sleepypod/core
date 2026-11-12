import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ExperimentAdmissions } from '../admissions'
import { ExperimentObservationJournal } from '../observations'
import type { ExperimentSample } from '../exposure'
import { executionFixture } from './executionFixture'

const fixtures: Awaited<ReturnType<typeof executionFixture>>[] = []
async function fixture() {
  const test = await executionFixture()
  fixtures.push(test)
  const grant = await test.admit(), window = test.plan.schedule.windows[0]
  test.advance(window.windowStart)
  const deps = { database: test.database, now: test.now, grant: (subject: string, id: string) => test.host.admissions.read(subject, id) }
  const journal = new ExperimentObservationJournal(deps, test.access.subjectKey)
  const input = (offset = 0) => {
    const at = window.windowStart + offset
    test.advance(at)
    const sample: ExperimentSample = { at, deviceAt: at, presenceAt: at, targetF: 75,
      powered: true, occupied: true, waterAdequate: true, priming: false, vibrating: false, baseMoving: false,
      bindingHash: test.plan.context.bindingHash, routineHash: test.plan.context.routineHash, wakeHash: test.plan.context.wakeHash,
      selectedRequestId: test.authority.selectedRequest('left')?.id ?? null,
      selectedUntil: test.authority.selectedRequest('left')?.expiresAt ?? null, attributionAmbiguous: false }
    return { at, zones: [{ side: 'left' as const, sample }] }
  }
  const append = (offset = 0) => journal.append(grant.review.id, window.date, input(offset), () => {})
  return { ...test, grant, window, deps, journal, input, append }
}
afterEach(async () => {
  for (const test of fixtures.splice(0)) {
    await test.host.stop()
    test.database.close()
  }
})

it('retains exact observation clocks and gaps, then verifies a sealed window from a reopened database', async () => {
  const test = await fixture(), id = test.append()
  test.append(10_000)
  test.append(60_000)
  expect(test.journal.read(id)?.observations.map(item => item.at - test.window.windowStart)).toEqual([0, 10_000, 60_000])
  expect(test.journal.read(id)?.finalizedAt).toBeNull()
  test.advance(test.window.windowEnd)
  const sealed = test.journal.finalize(id, () => {})
  const directory = mkdtempSync(join(tmpdir(), 'sleepypod-experiment-observations-'))
  let reopened: Database.Database | undefined
  try {
    const path = join(directory, 'source.sqlite')
    await test.database.backup(path)
    reopened = new Database(path)
    const admissions = new ExperimentAdmissions({ database: reopened, now: test.now, validate: () => {}, suspend: () => {}, revokeLease: () => {} })
    const restored = new ExperimentObservationJournal({ database: reopened, now: test.now,
      grant: (subject, admission) => admissions.read(subject, admission) }, test.access.subjectKey)
    expect(restored.read(id)).toEqual(sealed)
    expect(sealed.finalizedAt).toBe(test.window.windowEnd)
  }
  finally {
    reopened?.close()
    rmSync(directory, { recursive: true, force: true })
  }
  expect(test.writes).not.toHaveBeenCalled()
})

it('keeps retained observations private to their admission subject', async () => {
  const test = await fixture(), id = test.append()
  const other = new ExperimentObservationJournal(test.deps, 'f'.repeat(64))
  expect(other.read(id)).toBeNull()
  expect(() => other.append(test.grant.review.id, test.window.date, test.input(10_000), () => {})).toThrow('current account')
})

it('does not create a source window for invalid physical-zone or future-clock packets', async () => {
  const test = await fixture(), original = test.input()
  expect(() => test.journal.append(test.grant.review.id, test.window.date,
    { ...original, zones: [{ ...original.zones[0], side: 'right' }] }, () => {})).toThrow('zones')
  expect(() => test.journal.append(test.grant.review.id, test.window.date,
    { ...original, zones: [{ ...original.zones[0], sample: { ...original.zones[0].sample, deviceAt: original.at + 1 } }] }, () => {})).toThrow()
  expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_observation_windows').get()).toEqual({ count: 0 })
})

it('records a single immutable packet for an identical retry, but rejects altered or too-frequent observations', async () => {
  const test = await fixture(), id = test.append(), original = test.input()
  expect(test.journal.append(test.grant.review.id, test.window.date, original, () => {})).toBe(id)
  expect(() => test.journal.append(test.grant.review.id, test.window.date,
    { ...original, zones: [{ ...original.zones[0], sample: { ...original.zones[0].sample, targetF: 73 } }] }, () => {})).toThrow('reused')
  expect(() => test.append(1000)).toThrow('ten seconds')
  expect(test.journal.read(id)?.observations).toHaveLength(1)
})

it.each(['deleted', 'changed'] as const)('detects %s retained source data instead of accepting the saved summary', async (change) => {
  const test = await fixture(), id = test.append()
  test.append(10_000)
  test.append(20_000)
  if (change === 'deleted') test.database.prepare('DELETE FROM comfort_experiment_observations WHERE window_id = ? AND position = 1').run(id)
  else test.database.prepare('UPDATE comfort_experiment_observations SET record = json_set(record, \'$.zones[0].sample.targetF\', 72) WHERE window_id = ? AND position = 1').run(id)
  expect(() => test.journal.read(id)).toThrow(/missing|changed/)
  if (change === 'deleted') expect(() => test.append(30_000)).toThrow('changed')
})

it('rolls back the source header and packet when current authorization fails at the final durable check', async () => {
  const test = await fixture()
  let checks = 0
  expect(() => test.journal.append(test.grant.review.id, test.window.date, test.input(), () => {
    expect(test.database.inTransaction).toBe(true)
    expect(test.database.pragma('synchronous', { simple: true })).toBe(2)
    if (++checks === 2) throw new Error('Synthetic revocation')
  })).toThrow('Synthetic revocation')
  expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_observation_windows').get()).toEqual({ count: 0 })
  expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_observations').get()).toEqual({ count: 0 })
})

it('withholds further collection after cancellation while preserving the original incomplete window', async () => {
  const test = await fixture(), id = test.append()
  await test.host.cancel(test.principal, test.grant.review.id, () => {})
  expect(() => test.append(10_000)).toThrow('current admitted')
  expect(() => test.journal.finalize(id, () => {})).toThrow('not completed')
  test.advance(test.window.windowEnd)
  const sealed = test.journal.finalize(id, () => {})
  expect(sealed.observations).toHaveLength(1)
  expect(sealed.binding.windowStart).toBe(test.window.windowStart)
  expect(sealed.binding.windowEnd).toBe(test.window.windowEnd)
  expect(test.journal.finalize(id, () => {}).sourceDigest).toBe(sealed.sourceDigest)
})

it('rolls back both the packet and its header if storage fails after insertion', async () => {
  const test = await fixture(), id = test.append()
  const original = test.journal.read(id)
  test.database.exec(`CREATE TRIGGER fail_observation_header BEFORE UPDATE ON comfort_experiment_observation_windows
    BEGIN SELECT RAISE(ABORT, 'Synthetic disk failure'); END`)
  expect(() => test.append(10_000)).toThrow('Synthetic disk failure')
  expect(test.journal.read(id)).toEqual(original)
  expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_observations WHERE window_id = ?').get(id)).toEqual({ count: 1 })
})

it('never accepts an observation from after the reviewed wake boundary or from a stale collector', async () => {
  const test = await fixture()
  const original = test.input()
  test.advance(original.at + 10_001)
  expect(() => test.journal.append(test.grant.review.id, test.window.date, original, () => {})).toThrow('live observation')
  expect(() => test.append(test.window.windowEnd - test.window.windowStart)).toThrow('live observation')
  expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_observation_windows').get()).toEqual({ count: 0 })
})

it('rejects a changed admission binding without modifying the retained source', async () => {
  const test = await fixture(), id = test.append()
  const invalid = new ExperimentObservationJournal({ ...test.deps,
    grant: () => ({ ...test.grant, review: { ...test.grant.review, planHash: 'e'.repeat(64) } }) }, test.access.subjectKey)
  expect(() => invalid.read(id)).toThrow('does not match')
  expect(() => invalid.append(test.grant.review.id, test.window.date, test.input(10_000), () => {})).toThrow('live observation')
  expect(test.journal.read(id)?.observations).toHaveLength(1)
})

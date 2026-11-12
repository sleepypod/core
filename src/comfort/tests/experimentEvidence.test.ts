import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { durableTransaction } from '@/src/db/durable'
import { ownerFixture } from './ownerFixture'

const fixtures: ReturnType<typeof ownerFixture>[] = []
function fixture() {
  const value = ownerFixture()
  fixtures.push(value)
  return value
}
afterEach(() => fixtures.splice(0).forEach(value => value.database.close()))

describe('experiment admission reuses the real comfort qualification', () => {
  it('does not replace missing physical checks or seven nights with a saved experiment', async () => {
    const test = fixture()
    await expect(test.owner.experimentEvidence('left')).rejects.toThrow('attended confirmation')
    await test.qualifyAll()
    await expect(test.owner.experimentEvidence('left')).rejects.toThrow('0 of 7')
    expect(test.store.read('left').config.mode).toBe('preview')
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_activations').get()).toEqual({ count: 0 })
  })

  it('reads exact source-backed evidence without changing mode or granting an adjustment', async () => {
    const test = fixture()
    await test.ready()
    const previous = test.store.read('left')
    const proof = await test.owner.experimentEvidence('left')
    expect(proof.qualifications).toHaveLength(6)
    expect(proof.nights).toHaveLength(7)
    expect(test.store.read('left')).toEqual(previous)
    expect(test.owner.admission('left', previous)).toBeNull()
    test.store.commit('right', previous)
    expect(() => test.owner.assertExperimentEvidence('right', proof, true)).toThrow('qualification changed')
  })

  it.each(['hardware', 'calibration', 'policy', 'stopped', 'disabled', 'off', 'shifted', 'unknown_application'])(
    'withdraws experiment qualification when %s changes', async (reason) => {
      const test = fixture()
      await test.ready()
      const proof = await test.owner.experimentEvidence('left')
      if (reason === 'hardware') test.setIdentifiable(false)
      if (reason === 'calibration') test.identity.calibration = 'f'.repeat(64)
      if (reason === 'policy') test.configure({ config: { ...test.store.read('left').config, maximumF: 90 } })
      if (reason === 'stopped') test.setRunning(false)
      if (reason === 'disabled') test.setEnabled(false)
      if (reason === 'off') test.configure({ config: { ...test.store.read('left').config, mode: 'off' } })
      if (reason === 'shifted') test.configure({ config: { ...test.store.read('left').config, followBedtime: true } })
      if (reason === 'unknown_application') {
        test.configure({ application: { requestId: randomUUID(), segment: 'test-uncertain', targetF: 74, previousF: 75,
          createdAt: test.now() - 1, reservedAt: test.now(), finishedAt: test.now(), outcome: 'unknown', receiptId: null } })
      }
      expect(() => test.owner.assertExperimentEvidence('left', proof, true)).toThrow()
    },
  )

  it('rejects a changed qualification before a grant can be committed', async () => {
    const test = fixture()
    await test.ready()
    const proof = await test.owner.experimentEvidence('left')
    const qualification = proof.qualifications.find(value => value.kind === 'cooling')
    if (!qualification) throw new Error('Fixture cooling qualification is missing')
    await test.owner.retest('left', 'cooling', qualification.id)
    expect(() => test.owner.assertExperimentEvidence('left', proof, true)).toThrow('qualification changed')
  })

  it('requires retained source evidence when preparing a new experiment admission', async () => {
    const test = fixture()
    await test.ready()
    const proof = await test.owner.experimentEvidence('left')
    test.database.prepare('DELETE FROM comfort_events WHERE report_id = ?').run(proof.nights[0].summary.id)
    expect(() => test.owner.assertExperimentEvidence('left', proof, true)).toThrow()
    await expect(test.owner.experimentEvidence('left')).rejects.toThrow()
  })

  it('suspends ordinary adaptation in the same durable transaction without changing its schedule', async () => {
    const test = fixture()
    await test.ready()
    const activation = await test.owner.prepare({ side: 'left', purpose: 'activation', kind: null })
    await test.owner.confirm({ side: 'left', id: activation.id, confirmed: true, note: 'Synthetic test only.' })
    const proof = await test.owner.experimentEvidence('left')
    const before = test.store.read('left'), scheduled = test.database.prepare('SELECT * FROM alarm_schedules').all()
    expect(() => test.owner.suspendForExperiment('left', proof)).toThrow('durably')
    test.database.pragma('synchronous = NORMAL')
    expect(() => test.database.transaction(() => test.owner.suspendForExperiment('left', proof))()).toThrow('durably')
    test.deps.revokeLease.mockClear()
    durableTransaction(test.database, () => test.owner.suspendForExperiment('left', proof))
    expect(test.store.read('left')).toMatchObject({ config: { ...before.config, mode: 'preview' }, pausedUntil: before.pausedUntil })
    expect(test.owner.admission('left', test.store.read('left'))).toBeNull()
    expect(test.deps.revokeLease).toHaveBeenCalledOnce()
    expect(test.database.prepare('SELECT * FROM alarm_schedules').all()).toEqual(scheduled)
    expect(() => test.owner.assertExperimentEvidence('left', proof, false)).not.toThrow()
  })

  it('rolls suspension back if publishing the reviewed experiment grant fails', async () => {
    const test = fixture()
    await test.ready()
    const activation = await test.owner.prepare({ side: 'left', purpose: 'activation', kind: null })
    await test.owner.confirm({ side: 'left', id: activation.id, confirmed: true, note: 'Synthetic test only.' })
    const proof = await test.owner.experimentEvidence('left'), state = test.store.read('left')
    expect(() => durableTransaction(test.database, () => {
      test.owner.suspendForExperiment('left', proof)
      throw new Error('experiment grant could not persist')
    })).toThrow('could not persist')
    expect(test.store.read('left')).toEqual(state)
    expect(test.owner.admission('left', state)).not.toBeNull()
  })
})

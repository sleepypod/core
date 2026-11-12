import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTemperatureApplicationRecorder } from '@/src/temperature/applications'
import { migratedComfortDatabase } from '../../tests/databaseFixture'
import { DEVICE_MAX_AGE_MS } from '../../policy'
import { ExperimentApplicationStore } from '../applications'
import type { ExperimentApplicationReservation } from '../application-contract'
import { applicationFixture } from './applicationFixture'

const databases: ReturnType<typeof migratedComfortDatabase>[] = [], directories: string[] = []
function fixture(filename?: string) {
  const test = applicationFixture(filename)
  databases.push(test.database)
  const reservation: ExperimentApplicationReservation = { id: randomUUID(), planId: test.plan.id,
    planHash: test.admission.planHash, admissionRevision: test.admission.revision, side: 'left', nightDate: test.night.date,
    requestId: test.selectedId, targetF: test.night.targetF, previousF: 70, reservedAt: test.now() }
  return { ...test, reservation }
}
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('durable experiment application journal', () => {
  it('reserves with FULL synchronization and restores the prior pragma on success and rollback', () => {
    const test = fixture(), observed: number[] = []
    test.database.pragma('synchronous = NORMAL')
    test.journal.reserve(test.reservation, () => {
      observed.push(test.database.pragma('synchronous', { simple: true }) as number)
    })
    expect(observed).toEqual([2, 2])
    expect(test.database.pragma('synchronous', { simple: true })).toBe(1)
    expect(() => test.journal.reserve({ ...test.reservation, id: randomUUID() }, () => {})).toThrow('reviewed recovery')
    expect(test.database.pragma('synchronous', { simple: true })).toBe(1)
    expect(test.journal.latest('left')?.outcome).toBe('attempting')
  })

  it('retains unresolved intent across database close/reopen and rejects another process retry', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sleepypod-experiment-'))
    directories.push(directory)
    const filename = path.join(directory, 'state.db'), test = fixture(filename)
    test.journal.reserve(test.reservation, () => {})
    test.database.close()
    const database = migratedComfortDatabase(filename)
    databases.push(database)
    const reopened = new ExperimentApplicationStore(database, test.now)
    expect(reopened.latest('left')).toMatchObject({ outcome: 'attempting', reservation: test.reservation })
    expect(() => reopened.reserve({ ...test.reservation, id: randomUUID() }, () => {})).toThrow('reviewed recovery')
    expect(reopened.latest('right')).toBeNull()
  })

  it('requires the shared authority journal for acknowledgment, not an invented receipt', async () => {
    const test = fixture()
    test.journal.reserve(test.reservation, () => {})
    expect(() => test.journal.finish(test.reservation, { attemptId: randomUUID(), attemptedAt: test.now(), finishedAt: test.now(), outcome: 'acknowledged' }))
      .toThrow('does not confirm')
    expect(test.journal.latest('left')?.outcome).toBe('attempting')
    const receipt = await createTemperatureApplicationRecorder(test.database, test.now)({ side: 'left', targetF: test.night.targetF,
      durationSec: null, source: 'autopilot', reason: 'reconcile', requestId: test.selectedId }, async () => {})
    test.journal.finish(test.reservation, receipt)
    expect(test.journal.latest('left')).toMatchObject({ outcome: 'acknowledged', receiptId: receipt.attemptId })
  })

  it.each(['side', 'request', 'temperature', 'source', 'clock'])(
    'rejects a real acknowledgment with a different %s', async (difference) => {
      const test = fixture()
      test.journal.reserve(test.reservation, () => {})
      const receipt = await createTemperatureApplicationRecorder(test.database, test.now)({
        side: difference === 'side' ? 'right' : 'left', targetF: difference === 'temperature' ? 70 : test.night.targetF,
        durationSec: null, source: difference === 'source' ? 'schedule' : 'autopilot', reason: 'reconcile',
        requestId: difference === 'request' ? 'other' : test.selectedId,
      }, async () => {})
      if (difference === 'clock') receipt.finishedAt = test.now() + 1
      expect(() => test.journal.finish(test.reservation, receipt)).toThrow('does not confirm')
      test.journal.finish(test.reservation, null)
      expect(test.journal.latest('left')?.outcome).toBe('unknown')
    },
  )

  it('requires a fresh post-attempt readback and new admission after explicit recovery', () => {
    const test = fixture()
    test.journal.reserve(test.reservation, () => {})
    test.journal.finish(test.reservation, null)
    expect(() => test.journal.resolve(test.reservation.id, { targetF: 70, observedAt: test.now() }, () => {})).toThrow('fresh observation')
    test.advance(1000)
    expect(() => test.journal.resolve(test.reservation.id, { targetF: 70, observedAt: test.now() + 1 }, () => {})).toThrow('fresh observation')
    test.journal.resolve(test.reservation.id, { targetF: 70, observedAt: test.now() }, () => {})
    const next = { ...test.reservation, id: randomUUID(), reservedAt: test.now() }
    expect(() => test.journal.reserve(next, () => {})).toThrow('new admission')
    test.journal.reserve({ ...next, admissionRevision: randomUUID() }, () => {})
    expect(test.journal.latest('left')?.outcome).toBe('attempting')
  })

  it('rolls back recovery if authorization changes before commit', () => {
    const test = fixture()
    test.journal.reserve(test.reservation, () => {})
    test.advance(1000)
    let calls = 0
    expect(() => test.journal.resolve(test.reservation.id, { targetF: 69, observedAt: test.now() }, () => {
      if (++calls === 2) throw new Error('assignment changed')
    })).toThrow('assignment changed')
    expect(test.journal.latest('left')?.outcome).toBe('attempting')
    test.advance(DEVICE_MAX_AGE_MS)
    expect(() => test.journal.resolve(test.reservation.id, { targetF: 69, observedAt: test.now() - DEVICE_MAX_AGE_MS }, () => {})).toThrow('fresh observation')
  })

  it('rolls back reserved intent if its admission changes during the transaction', () => {
    const test = fixture()
    let calls = 0
    expect(() => test.journal.reserve(test.reservation, () => {
      if (++calls === 2) throw new Error('admission revoked')
    })).toThrow('admission revoked')
    expect(test.journal.latest('left')).toBeNull()
  })

  it.each(['stopped', 'before_window', 'after_window', 'wrong_target', 'wrong_plan', 'wrong_request', 'future_clock'])(
    'cannot reserve against %s evidence', (reason) => {
      const test = fixture(), reservation = { ...test.reservation }
      if (reason === 'stopped') test.plans.stop(test.plan.id, test.record().revision)
      if (reason === 'before_window') test.advance(test.window.windowStart - test.now() - 1)
      if (reason === 'after_window') test.advance(test.window.windowEnd - test.now())
      if (reason === 'wrong_target') reservation.targetF = 71
      if (reason === 'wrong_plan') reservation.planHash = 'f'.repeat(64)
      if (reason === 'wrong_request') reservation.requestId = 'other'
      reservation.reservedAt = test.now() + (reason === 'future_clock' ? 1 : 0)
      expect(() => test.journal.reserve(reservation, () => {})).toThrow()
      expect(test.journal.latest('left')).toBeNull()
    },
  )

  it('allows elapsed database time inside a valid lease without exact-millisecond equality', () => {
    const test = fixture()
    test.advance(2)
    test.journal.reserve(test.reservation, () => {})
    expect(test.journal.latest('left')?.reservation.reservedAt).toBe(test.reservation.reservedAt)
  })

  it('rejects a saved plan row whose ownership metadata no longer matches its content', () => {
    const test = fixture()
    test.database.prepare('UPDATE comfort_experiments SET subject_key = ? WHERE id = ?').run('f'.repeat(64), test.plan.id)
    expect(() => test.journal.reserve(test.reservation, () => {})).toThrow('no longer admits')
    expect(test.journal.latest('left')).toBeNull()
  })
})

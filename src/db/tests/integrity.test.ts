// @vitest-environment node
import type { EventEmitter } from 'node:events'
import type { WorkerOptions } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TestWorker = EventEmitter & { terminate: ReturnType<typeof vi.fn>, options: WorkerOptions }
const mocks = vi.hoisted(() => ({ workers: [] as TestWorker[], constructionError: null as Error | null }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Worker: class extends EventEmitter {
      constructor(_source: string, readonly options: WorkerOptions) {
        super()
        if (mocks.constructionError) throw mocks.constructionError
        mocks.workers.push(this)
      }

      unref() {}
      terminate = vi.fn(async () => {
        this.emit('exit', 1)
        return 1
      })
    },
  }
})

import { getDatabaseIntegrity, getDatabaseIntegrityByDb, startDatabaseIntegrityChecks, stopDatabaseIntegrityChecks } from '../integrity'

const report = (worker: TestWorker, key: 'sleepypod' | 'biometrics', error: string | null = null, latencyMs = 60) =>
  worker.emit('message', { key, error, latencyMs })

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__sp_database_integrity__
  mocks.workers.length = 0
  mocks.constructionError = null
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  vi.setSystemTime(new Date('2026-09-05T12:00:00Z'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  await stopDatabaseIntegrityChecks()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).__sp_database_integrity__
})

describe('background database integrity lifecycle', () => {
  it('starts once after a startup delay, then schedules from worker completion', async () => {
    startDatabaseIntegrityChecks()
    startDatabaseIntegrityChecks()
    expect(getDatabaseIntegrity()).toEqual({ status: 'pending', checkedAt: null, latencyMs: 0 })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(mocks.workers).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.workers).toHaveLength(1)
    startDatabaseIntegrityChecks()
    expect(mocks.workers).toHaveLength(1)
    expect(mocks.workers[0].options.workerData.databases.map((d: { key: string }) => d.key)).toEqual(['sleepypod', 'biometrics'])
    await vi.advanceTimersByTimeAsync(50)
    report(mocks.workers[0], 'sleepypod', null, 50)
    await vi.advanceTimersByTimeAsync(70)
    report(mocks.workers[0], 'biometrics', null, 70)
    expect(getDatabaseIntegrity().status).toBe('pending')
    mocks.workers[0].emit('exit', 0)
    expect(getDatabaseIntegrityByDb()).toEqual({
      sleepypod: { status: 'ok', checkedAt: '2026-09-05T12:00:30.050Z', latencyMs: 50 },
      biometrics: { status: 'ok', checkedAt: '2026-09-05T12:00:30.120Z', latencyMs: 70 },
    })
    expect(getDatabaseIntegrity()).toEqual({ status: 'ok', checkedAt: '2026-09-05T12:00:30.050Z', latencyMs: 120 })
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1)
    expect(mocks.workers).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.workers).toHaveLength(2)
  })

  it.each(['result', 'error', 'no-result'] as const)('reports degraded when the worker fails via %s', async (failure) => {
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    const worker = mocks.workers[0]
    report(worker, 'sleepypod')
    if (failure === 'result') report(worker, 'biometrics', 'database disk image is malformed')
    if (failure === 'error') worker.emit('error', new Error('worker crashed'))
    worker.emit('exit', 1)

    const expected = { 'result': 'database disk image is malformed', 'error': 'worker crashed', 'no-result': 'Integrity worker exited without a result' }[failure]
    expect(getDatabaseIntegrityByDb().sleepypod.status).toBe('ok')
    expect(getDatabaseIntegrityByDb().biometrics).toMatchObject({ status: 'degraded', error: expected })
    expect(getDatabaseIntegrity()).toMatchObject({ status: 'degraded', error: `biometrics.db: ${expected}` })
    expect(getDatabaseIntegrity().checkedAt).not.toBeNull()
  })

  it('names every degraded file in the combined error', async () => {
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    report(mocks.workers[0], 'sleepypod', 'row 3 missing from index')
    report(mocks.workers[0], 'biometrics', 'unable to open database file')
    mocks.workers[0].emit('exit', 0)

    expect(getDatabaseIntegrity()).toMatchObject({
      status: 'degraded',
      error: 'sleepypod.db: row 3 missing from index; biometrics.db: unable to open database file',
    })
  })

  it('stays pending until both databases have a result', () => {
    startDatabaseIntegrityChecks()
    const results = ((globalThis as Record<string, unknown>).__sp_database_integrity__ as { results: Record<string, unknown> }).results
    results.sleepypod = { status: 'ok', checkedAt: '2026-09-05T11:00:00.000Z', latencyMs: 5 }
    expect(getDatabaseIntegrity()).toEqual({ status: 'pending', checkedAt: null, latencyMs: 5 })
    results.biometrics = { status: 'ok', checkedAt: '2026-09-05T10:00:00.000Z', latencyMs: 7 }
    expect(getDatabaseIntegrity()).toEqual({ status: 'ok', checkedAt: '2026-09-05T10:00:00.000Z', latencyMs: 12 })
  })

  it('terminates a stalled scan and reports the timeout', async () => {
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    report(mocks.workers[0], 'sleepypod')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(mocks.workers[0].terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(mocks.workers[0].terminate).toHaveBeenCalledOnce()
    expect(getDatabaseIntegrityByDb().sleepypod.status).toBe('ok')
    expect(getDatabaseIntegrity()).toMatchObject({ status: 'degraded', error: 'biometrics.db: Integrity check timed out after 60s' })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(mocks.workers).toHaveLength(2)
  })

  it('does not publish or reschedule a scan terminated during shutdown', async () => {
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    report(mocks.workers[0], 'sleepypod')
    await stopDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)

    expect(mocks.workers[0].terminate).toHaveBeenCalledOnce()
    expect(mocks.workers).toHaveLength(1)
    expect(getDatabaseIntegrity().status).toBe('pending')
  })

  it('cancels the initial timer on shutdown and permits an explicit restart', async () => {
    startDatabaseIntegrityChecks()
    await stopDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.workers).toHaveLength(0)
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.workers).toHaveLength(1)
  })

  it('reports worker construction failures and retries on the next interval', async () => {
    mocks.constructionError = new Error('worker unavailable')
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getDatabaseIntegrityByDb()).toMatchObject({
      sleepypod: { status: 'degraded', error: 'worker unavailable' },
      biometrics: { status: 'degraded', error: 'worker unavailable' },
    })
    expect(getDatabaseIntegrity()).toMatchObject({ status: 'degraded', error: 'sleepypod.db: worker unavailable; biometrics.db: worker unavailable' })
    mocks.constructionError = null
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(mocks.workers).toHaveLength(1)
  })
})

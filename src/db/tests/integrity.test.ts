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

import { getDatabaseIntegrity, startDatabaseIntegrityChecks, stopDatabaseIntegrityChecks } from '../integrity'

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
    await vi.advanceTimersByTimeAsync(120)
    mocks.workers[0].emit('message', null)
    expect(getDatabaseIntegrity().status).toBe('pending')
    mocks.workers[0].emit('exit', 0)
    expect(getDatabaseIntegrity()).toEqual({ status: 'ok', checkedAt: '2026-09-05T12:00:30.120Z', latencyMs: 120 })
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1)
    expect(mocks.workers).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.workers).toHaveLength(2)
  })

  it.each(['result', 'error', 'no-result'] as const)('reports degraded when the worker fails via %s', async (failure) => {
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    const worker = mocks.workers[0]
    if (failure === 'result') worker.emit('message', 'database disk image is malformed')
    if (failure === 'error') worker.emit('error', new Error('worker crashed'))
    worker.emit('exit', 1)

    expect(getDatabaseIntegrity()).toMatchObject({ status: 'degraded', error: expect.any(String) })
    expect(getDatabaseIntegrity().checkedAt).not.toBeNull()
  })

  it('terminates a stalled scan and reports the timeout', async () => {
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(mocks.workers[0].terminate).toHaveBeenCalledOnce()
    expect(getDatabaseIntegrity()).toMatchObject({ status: 'degraded', error: 'Integrity check timed out after 30s' })
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(mocks.workers).toHaveLength(2)
  })

  it('does not publish or reschedule a scan terminated during shutdown', async () => {
    startDatabaseIntegrityChecks()
    await vi.advanceTimersByTimeAsync(30_000)
    mocks.workers[0].emit('message', null)
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
    expect(getDatabaseIntegrity()).toMatchObject({ status: 'degraded', error: 'worker unavailable' })
    mocks.constructionError = null
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(mocks.workers).toHaveLength(1)
  })
})

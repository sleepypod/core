import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Scheduler } from '../scheduler'
import { JobType } from '../types'

type ExecuteJob = (
  id: string,
  type: JobType,
  handler: () => Promise<void>,
) => Promise<{ success: boolean, error?: string }>

const executor = (scheduler: Scheduler): ExecuteJob =>
  (scheduler as unknown as { executeJob: ExecuteJob }).executeJob.bind(scheduler)

describe('Scheduler mutation pinning', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = new Scheduler({
      timezone: 'America/Los_Angeles',
      enabled: true,
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await scheduler.shutdown()
  })

  describe('cron firing', () => {
    it('runs the handler and emits jobExecuted when the cron rule fires', async () => {
      const handler = vi.fn(async () => {})
      const executed = new Promise<{ id: string, success: boolean }>((resolve) => {
        scheduler.on('jobExecuted', (id, result) => {
          resolve({ id, success: result.success })
        })
      })

      // Six-field rule: fire every second so the callback runs within the test.
      scheduler.scheduleJob('cron-fires', JobType.TEMPERATURE, '* * * * * *', handler)

      await expect(executed).resolves.toEqual({ id: 'cron-fires', success: true })
      expect(handler).toHaveBeenCalled()
    })
  })

  describe('retry loop bounds', () => {
    it('stops backing off after the final attempt instead of warning a fourth time', async () => {
      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const handler = vi.fn(async () => {
        throw new Error('always fails')
      })

      const resultPromise = executor(scheduler)('retry-exhausted', JobType.TEMPERATURE, handler)
      await vi.advanceTimersByTimeAsync(500)
      await vi.advanceTimersByTimeAsync(1_000)

      // All three attempts have been spent; only the two inter-attempt gaps warn.
      expect(handler).toHaveBeenCalledTimes(3)
      expect(warn.mock.calls).toEqual([
        ['Job retry-exhausted attempt 1/3 failed, retrying in 500ms:', 'always fails'],
        ['Job retry-exhausted attempt 2/3 failed, retrying in 1000ms:', 'always fails'],
      ])
      await expect(resultPromise).resolves.toMatchObject({
        success: false,
        error: 'always fails',
      })
    })
  })

  describe('in-flight bookkeeping', () => {
    it('drains the in-flight set for both settled and failed jobs', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const execute = executor(scheduler)

      await execute('drain-ok', JobType.REBOOT, async () => {})
      await execute('drain-fail', JobType.REBOOT, async () => {
        throw new Error('boom')
      })

      await scheduler.waitForInFlightJobs(50)

      expect(log).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    })

    it('polls until the in-flight job finishes rather than returning or timing out', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const running = executor(scheduler)(
        'slow-job',
        JobType.REBOOT,
        () => new Promise<void>(resolve => setTimeout(resolve, 300)),
      )

      const start = Date.now()
      await scheduler.waitForInFlightJobs(3_000)
      const elapsed = Date.now() - start

      expect(log).toHaveBeenCalledWith('Waiting for 1 in-flight job(s) to complete...')
      // Waited for the job, but returned on completion instead of burning the timeout.
      expect(elapsed).toBeGreaterThanOrEqual(100)
      expect(elapsed).toBeLessThan(1_500)
      expect(warn).not.toHaveBeenCalled()

      await running
    })
  })
})

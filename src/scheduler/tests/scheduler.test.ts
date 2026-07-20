import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Scheduler } from '../scheduler'
import { JobType } from '../types'

describe('Scheduler', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = new Scheduler({
      timezone: 'America/Los_Angeles',
      enabled: true,
    })
  })

  afterEach(async () => {
    // Assertions (including mutation-induced failures) must not leave global
    // timers or console/native-method spies active for the next test.
    vi.useRealTimers()
    vi.restoreAllMocks()
    await scheduler.shutdown()
  })

  describe('scheduleJob', () => {
    it('schedules a job with cron expression', () => {
      const handler = vi.fn(async () => {})
      const job = scheduler.scheduleJob(
        'test-job',
        JobType.TEMPERATURE,
        '0 0 * * *', // Every day at midnight
        handler
      )

      expect(job.id).toBe('test-job')
      expect(job.type).toBe(JobType.TEMPERATURE)
      expect(job.schedule).toBe('0 0 * * *')
    })

    it('replaces existing job with same ID', () => {
      const handler1 = vi.fn(async () => {})
      const handler2 = vi.fn(async () => {})

      scheduler.scheduleJob('test-job', JobType.TEMPERATURE, '0 0 * * *', handler1)
      scheduler.scheduleJob('test-job', JobType.POWER_ON, '0 1 * * *', handler2)

      const jobs = scheduler.getJobs()
      expect(jobs).toHaveLength(1)
      expect(jobs[0].type).toBe(JobType.POWER_ON)
    })

    it('includes metadata in scheduled job', () => {
      const handler = vi.fn(async () => {})
      const job = scheduler.scheduleJob(
        'test-job',
        JobType.TEMPERATURE,
        '0 0 * * *',
        handler,
        { side: 'left', temperature: 75 }
      )

      expect(job.metadata).toEqual({ side: 'left', temperature: 75 })
    })

    it('emits jobScheduled event', () => {
      const handler = vi.fn(async () => {})
      const listener = vi.fn()

      scheduler.on('jobScheduled', listener)
      const job = scheduler.scheduleJob('test-job', JobType.TEMPERATURE, '0 0 * * *', handler)

      expect(listener).toHaveBeenCalledWith(job)
    })
  })

  describe('cancelJob', () => {
    it('cancels a scheduled job', () => {
      const handler = vi.fn(async () => {})
      scheduler.scheduleJob('test-job', JobType.TEMPERATURE, '0 0 * * *', handler)

      const result = scheduler.cancelJob('test-job')

      expect(result).toBe(true)
      expect(scheduler.getJobs()).toHaveLength(0)
    })

    it('returns false if job does not exist', () => {
      const result = scheduler.cancelJob('nonexistent')
      expect(result).toBe(false)
    })

    it('emits jobCancelled event', () => {
      const handler = vi.fn(async () => {})
      const listener = vi.fn()

      scheduler.on('jobCancelled', listener)
      scheduler.scheduleJob('test-job', JobType.TEMPERATURE, '0 0 * * *', handler)
      scheduler.cancelJob('test-job')

      expect(listener).toHaveBeenCalledWith('test-job')
    })
  })

  describe('cancelAllJobs', () => {
    it('cancels all scheduled jobs', () => {
      const handler = vi.fn(async () => {})

      scheduler.scheduleJob('job-1', JobType.TEMPERATURE, '0 0 * * *', handler)
      scheduler.scheduleJob('job-2', JobType.POWER_ON, '0 1 * * *', handler)
      scheduler.scheduleJob('job-3', JobType.ALARM, '0 2 * * *', handler)

      scheduler.cancelAllJobs()

      expect(scheduler.getJobs()).toHaveLength(0)
    })

    it('cancels each native job and emits each exact id before clearing the map', () => {
      const handler = vi.fn(async () => {})
      const cancelled = vi.fn()
      scheduler.on('jobCancelled', cancelled)
      const first = scheduler.scheduleJob('job-1', JobType.TEMPERATURE, '0 0 * * *', handler)
      const second = scheduler.scheduleJob('job-2', JobType.ALARM, '0 1 * * *', handler)
      const firstCancel = vi.spyOn(first.job, 'cancel')
      const secondCancel = vi.spyOn(second.job, 'cancel')

      scheduler.cancelAllJobs()

      expect(firstCancel).toHaveBeenCalledOnce()
      expect(secondCancel).toHaveBeenCalledOnce()
      expect(cancelled.mock.calls).toEqual([['job-1'], ['job-2']])
      expect(scheduler.getJobs()).toEqual([])
    })
  })

  describe('getJobs', () => {
    it('returns all scheduled jobs', () => {
      const handler = vi.fn(async () => {})

      scheduler.scheduleJob('job-1', JobType.TEMPERATURE, '0 0 * * *', handler)
      scheduler.scheduleJob('job-2', JobType.POWER_ON, '0 1 * * *', handler)

      const jobs = scheduler.getJobs()

      expect(jobs).toHaveLength(2)
      expect(jobs.map(j => j.id)).toEqual(['job-1', 'job-2'])
    })
  })

  describe('getJob', () => {
    it('returns job by ID', () => {
      const handler = vi.fn(async () => {})
      scheduler.scheduleJob('test-job', JobType.TEMPERATURE, '0 0 * * *', handler)

      const job = scheduler.getJob('test-job')

      expect(job).toBeDefined()
      expect(job?.id).toBe('test-job')
    })

    it('returns undefined for nonexistent job', () => {
      const job = scheduler.getJob('nonexistent')
      expect(job).toBeUndefined()
    })
  })

  describe('getJobsByType', () => {
    it('returns jobs filtered by type', () => {
      const handler = vi.fn(async () => {})

      scheduler.scheduleJob('temp-1', JobType.TEMPERATURE, '0 0 * * *', handler)
      scheduler.scheduleJob('power-1', JobType.POWER_ON, '0 1 * * *', handler)
      scheduler.scheduleJob('temp-2', JobType.TEMPERATURE, '0 2 * * *', handler)

      const tempJobs = scheduler.getJobsByType(JobType.TEMPERATURE)

      expect(tempJobs).toHaveLength(2)
      expect(tempJobs.every(j => j.type === JobType.TEMPERATURE)).toBe(true)
    })
  })

  describe('isEnabled', () => {
    it('returns scheduler enabled status', () => {
      expect(scheduler.isEnabled()).toBe(true)
    })

    it('returns false when disabled', () => {
      const disabledScheduler = new Scheduler({
        timezone: 'America/Los_Angeles',
        enabled: false,
      })

      expect(disabledScheduler.isEnabled()).toBe(false)

      disabledScheduler.shutdown()
    })
  })

  describe('updateConfig', () => {
    it('updates scheduler configuration', () => {
      scheduler.updateConfig({ enabled: false })
      expect(scheduler.isEnabled()).toBe(false)
    })

    it('cancels recurring jobs when timezone changes so stale offsets cannot fire', () => {
      const handler = vi.fn(async () => {})
      scheduler.scheduleJob('tz-old', JobType.TEMPERATURE, '0 0 * * *', handler)
      expect(scheduler.getJob('tz-old')).toBeDefined()

      scheduler.updateConfig({ timezone: 'America/New_York' })
      expect(scheduler.getTimezone()).toBe('America/New_York')
      // Recurring job must be dropped — caller is responsible for reloading
      expect(scheduler.getJob('tz-old')).toBeUndefined()
    })

    it('preserves one-time jobs when timezone changes', () => {
      const future = new Date(Date.now() + 60_000)
      const handler = vi.fn(async () => {})
      scheduler.scheduleOneTimeJob('once-keep', JobType.AWAY_MODE, future, handler)

      scheduler.updateConfig({ timezone: 'America/New_York' })

      expect(scheduler.getJob('once-keep')).toBeDefined()
    })

    it('is a no-op when timezone is unchanged', () => {
      const handler = vi.fn(async () => {})
      scheduler.scheduleJob('tz-keep', JobType.TEMPERATURE, '0 0 * * *', handler)
      scheduler.updateConfig({ enabled: true, timezone: 'America/Los_Angeles' })
      expect(scheduler.getJob('tz-keep')).toBeDefined()
    })

    it('does not cancel recurring jobs when an unrelated config field changes', () => {
      const handler = vi.fn(async () => {})
      scheduler.scheduleJob('enabled-only', JobType.TEMPERATURE, '0 0 * * *', handler)

      scheduler.updateConfig({ enabled: false })

      expect(scheduler.getJob('enabled-only')).toBeDefined()
    })
  })

  describe('cancelRecurringJobs', () => {
    it('preserves AWAY_MODE one-time jobs', () => {
      const future = new Date(Date.now() + 60_000)
      const handler = vi.fn(async () => {})

      scheduler.scheduleJob('cron-temp', JobType.TEMPERATURE, '0 0 * * *', handler)
      scheduler.scheduleOneTimeJob('away-start-left', JobType.AWAY_MODE, future, handler)
      scheduler.scheduleOneTimeJob('runonce-1', JobType.RUN_ONCE, future, handler)

      scheduler.cancelRecurringJobs()

      expect(scheduler.getJob('cron-temp')).toBeUndefined()
      expect(scheduler.getJob('away-start-left')).toBeDefined()
      expect(scheduler.getJob('runonce-1')).toBeDefined()
    })
  })

  describe('job retry for hardware failures', () => {
    it('uses exact exponential delays and warning text between attempts', async () => {
      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const handler = vi.fn()
        .mockRejectedValueOnce(new Error('first'))
        .mockRejectedValueOnce('second')
        .mockResolvedValueOnce(undefined)
      const execute = (scheduler as unknown as {
        executeJob: (
          id: string,
          type: JobType,
          handler: () => Promise<void>,
        ) => Promise<{ success: boolean }>
      }).executeJob.bind(scheduler)

      const resultPromise = execute('retry-delays', JobType.TEMPERATURE, handler)
      await vi.advanceTimersByTimeAsync(500)
      expect(handler).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(resultPromise).resolves.toMatchObject({ success: true })
      expect(handler).toHaveBeenCalledTimes(3)
      expect(warn.mock.calls).toEqual([
        ['Job retry-delays attempt 1/3 failed, retrying in 500ms:', 'first'],
        ['Job retry-delays attempt 2/3 failed, retrying in 1000ms:', 'second'],
      ])
      vi.useRealTimers()
    })

    it('retries a failing hardware job up to 3 attempts', async () => {
      const future = new Date(Date.now() + 30)
      let calls = 0
      const handler = vi.fn(async () => {
        calls++
        if (calls < 2) throw new Error('transient hw fail')
      })

      scheduler.scheduleOneTimeJob('retry-succeeds', JobType.TEMPERATURE, future, handler)

      await new Promise((resolve) => {
        scheduler.on('jobExecuted', (id, result) => {
          if (id === 'retry-succeeds') {
            expect(result.success).toBe(true)
            expect(handler).toHaveBeenCalledTimes(2)
            resolve(undefined)
          }
        })
      })
    })

    it('does not retry non-hardware jobs', async () => {
      const future = new Date(Date.now() + 30)
      const handler = vi.fn(async () => {
        throw new Error('fatal')
      })

      scheduler.scheduleOneTimeJob('no-retry', JobType.REBOOT, future, handler)

      await new Promise((resolve) => {
        scheduler.on('jobExecuted', (id, result) => {
          if (id === 'no-retry') {
            expect(result.success).toBe(false)
            expect(handler).toHaveBeenCalledTimes(1)
            resolve(undefined)
          }
        })
      })
    })

    it('surfaces last error via jobError after exhausting retries', async () => {
      const future = new Date(Date.now() + 30)
      const handler = vi.fn(async () => {
        throw new Error('always fails')
      })
      const errorListener = vi.fn()
      scheduler.on('jobError', errorListener)

      scheduler.scheduleOneTimeJob('retry-fails', JobType.POWER_ON, future, handler)

      await new Promise((resolve) => {
        scheduler.on('jobExecuted', (id, result) => {
          if (id === 'retry-fails') {
            expect(result.success).toBe(false)
            expect(result.error).toBe('always fails')
            expect(handler).toHaveBeenCalledTimes(3)
            expect(errorListener).toHaveBeenCalledTimes(1)
            resolve(undefined)
          }
        })
      })
    }, 10000)
  })

  describe('schedule failure surfaces', () => {
    it('scheduleJob throws when node-schedule returns null (invalid cron)', () => {
      const handler = vi.fn(async () => {})
      expect(() =>
        scheduler.scheduleJob('bad', JobType.TEMPERATURE, 'this is not a cron', handler),
      ).toThrow('Failed to schedule job: bad')
    })

    it('scheduleOneTimeJob throws when the fire date is in the past', () => {
      const handler = vi.fn(async () => {})
      const past = new Date(Date.now() - 60_000)
      expect(() =>
        scheduler.scheduleOneTimeJob(
          'past-one',
          JobType.TEMPERATURE,
          past,
          handler,
        ),
      ).toThrow(
        `Failed to schedule one-time job: past-one at ${past.toISOString()}`,
      )
    })
  })

  describe('waitForInFlightJobs', () => {
    it('returns immediately when no jobs are in flight', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      // No in-flight jobs — should resolve without delay
      const start = Date.now()
      await scheduler.waitForInFlightJobs(1000)
      expect(Date.now() - start).toBeLessThan(100)
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Waiting for'))
    })

    it('warns when in-flight jobs exceed timeout (force-shutdown path)', async () => {
      let release: () => void = () => {}
      const stuck = new Promise<void>((resolve) => {
        release = resolve
      })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Schedule a one-time job that hangs until we release it
      const future = new Date(Date.now() + 50)
      scheduler.scheduleOneTimeJob('hang', JobType.AWAY_MODE, future, async () => stuck)

      // Wait for the job to actually start (in-flight)
      await new Promise(resolve => setTimeout(resolve, 100))
      try {
        await scheduler.waitForInFlightJobs(150)

        expect(warnSpy).toHaveBeenCalledWith(
          'Force shutdown with 1 in-flight job(s) still running: hang',
        )
      }
      finally {
        release()
      }
    })
  })

  describe('shutdown logging', () => {
    it('logs the exact start and success messages', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})

      await scheduler.shutdown()

      expect(log).toHaveBeenCalledWith('Shutting down scheduler...')
      expect(log).toHaveBeenCalledWith('Scheduler shut down successfully')
    })
  })

  describe('getNextInvocation', () => {
    it('returns next invocation time for job', () => {
      const handler = vi.fn(async () => {})
      scheduler.scheduleJob('test-job', JobType.TEMPERATURE, '0 0 * * *', handler)

      const nextRun = scheduler.getNextInvocation('test-job')

      // node-schedule returns CronDate which has getTime() method
      expect(nextRun).toBeTruthy()
      if (nextRun) {
        expect(typeof nextRun.getTime).toBe('function')
        expect(nextRun.getTime()).toBeGreaterThan(Date.now())
      }
    })

    it('returns null for nonexistent job', () => {
      const nextRun = scheduler.getNextInvocation('nonexistent')
      expect(nextRun).toBeNull()
    })
  })
})

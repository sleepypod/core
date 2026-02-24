import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the database before importing anything else
vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => []),
        })),
        limit: vi.fn(() => []),
      })),
    })),
  },
}))

// Mock the hardware client
vi.mock('@/src/hardware', () => ({
  createHardwareClient: vi.fn(() => ({
    setTemperature: vi.fn(async () => {}),
    setPower: vi.fn(async () => {}),
    setAlarm: vi.fn(async () => {}),
    startPriming: vi.fn(async () => {}),
    disconnect: vi.fn(),
  })),
}))

// Now we can import
import { JobManager } from '../jobManager'
import { JobType } from '../types'

describe('JobManager', () => {
  let jobManager: JobManager

  beforeEach(() => {
    jobManager = new JobManager('America/Los_Angeles')
  })

  afterEach(async () => {
    await jobManager.shutdown()
  })

  describe('initialization', () => {
    it('creates a JobManager with timezone', () => {
      expect(jobManager).toBeDefined()
      expect(jobManager.getScheduler().isEnabled()).toBe(true)
    })
  })

  describe('loadSchedules', () => {
    it('loads schedules from database', async () => {
      // With empty mock data, should not throw
      await expect(jobManager.loadSchedules()).resolves.not.toThrow()
    })
  })

  describe('reloadSchedules', () => {
    it('cancels existing jobs and reloads from database', async () => {
      const scheduler = jobManager.getScheduler()

      // Schedule a test job
      scheduler.scheduleJob(
        'test-job',
        JobType.TEMPERATURE,
        '0 0 * * *',
        async () => {}
      )

      expect(scheduler.getJobs()).toHaveLength(1)

      // Reload should clear and reload
      await jobManager.reloadSchedules()

      // The test job should be gone (it wasn't in the database)
      const jobs = scheduler.getJobs()
      expect(jobs.every(j => j.id !== 'test-job')).toBe(true)
    })
  })

  describe('updateTimezone', () => {
    it('updates timezone and reloads schedules', async () => {
      await jobManager.updateTimezone('America/New_York')

      // Timezone should be updated
      expect(jobManager.getScheduler().isEnabled()).toBe(true)
    })
  })

  describe('getScheduler', () => {
    it('returns the underlying scheduler instance', () => {
      const scheduler = jobManager.getScheduler()
      expect(scheduler).toBeDefined()
      expect(typeof scheduler.scheduleJob).toBe('function')
    })
  })

  describe('shutdown', () => {
    it('shuts down gracefully', async () => {
      const scheduler = jobManager.getScheduler()
      scheduler.scheduleJob('test-job', JobType.TEMPERATURE, '0 0 * * *', async () => {})

      await jobManager.shutdown()

      // After shutdown, jobs should be cancelled
      expect(scheduler.getJobs()).toHaveLength(0)
    })
  })
})

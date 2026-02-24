import { describe, it, expect, afterEach, vi } from 'vitest'
import { getJobManager, shutdownJobManager } from '../instance'

// Mock the database
vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        limit: vi.fn(() => [{ timezone: 'America/Los_Angeles' }]),
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

describe('JobManager Instance', () => {
  afterEach(async () => {
    await shutdownJobManager()
  })

  describe('getJobManager', () => {
    it('creates a singleton instance', async () => {
      const instance1 = await getJobManager()
      const instance2 = await getJobManager()

      expect(instance1).toBe(instance2)
    })

    it('initializes with timezone from database', async () => {
      const instance = await getJobManager()

      expect(instance).toBeDefined()
      expect(instance.getScheduler()).toBeDefined()
    })

    it('loads schedules on initialization', async () => {
      const consoleSpy = vi.spyOn(console, 'log')

      await getJobManager()

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('JobManager initialized')
      )

      consoleSpy.mockRestore()
    })
  })

  describe('shutdownJobManager', () => {
    it('shuts down the global instance', async () => {
      const instance = await getJobManager()
      expect(instance).toBeDefined()

      await shutdownJobManager()

      // After shutdown, next call should create a new instance
      const newInstance = await getJobManager()
      expect(newInstance).not.toBe(instance)
    })

    it('handles shutdown when no instance exists', async () => {
      await expect(shutdownJobManager()).resolves.not.toThrow()
    })
  })
})

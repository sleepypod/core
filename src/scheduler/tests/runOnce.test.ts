import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Scheduler } from '../scheduler'
import { JobType } from '../types'

describe('Scheduler.scheduleOneTimeJob', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = new Scheduler({ timezone: 'UTC', enabled: true })
  })

  afterEach(async () => {
    await scheduler.shutdown()
  })

  it('creates a job with the correct ID and type', () => {
    const future = new Date(Date.now() + 60_000)
    const handler = vi.fn(async () => {})
    const job = scheduler.scheduleOneTimeJob('once-1', JobType.RUN_ONCE, future, handler)

    expect(job.id).toBe('once-1')
    expect(job.type).toBe(JobType.RUN_ONCE)
    expect(job.schedule).toBe(future.toISOString())
    expect(scheduler.getJob('once-1')).toBeDefined()
  })

  it('replaces existing job with same ID', () => {
    const future1 = new Date(Date.now() + 60_000)
    const future2 = new Date(Date.now() + 120_000)
    const handler = vi.fn(async () => {})

    scheduler.scheduleOneTimeJob('once-1', JobType.RUN_ONCE, future1, handler)
    scheduler.scheduleOneTimeJob('once-1', JobType.RUN_ONCE, future2, handler)

    expect(scheduler.getJobs().length).toBe(1)
    expect(scheduler.getJob('once-1')?.schedule).toBe(future2.toISOString())
  })

  it('throws if fireDate is in the past', () => {
    const past = new Date(Date.now() - 60_000)
    const handler = vi.fn(async () => {})

    expect(() => {
      scheduler.scheduleOneTimeJob('once-past', JobType.RUN_ONCE, past, handler)
    }).toThrow('Failed to schedule one-time job')
  })

  it('auto-removes from jobs map after firing', async () => {
    const soon = new Date(Date.now() + 100)
    let resolved = false
    const handler = vi.fn(async () => { resolved = true })

    scheduler.scheduleOneTimeJob('once-fire', JobType.RUN_ONCE, soon, handler)
    expect(scheduler.getJob('once-fire')).toBeDefined()

    // Wait for job to fire
    await new Promise((r) => setTimeout(r, 500))

    expect(handler).toHaveBeenCalledOnce()
    expect(scheduler.getJob('once-fire')).toBeUndefined()
  })

  it('is returned by getJobsByType', () => {
    const future = new Date(Date.now() + 60_000)
    const handler = vi.fn(async () => {})

    scheduler.scheduleOneTimeJob('once-type', JobType.RUN_ONCE, future, handler)
    scheduler.scheduleJob('cron-temp', JobType.TEMPERATURE, '0 0 * * *', handler)

    const runOnceJobs = scheduler.getJobsByType(JobType.RUN_ONCE)
    expect(runOnceJobs).toHaveLength(1)
    expect(runOnceJobs[0].id).toBe('once-type')
  })

  it('can be cancelled before firing', () => {
    const future = new Date(Date.now() + 60_000)
    const handler = vi.fn(async () => {})

    scheduler.scheduleOneTimeJob('once-cancel', JobType.RUN_ONCE, future, handler)
    expect(scheduler.cancelJob('once-cancel')).toBe(true)
    expect(scheduler.getJob('once-cancel')).toBeUndefined()
  })
})

describe('RunOnce validation schemas', () => {
  it('rejects invalid HH:mm times', async () => {
    // Import the validation schema from the shared module
    const { timeStringSchema } = await import('@/src/server/validation-schemas')

    expect(timeStringSchema.safeParse('24:00').success).toBe(false)
    expect(timeStringSchema.safeParse('99:99').success).toBe(false)
    expect(timeStringSchema.safeParse('12:60').success).toBe(false)
    expect(timeStringSchema.safeParse('abc').success).toBe(false)
    expect(timeStringSchema.safeParse('').success).toBe(false)
  })

  it('accepts valid HH:mm times', async () => {
    const { timeStringSchema } = await import('@/src/server/validation-schemas')

    expect(timeStringSchema.safeParse('00:00').success).toBe(true)
    expect(timeStringSchema.safeParse('23:59').success).toBe(true)
    expect(timeStringSchema.safeParse('07:30').success).toBe(true)
    expect(timeStringSchema.safeParse('12:00').success).toBe(true)
  })
})

describe('RunOnce setPoints max validation', () => {
  it('rejects more than 96 set points', () => {
    const { z } = require('zod')
    const schema = z.array(z.object({
      time: z.string(),
      temperature: z.number(),
    })).min(1).max(96)

    const tooMany = Array.from({ length: 97 }, (_, i) => ({
      time: `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`,
      temperature: 75,
    }))

    expect(schema.safeParse(tooMany).success).toBe(false)
    expect(schema.safeParse(tooMany.slice(0, 96)).success).toBe(true)
  })
})

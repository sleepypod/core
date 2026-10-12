import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { biometrics } from '../handlers/biometrics'
import { demoNights, demoVitals } from '../history'

function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}

const NOW = Date.UTC(2026, 9, 10, 12)

describe('demo biometrics.getReferenceVitals', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the Watch overlay for the latest night, ascending and every fifth pod sample', async () => {
    const night = demoNights('left')[0]
    const startDate = new Date(night.vitals[0].t)
    const endDate = new Date(night.vitals[night.vitals.length - 1].t)
    const out = await required(biometrics.getReferenceVitals)({ side: 'left', startDate, endDate, limit: 5000 })

    const pod = demoVitals('left', startDate.getTime(), endDate.getTime())
    expect(out.length).toBe(Math.ceil(pod.length / 5))
    expect(out.every(s => s.side === 'left' && s.source === 'apple_watch')).toBe(true)
    const times = out.map(s => s.timestamp.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(out[0].heartRate).toBeCloseTo(Math.round((pod[0].heartRate - 1.5) * 10) / 10, 5)
    expect(out[0].createdAt.getTime()).toBe(out[0].timestamp.getTime())
  })

  it('keeps the newest samples when the limit is smaller than the window', async () => {
    const night = demoNights('left')[0]
    const startDate = new Date(night.vitals[0].t)
    const endDate = new Date(night.vitals[night.vitals.length - 1].t)
    const all = await required(biometrics.getReferenceVitals)({ side: 'left', startDate, endDate, limit: 5000 })
    const tail = await required(biometrics.getReferenceVitals)({ side: 'left', startDate, endDate, limit: 3 })
    expect(tail.map(s => s.id)).toEqual(all.slice(-3).map(s => s.id))
  })

  it('rejects a window whose start is after its end', async () => {
    const startDate = new Date(NOW)
    const endDate = new Date(NOW - 1000)
    await expect(async () => required(biometrics.getReferenceVitals)({ side: 'left', startDate, endDate, limit: 10 }))
      .rejects.toThrow(/startDate must be before or equal to endDate/)
  })
})

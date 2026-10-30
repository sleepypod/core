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

  it('returns the synthetic Watch overlay on a fixed five-minute grid', async () => {
    const night = demoNights('left')[0]
    const startDate = new Date(night.vitals[0].t)
    const endDate = new Date(night.vitals[night.vitals.length - 1].t)
    const out = await required(biometrics.getReferenceVitals)({ side: 'left', startDate, endDate, limit: 5000 })

    const pod = demoVitals('left', startDate.getTime(), endDate.getTime())
    const expectedTimes: number[] = []
    for (let timestamp = Math.ceil(pod[0].t / 300_000) * 300_000; timestamp <= pod[pod.length - 1].t; timestamp += 300_000) {
      if (pod.some(point => Math.abs(point.t - timestamp) <= 60_000)) expectedTimes.push(timestamp)
    }
    expect(out.map(row => row.timestamp.getTime())).toEqual(expectedTimes)
    expect(out.every(s => s.side === 'left' && s.source === 'apple_watch')).toBe(true)
    const times = out.map(s => s.timestamp.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    const closest = pod.reduce((left, right) => Math.abs(right.t - out[0].timestamp.getTime()) < Math.abs(left.t - out[0].timestamp.getTime()) ? right : left)
    expect(out[0].heartRate).toBeCloseTo(Math.round((closest.heartRate - 1.5) * 10) / 10, 5)
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

  it.each(['hrv_sdnn', 'breathing_rate'] as const)('keeps %s stable across overlapping windows, limits and gaps', async (metric) => {
    const night = demoNights('left')[0]
    const input = { side: 'left' as const, startDate: night.enteredBedAt, endDate: night.leftBedAt ?? new Date(), metric }
    const all = await required(biometrics.getReferenceSamples)(input)
    expect(all.length).toBeGreaterThan(2)
    const startDate = new Date(all[1].timestamp.getTime() - 60_000)
    expect(await required(biometrics.getReferenceSamples)({ ...input, startDate })).toEqual(all.filter(row => row.timestamp >= startDate))
    expect(await required(biometrics.getReferenceSamples)({ ...input, limit: 2 })).toEqual(all.slice(-2))
    expect(await required(biometrics.getReferenceSamples)({ ...input, startDate: all[1].timestamp, endDate: all[1].timestamp })).toEqual([all[1]])
    expect(all.every(row => row.timestamp.getTime() % 300_000 === 0)).toBe(true)
    await expect(async () => required(biometrics.getReferenceSamples)({ ...input, startDate: input.endDate, endDate: new Date(0) })).rejects.toThrow(/startDate/)
  })
})

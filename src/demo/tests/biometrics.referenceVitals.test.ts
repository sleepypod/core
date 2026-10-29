import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { biometrics } from '../handlers/biometrics'
import { demoNights, demoVitals } from '../history'

function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}

const NOW = Date.UTC(2026, 9, 10, 12)

// Every case needs a completed synthetic night, even when CI runs at bedtime.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('demo biometrics.getReferenceVitals', () => {
  it('returns the Watch overlay for the latest night, ascending on a fixed five-minute grid', async () => {
    const night = demoNights('left')[0]
    const startDate = new Date(night.vitals[0].t)
    const endDate = new Date(night.vitals[night.vitals.length - 1].t)
    const out = await required(biometrics.getReferenceVitals)({ side: 'left', startDate, endDate, limit: 5000 })

    const pod = demoVitals('left', startDate.getTime(), endDate.getTime())
    const expectedTimes: number[] = []
    for (let t = Math.ceil(pod[0].t / 300_000) * 300_000; t <= pod[pod.length - 1].t; t += 300_000) {
      if (pod.some(p => Math.abs(p.t - t) <= 60_000)) expectedTimes.push(t)
    }
    expect(out.map(r => r.timestamp.getTime())).toEqual(expectedTimes)
    expect(out.every(s => s.side === 'left' && s.source === 'apple_watch')).toBe(true)
    const times = out.map(s => s.timestamp.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(out[0].heartRate).toBeCloseTo(Math.round((pod.reduce((a, b) => Math.abs(b.t - out[0].timestamp.getTime()) < Math.abs(a.t - out[0].timestamp.getTime()) ? b : a).heartRate - 1.5) * 10) / 10, 5)
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

describe('demo reference samples and stages', () => {
  it.each(['hrv_sdnn', 'breathing_rate'] as const)('returns chronological %s samples and keeps the newest when limited', async (metric) => {
    const night = demoNights('left')[0]
    const input = { side: 'left' as const, startDate: night.enteredBedAt, endDate: (night.leftBedAt ?? new Date()), metric }
    const all = await required(biometrics.getReferenceSamples)(input)
    expect(all.length).toBeGreaterThan(3)
    expect(all.map(r => r.timestamp.getTime())).toEqual(all.map(r => r.timestamp.getTime()).sort((a, b) => a - b))
    expect(await required(biometrics.getReferenceSamples)({ ...input, limit: 3 })).toEqual(all.slice(-3))
    await expect(async () => required(biometrics.getReferenceSamples)({ ...input, startDate: input.endDate, endDate: new Date(0) })).rejects.toThrow(/startDate/)
  })
  it('returns overlapping Watch stage blocks for the chosen side and honors the limit', async () => {
    const night = demoNights('right')[0]
    const input = { side: 'right' as const, startDate: night.enteredBedAt, endDate: (night.leftBedAt ?? new Date()) }
    const all = await required(biometrics.getReferenceStages)(input)
    expect(all.length).toBeGreaterThan(2)
    expect(all.every(b => b.side === 'right' && b.end > input.startDate && b.start <= input.endDate)).toBe(true)
    expect(await required(biometrics.getReferenceStages)({ ...input, limit: 2 })).toEqual(all.slice(0, 2))
    await expect(async () => required(biometrics.getReferenceStages)({ ...input, startDate: input.endDate, endDate: new Date(0) })).rejects.toThrow(/startDate/)
  })
})

it.each(['hrv_sdnn', 'breathing_rate'] as const)('keeps %s samples stable across overlapping windows and distinct from pod values', async (metric) => {
  const night = demoNights('left')[0]
  const input = { side: 'left' as const, startDate: night.enteredBedAt, endDate: night.leftBedAt ?? new Date(), metric }
  const all = await required(biometrics.getReferenceSamples)(input)
  const startDate = new Date(all[1].timestamp.getTime() - 60_000)
  const partial = await required(biometrics.getReferenceSamples)({ ...input, startDate })
  expect(partial).toEqual(all.filter(r => r.timestamp >= startDate))
  const pod = demoVitals('left', input.startDate.getTime(), input.endDate.getTime())
  for (const sample of all) {
    expect(sample.timestamp.getTime() % 300_000).toBe(0)
    const point = pod.reduce((a, b) => Math.abs(b.t - sample.timestamp.getTime()) < Math.abs(a.t - sample.timestamp.getTime()) ? b : a)
    expect(point).toBeDefined()
    if (!point) throw new Error('Expected matching pod sample')
    expect(sample.value).not.toBe(metric === 'hrv_sdnn' ? point.hrv : point.breathingRate)
  }
  expect(all.slice(1).some((r, i) => r.timestamp.getTime() - all[i].timestamp.getTime() === 300_000)).toBe(true)
  expect(await required(biometrics.getReferenceSamples)({ ...input, startDate: all[1].timestamp, endDate: all[1].timestamp })).toEqual([all[1]])
})

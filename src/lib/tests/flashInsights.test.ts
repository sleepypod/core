import { describe, expect, it } from 'vitest'
import { flashInsights } from '../flashInsights'

const HOUR = 3_600_000
const sample = (hour: number, sectors: number, bootId = 'a') => ({ at: hour * HOUR, sectorsWritten: sectors, bootId })

describe('flashInsights', () => {
  it('projects bytes per day and exposes the measured total separately', () => {
    const result = flashInsights([sample(0, 100), sample(1, 200), sample(2, 400)], 2 * HOUR)
    expect(result.windows[0]).toEqual({ hours: 1, coveredHours: 1, bytes: 200 * 512, bytesPerDay: 200 * 512 * 24 })
    expect(result.windows[1]).toEqual({ hours: 24, coveredHours: 2, bytes: 300 * 512, bytesPerDay: 150 * 512 * 24 })
    expect(result.history).toHaveLength(24)
    expect(result.history[0].bytesPerDay).toBeNull()
    expect(result.history[23].bytesPerDay).toBe(200 * 512 * 24)
  })

  it('prorates boundaries without including writes outside the window', () => {
    const result = flashInsights([sample(0, 0), sample(1, 100), sample(2, 300)], 2.5 * HOUR)
    expect(result.windows[0]).toEqual({ hours: 1, coveredHours: 0.5, bytes: 100 * 512, bytesPerDay: null })
    const live = flashInsights([sample(0, 0), sample(1, 100), sample(2, 300), sample(2.5, 400)], 2.5 * HOUR)
    expect(live.windows[0].bytesPerDay).toBe(200 * 512 * 24)
  })

  it('excludes reboots, counter resets and long gaps from both bytes and coverage', () => {
    const result = flashInsights([
      sample(0, 0), sample(1, 100), sample(2, 500, 'b'),
      sample(3, 600, 'b'), sample(4, 10, 'b'), sample(8, 1000, 'b'),
    ], 8 * HOUR)
    expect(result.windows[1].coveredHours).toBe(2)
    expect(result.windows[1].bytes).toBe(200 * 512)
    expect(result.windows[0].bytesPerDay).toBeNull()
  })

  it('distinguishes zero writes from missing measurements and waits an hour', () => {
    expect(flashInsights([], HOUR).windows[0].bytesPerDay).toBeNull()
    expect(flashInsights([sample(0, 0), sample(0.5, 0)], HOUR).windows[0].bytesPerDay).toBeNull()
    expect(flashInsights([sample(0, 42), sample(1, 42)], HOUR).windows[0].bytesPerDay).toBe(0)
  })

  it('ignores future and invalid samples and orders valid samples', () => {
    const result = flashInsights([sample(1, 100), sample(0, 0), sample(2, 999), sample(0.5, -1), sample(0.4, NaN)], HOUR)
    expect(result.windows[0].bytesPerDay).toBe(100 * 512 * 24)
  })

  it('keeps each rate within its requested window', () => {
    const samples = Array.from({ length: 171 }, (_, i) => sample(i, i * 100))
    expect(flashInsights(samples, 170 * HOUR).windows.map(w => w.coveredHours)).toEqual([1, 24, 168])
  })
})

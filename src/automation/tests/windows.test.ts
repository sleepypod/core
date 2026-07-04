import { describe, expect, it } from 'vitest'
import { WindowStore } from '../windows'

const MIN = 60_000

describe('WindowStore', () => {
  it('aggregates avg/min/max/sum/count over a trailing window', () => {
    const w = new WindowStore()
    const now = 100 * MIN
    w.record('m', 100, now - 9 * MIN)
    w.record('m', 200, now - 5 * MIN)
    w.record('m', 300, now - 1 * MIN)

    expect(w.aggregate('avg', 'm', 10, now)).toBe(200)
    expect(w.aggregate('min', 'm', 10, now)).toBe(100)
    expect(w.aggregate('max', 'm', 10, now)).toBe(300)
    expect(w.aggregate('sum', 'm', 10, now)).toBe(600)
    expect(w.aggregate('count', 'm', 10, now)).toBe(3)
  })

  it('excludes samples older than the window', () => {
    const w = new WindowStore()
    const now = 100 * MIN
    w.record('m', 100, now - 20 * MIN) // out of window
    w.record('m', 400, now - 2 * MIN)
    expect(w.aggregate('avg', 'm', 10, now)).toBe(400)
    expect(w.aggregate('count', 'm', 10, now)).toBe(1)
  })

  it('returns undefined for unknown keys and empty windows (except count)', () => {
    const w = new WindowStore()
    const now = 100 * MIN
    expect(w.aggregate('avg', 'missing', 10, now)).toBeUndefined()
    w.record('m', 50, now - 30 * MIN)
    expect(w.aggregate('avg', 'm', 10, now)).toBeUndefined() // exists but empty in-window
    expect(w.aggregate('count', 'm', 10, now)).toBe(0)
  })

  it('prunes samples older than maxAgeMin', () => {
    const w = new WindowStore()
    const now = 100 * MIN
    w.record('m', 1, now - 90 * MIN)
    w.record('m', 2, now - 2 * MIN)
    w.prune(now, 60)
    expect(w.aggregate('count', 'm', 120, now)).toBe(1)
  })

  it('drops a buffer entirely when every sample ages out', () => {
    const w = new WindowStore()
    const now = 100 * MIN
    w.record('m', 1, now - 90 * MIN)
    w.record('m', 2, now - 80 * MIN)
    w.prune(now, 60)
    // Both samples pruned → key removed → unknown key, not an empty in-window.
    expect(w.aggregate('count', 'm', 120, now)).toBeUndefined()
  })
})

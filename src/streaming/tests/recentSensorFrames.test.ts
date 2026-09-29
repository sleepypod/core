// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RecentSensorFrames } from '../recentSensorFrames'

const piezo = (ts: number) => ({ type: 'piezo-dual', ts, freq: 500, left1: [ts], right1: [ts] })

describe('recent sensor display cache', () => {
  it('snapshots latest values and only the last ten seconds, preserving equal-timestamp frames', () => {
    const cache = new RecentSensorFrames()
    cache.add({ type: 'bedTemp', ts: 70, value: 1 }, 100)
    cache.add({ type: 'bedTemp', ts: 60, value: 2 }, 100)
    for (const ts of [59, 65, 89, 90, 99, 99, 100]) cache.add(piezo(ts), 100)
    expect(cache.snapshot(undefined, 100)).toEqual({
      latest: [{ type: 'bedTemp', ts: 70, value: 1 }],
      waveform: [90, 99, 99, 100].map(piezo),
    })
    expect(cache.snapshot(new Set(['bedTemp']), 100).waveform).toEqual([])
    expect(cache.snapshot(new Set(['piezo-dual']), 100).latest).toEqual([])
    expect(cache.range(100)).toEqual({ min: 65, max: 100 })
    expect(cache.window(65, 100)).toEqual([piezo(65)])
  })

  it('expires an idle waveform and rejects future, invalid and oversized records', () => {
    const cache = new RecentSensorFrames()
    cache.add(piezo(100), 100)
    cache.add(piezo(106), 100)
    cache.add(piezo(NaN), 100)
    cache.add({ ...piezo(100), extra: 'x'.repeat(70_000) }, 100)
    expect(cache.window(100, 100)).toEqual([piezo(100)])
    expect(cache.snapshot(undefined, 111).waveform).toEqual([])
    expect(cache.range(141)).toEqual({ min: 0, max: 0 })
  })

  it('bounds retained waveform bytes even with repeated timestamps', () => {
    const cache = new RecentSensorFrames()
    for (let i = 0; i < 100; i++) cache.add({ ...piezo(100), extra: 'x'.repeat(9_000) }, 100)
    expect(cache.window(100, 100).length).toBeLessThan(10)
    expect(cache.window(100, 100).length).toBeGreaterThan(0)
  })
})

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

  it('keeps the newest sensor value and bounds both sensor count and total snapshot size', () => {
    const cache = new RecentSensorFrames()
    for (let i = 0; i < 35; i++) cache.add({ type: `sensor-${i}`, ts: 100, reading: i }, 100)
    expect(cache.snapshot(undefined, 100).latest).toHaveLength(32)
    expect(cache.snapshot(undefined, 100).latest[0].type).toBe('sensor-3')
    cache.add({ type: 'sensor-3', ts: 101, reading: 999 }, 101)
    expect(cache.snapshot(new Set(['sensor-3']), 101).latest).toEqual([{ type: 'sensor-3', ts: 101, reading: 999 }])
    for (let i = 0; i < 10; i++) cache.add({ type: `large-${i}`, ts: 101, data: 'x'.repeat(9_000) }, 101)
    const latest = cache.snapshot(undefined, 101).latest
    expect(latest.length).toBeLessThan(5)
    expect(latest.at(-1)?.type).toBe('large-9')
    expect(JSON.stringify(latest).length).toBeLessThan(256 * 1024)
  })

  it('accepts ordinary nested metadata but rejects malformed and excessively deep records', () => {
    const cache = new RecentSensorFrames()
    const valid = { type: 'bedTemp', ts: 100, metadata: { calibrated: true, missing: null, values: [1, 2] } }
    cache.add(valid, 100)
    cache.add({ ts: 100 }, 100)
    cache.add({ type: 'bad', ts: '100' }, 100)
    let nested: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 15; i++) nested = { nested }
    cache.add({ type: 'too-deep', ts: 100, nested }, 100)
    expect(cache.snapshot(undefined, 100).latest).toEqual([valid])
  })

  it('bounds retained waveform bytes even with repeated timestamps', () => {
    const cache = new RecentSensorFrames()
    for (let i = 0; i < 100; i++) cache.add({ ...piezo(100), extra: 'x'.repeat(9_000) }, 100)
    expect(cache.window(100, 100).length).toBeLessThan(10)
    expect(cache.window(100, 100).length).toBeGreaterThan(0)
  })
})

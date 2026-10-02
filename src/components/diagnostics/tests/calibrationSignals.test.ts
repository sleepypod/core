import { describe, expect, it } from 'vitest'
import {
  capDeviation, capSumBand, channelsInBaseline, fmtCompact, fmtTimeLeft, parseCapParams, parsePiezoParams,
  peakToPeak, piezoEnvelope, tempZoneMeansC, validity,
} from '../calibrationSignals'

const capParams = {
  format: 'capSense2',
  threshold: 6,
  channels: { A: { mean: 10, std: 0.1 }, B: { mean: 20, std: 0.2 }, C: { mean: 30, std: 0.2 } },
  ref: { mean: 1.2, std: 0.001 },
}

function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error('expected a value')
  return v
}

describe('parsePiezoParams', () => {
  it('reads the noise range and presence threshold', () => {
    expect(parsePiezoParams({ baseline_mean_range: 1200, presence_threshold: 50000, noise_floor_rms: 1300 }))
      .toEqual({ noiseRange: 1200, threshold: 50000 })
  })
  it('returns null when a field is missing', () => {
    expect(parsePiezoParams({ presence_threshold: 50000 })).toBeNull()
    expect(parsePiezoParams(null)).toBeNull()
  })
})

describe('piezoEnvelope', () => {
  it('centres each frame on its mean and buckets min/max', () => {
    const env = piezoEnvelope([{ t: 2000, samples: [100, 104, 96, 100] }], 2)
    expect(env).toHaveLength(2)
    expect(env[0]).toMatchObject({ lo: 0, hi: 4 })
    expect(env[1]).toMatchObject({ lo: -4, hi: 0 })
    expect(env[0].t).toBeLessThan(env[1].t)
    expect(env[1].t).toBeLessThanOrEqual(2000)
  })
  it('skips empty frames', () => {
    expect(piezoEnvelope([{ t: 1, samples: [] }])).toEqual([])
  })
})

describe('peakToPeak', () => {
  it('is max minus min, or null when empty', () => {
    expect(peakToPeak([3, -2, 7])).toBe(9)
    expect(peakToPeak([])).toBeNull()
  })
})

describe('capSense2 baseline', () => {
  it('parses capSense2 params and rejects legacy capSense', () => {
    const cal = parseCapParams(capParams)
    expect(cal?.means).toEqual({ A: 10, B: 20, C: 30 })
    expect(cal?.refMean).toBe(1.2)
    expect(parseCapParams({ ...capParams, format: 'capSense' })).toBeNull()
    expect(parseCapParams({ ...capParams, channels: { A: { mean: 1, std: 1 } } })).toBeNull()
  })

  it('falls back to the nominal reference when ref is missing', () => {
    const noRef = { ...capParams, ref: undefined }
    expect(parseCapParams(noRef)?.refMean).toBe(1.16)
  })

  it('computes reference-compensated deviations like the sleep detector', () => {
    const cal = must(parseCapParams(capParams))
    // ref pair averages 1.3 → refDelta 0.1 subtracted from every channel
    const dev = must(capDeviation([10.1, 10.1, 20.1, 20.1, 32.1, 32.1, 1.3, 1.3], cal))
    expect(dev.A).toBeCloseTo(0)
    expect(dev.B).toBeCloseTo(0)
    expect(dev.C).toBeCloseTo(2)
    expect(dev.sum).toBeCloseTo(2)
    expect(channelsInBaseline(dev, cal)).toBe(2)
  })

  it('skips the reference on 6-value frames and rejects sentinels', () => {
    const cal = must(parseCapParams(capParams))
    expect(capDeviation([11, 11, 20, 20, 30, 30], cal)?.sum).toBeCloseTo(1)
    expect(capDeviation([-1, 11, 20, 20, 30, 30], cal)).toBeNull()
    expect(capDeviation([11, 11, 20], cal)).toBeNull()
  })

  it('sizes the summed band at 3σ of independent channels', () => {
    expect(capSumBand(must(parseCapParams(capParams)))).toBeCloseTo(3 * Math.sqrt(0.01 + 0.04 + 0.04))
  })
})

describe('tempZoneMeansC', () => {
  it('adds each zone offset to the ambient mean and converts centidegrees', () => {
    const p = { ambient_mean: 2200, offsets: { left_outer_temp: 100, left_center_temp: 250, left_inner_temp: -50 } }
    expect(tempZoneMeansC(p, 'left')).toEqual({ outer: 23, center: 24.5, inner: 21.5 })
    expect(tempZoneMeansC(p, 'right')).toBeNull()
  })
  it('treats small values as already °C', () => {
    expect(tempZoneMeansC({ ambient_mean: 22, offsets: { right_center_temp: 1.5 } }, 'right')).toEqual({ center: 23.5 })
  })
})

describe('validity', () => {
  const created = new Date('2026-09-28T00:00:00Z')
  const expires = new Date('2026-09-30T00:00:00Z')
  it('reports the share of the window left', () => {
    const v = must(validity(created, expires, new Date('2026-09-29T00:00:00Z').getTime()))
    expect(v.remaining).toBeCloseTo(0.5)
    expect(fmtTimeLeft(v.msLeft)).toBe('24h left')
  })
  it('clamps after expiry', () => {
    const v = must(validity(created, expires, new Date('2026-10-01T00:00:00Z').getTime()))
    expect(v.remaining).toBe(0)
    expect(fmtTimeLeft(v.msLeft)).toBe('expired')
  })
  it('is null without both dates', () => {
    expect(validity(created, null, 0)).toBeNull()
  })
})

describe('formatting', () => {
  it('formats minutes under an hour and compact magnitudes', () => {
    expect(fmtTimeLeft(30 * 60_000)).toBe('30m left')
    expect(fmtCompact(48_200_000)).toBe('48.2M')
  })
})

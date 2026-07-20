import { describe, expect, it } from 'vitest'
import { rebaseSetPoints } from './rebase'

describe('rebaseSetPoints', () => {
  it('returns input unchanged when window is identical', () => {
    const points = [
      { localId: -1, time: '00:00', temperature: 81 },
      { localId: -2, time: '04:00', temperature: 80 },
      { localId: -3, time: '23:45', temperature: 80 },
    ]
    const result = rebaseSetPoints(points, '00:00', '23:45', '00:00', '23:45')
    expect(result).toBe(points)
  })

  it('returns empty array unchanged', () => {
    const points: Array<{ time: string }> = []
    expect(rebaseSetPoints(points, '22:00', '07:00', '23:00', '06:00')).toBe(points)
  })

  it('rebases when only one endpoint differs', () => {
    const point = [{ time: '02:00', temperature: 70 }]

    const changedWake = rebaseSetPoints(point, '22:00', '06:00', '22:00', '08:00')
    expect(changedWake).not.toBe(point)
    expect(changedWake[0].time).toBe('03:00')

    const changedBedtime = rebaseSetPoints(point, '22:00', '06:00', '23:00', '06:00')
    expect(changedBedtime).not.toBe(point)
    expect(changedBedtime[0].time).toBe('02:30')
  })

  it('scales points proportionally when window shrinks', () => {
    // Old window: 00:00 - 23:45 (1425min). New: 00:00 - 11:45 (705min).
    // Compression factor: 705/1425 ≈ 0.495
    const result = rebaseSetPoints(
      [
        { time: '00:00', temperature: 81 }, // offset 0    -> 0
        { time: '11:52', temperature: 80 }, // offset 712  -> ~352 ≈ 05:52
        { time: '23:45', temperature: 80 }, // offset 1425 -> 705 = 11:45
      ],
      '00:00',
      '23:45',
      '00:00',
      '11:45',
    )
    expect(result[0].time).toBe('00:00')
    expect(result[1].time).toBe('05:52')
    expect(result[2].time).toBe('11:45')
  })

  it('preserves auxiliary fields (temperature, localId)', () => {
    const result = rebaseSetPoints(
      [{ localId: -7, time: '07:00', temperature: 78 }],
      '00:00',
      '23:45',
      '00:00',
      '11:45',
    )
    expect(result[0]).toMatchObject({ localId: -7, temperature: 78 })
  })

  it('handles overnight windows (bedtime > wake)', () => {
    // Old: 22:00 -> 06:00 (8h = 480min). New: 23:00 -> 07:00 (8h = 480min).
    // Same span, pure shift +1h.
    const result = rebaseSetPoints(
      [
        { time: '22:00', temperature: 78 },
        { time: '02:00', temperature: 68 },
        { time: '06:00', temperature: 76 },
      ],
      '22:00',
      '06:00',
      '23:00',
      '07:00',
    )
    expect(result[0].time).toBe('23:00')
    expect(result[1].time).toBe('03:00')
    expect(result[2].time).toBe('07:00')
  })

  it('scales overnight curve to a shorter overnight window', () => {
    // Old: 22:00 -> 06:00 (480min). New: 23:00 -> 05:00 (360min). Ratio 0.75.
    const result = rebaseSetPoints(
      [
        { time: '22:00', temperature: 78 }, // offset 0   -> 23:00
        { time: '02:00', temperature: 68 }, // offset 240 -> 23:00 + 180 = 02:00
        { time: '06:00', temperature: 76 }, // offset 480 -> 23:00 + 360 = 05:00
      ],
      '22:00',
      '06:00',
      '23:00',
      '05:00',
    )
    expect(result[0].time).toBe('23:00')
    expect(result[1].time).toBe('02:00')
    expect(result[2].time).toBe('05:00')
  })

  it('clamps points outside the old window to the wake endpoint', () => {
    // Old: 22:00 -> 06:00. Point at 08:00 is past wake; gets clamped to 06:00,
    // then rescaled to the new wake endpoint.
    const result = rebaseSetPoints(
      [
        { time: '22:00', temperature: 78 },
        { time: '08:00', temperature: 80 },
      ],
      '22:00',
      '06:00',
      '23:00',
      '07:00',
    )
    expect(result[0].time).toBe('23:00')
    expect(result[1].time).toBe('07:00')
  })

  it('shifts uniformly when the old window is degenerate (zero span)', () => {
    // bedtime == wake means we can't proportionally rescale — just translate.
    const result = rebaseSetPoints(
      [
        { time: '07:00', temperature: 78 },
        { time: '08:00', temperature: 80 },
      ],
      '07:00',
      '07:00',
      '08:00',
      '09:00',
    )
    expect(result[0].time).toBe('08:00')
    expect(result[1].time).toBe('09:00')
  })

  it('collapses to bedtime when the new window is degenerate', () => {
    const result = rebaseSetPoints(
      [
        { time: '22:00', temperature: 78 },
        { time: '02:00', temperature: 68 },
        { time: '06:00', temperature: 76 },
      ],
      '22:00',
      '06:00',
      '08:00',
      '08:00',
    )
    expect(result.every(p => p.time === '08:00')).toBe(true)
  })

  it('wraps the new bedtime + offset around midnight correctly', () => {
    // New bedtime 23:30, span 60min. Midpoint offset wraps to 00:00.
    const result = rebaseSetPoints(
      [
        { time: '00:00', temperature: 80 },
        { time: '00:30', temperature: 80 },
        { time: '01:00', temperature: 80 },
      ],
      '00:00',
      '01:00',
      '23:30',
      '00:30',
    )
    expect(result[0].time).toBe('23:30')
    expect(result[1].time).toBe('00:00')
    expect(result[2].time).toBe('00:30')
  })
})

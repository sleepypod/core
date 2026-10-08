import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HEAT, heatKey, paintHeat, resetKnit, sideRows, xToColumn, zToRow } from '../heatTexture'
import type { HeatInput } from '../heatTexture'

const input = (over: Partial<Record<'left' | 'right', Partial<HeatInput['left']>>> = {}): HeatInput => ({
  left: { shownF: 72, zonesF: [71.6, 72.5, 73.4], zoneVisibility: 0, highlight: 0, ...over.left },
  right: { shownF: 86, zonesF: [85, 86, 87], zoneVisibility: 0, highlight: 0, ...over.right },
})

/** A 2D context recorder: enough of the API for the painter, with every call logged. */
function fakeContext() {
  const calls: { name: string, args: unknown[] }[] = []
  const stops: { gradient: string, stops: [number, string][] }[] = []
  let gradients = 0
  const gradient = (kind: string) => {
    const name = `${kind}${gradients++}`
    const record = { gradient: name, stops: [] as [number, string][] }
    stops.push(record)
    return { addColorStop: (offset: number, color: string) => record.stops.push([offset, color]), name }
  }
  const context = {
    globalCompositeOperation: 'source-over',
    fillStyle: '' as unknown,
    fillRect: (...args: unknown[]) => calls.push({ name: 'fillRect', args }),
    createLinearGradient: (...args: unknown[]) => {
      calls.push({ name: 'createLinearGradient', args })
      return gradient('linear')
    },
    createRadialGradient: (...args: unknown[]) => {
      calls.push({ name: 'createRadialGradient', args })
      return gradient('radial')
    },
    createPattern: () => ({ pattern: true }),
    save: () => calls.push({ name: 'save', args: [] }),
    restore: () => calls.push({ name: 'restore', args: [] }),
    translate: (...args: unknown[]) => calls.push({ name: 'translate', args }),
    scale: (...args: unknown[]) => calls.push({ name: 'scale', args }),
  }
  return { context: context as unknown as CanvasRenderingContext2D, calls, stops }
}

beforeEach(() => {
  resetKnit()
  // jsdom has no canvas: give the knit tile a 2D context that returns the recorder's pattern.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    fillStyle: '',
    fillRect: () => {},
  }) as unknown as CanvasRenderingContext2D)
})

describe('canvas mapping', () => {
  it('puts the left sleeper (+z) in rows 0–140 and the right sleeper in rows 140–280', () => {
    expect(sideRows('left')).toEqual({ edge: 0, seam: 140 })
    expect(sideRows('right')).toEqual({ edge: 280, seam: 140 })
    expect(zToRow(0)).toBe(140)
    expect(xToColumn(0)).toBe(164)
    expect(xToColumn(-HEAT.bedLength / 2)).toBe(0)
  })
})

describe('heat key', () => {
  it('changes with the shown colour, visible zones and highlight, and ignores zone readings while they are hidden', () => {
    const base = heatKey(input())
    expect(heatKey(input())).toBe(base)
    expect(heatKey(input({ left: { shownF: 75 } }))).not.toBe(base)
    expect(heatKey(input({ left: { zonesF: [60, 60, 60] } }))).toBe(base)
    expect(heatKey(input({ left: { zoneVisibility: 1 } }))).not.toBe(base)
    expect(heatKey(input({ left: { zoneVisibility: 1, zonesF: [60, 60, 60] } }))).not.toBe(heatKey(input({ left: { zoneVisibility: 1 } })))
    expect(heatKey(input({ right: { highlight: 0.08 } }))).not.toBe(base)
    expect(heatKey(input({ left: { shownF: 72.1 } }))).toBe(base)
  })
})

describe('painting', () => {
  it('lays the cover, one wash per half fading at the seam, then the knit; no zones while hidden', () => {
    const { context, calls, stops } = fakeContext()
    paintHeat(context, input())
    const rects = calls.filter(c => c.name === 'fillRect').map(c => c.args)
    expect(rects[0]).toEqual([0, 0, HEAT.width, HEAT.height])
    expect(rects[1]).toEqual([0, 0, HEAT.width, 140])
    expect(rects[2]).toEqual([0, 140, HEAT.width, 140])
    expect(rects[rects.length - 1]).toEqual([0, 0, HEAT.width, HEAT.height])
    expect(calls.some(c => c.name === 'createRadialGradient')).toBe(false)
    const washes = stops.filter(s => s.gradient.startsWith('linear'))
    expect(washes).toHaveLength(2)
    expect(washes[0].stops.map(([offset]) => offset)).toEqual([0, 0.94, 1])
    expect(washes[0].stops[0][1]).toBe('rgba(69,94,130,0.85)')
    expect(washes[0].stops[2][1]).toBe('rgba(69,94,130,0.15)')
  })
  it('draws three squashed zone ellipses per visible half, OUTER at the edge and INNER at the seam', () => {
    const { context, calls, stops } = fakeContext()
    paintHeat(context, input({ left: { zoneVisibility: 1 }, right: { zoneVisibility: 0.5 } }))
    const centres = calls.filter(c => c.name === 'translate').map(c => c.args as [number, number])
    expect(centres).toHaveLength(6)
    const leftRows = centres.slice(0, 3).map(([, y]) => Math.round(y))
    expect(leftRows).toEqual([zToRow(0.875 + 0.52), zToRow(0.875), zToRow(0.875 - 0.52)].map(Math.round))
    expect(leftRows[0]).toBeLessThan(leftRows[2])
    const rightRows = centres.slice(3).map(([, y]) => Math.round(y))
    expect(rightRows[0]).toBeGreaterThan(rightRows[2])
    expect(calls.filter(c => c.name === 'scale').every(c => (c.args as number[])[1] === HEAT.zoneSquash)).toBe(true)
    const radial = stops.filter(s => s.gradient.startsWith('radial'))
    expect(radial[0].stops[0][1]).toMatch(/,0\.95\)$/)
    expect(radial[0].stops[1]).toEqual([0.55, expect.stringMatching(/,0\.55\)$/)])
    expect(radial[3].stops[0][1]).toMatch(/,0\.475\)$/)
  })
  it('lays a white highlight over a hovered or selected half', () => {
    const { context, calls } = fakeContext()
    const fills: unknown[] = []
    const original = context.fillRect
    context.fillRect = (...args: unknown[]) => {
      fills.push(context.fillStyle)
      return (original as (...a: unknown[]) => void)(...args)
    }
    paintHeat(context, input({ right: { highlight: 0.14 } }))
    expect(fills).toContain('rgba(255,255,255,0.14)')
    const rightRect = calls.filter(c => c.name === 'fillRect')[3]
    expect(rightRect.args).toEqual([0, 140, HEAT.width, 140])
  })
})

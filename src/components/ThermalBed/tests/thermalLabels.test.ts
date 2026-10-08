import { describe, expect, it } from 'vitest'
import { CALLOUT, layoutCallouts } from '../thermalLabels'
import type { CalloutAnchor, CalloutPlacement } from '../thermalLabels'

const label = { width: 64, height: 30 }
interface Box { left: number, right: number, top: number, bottom: number }
const box = (anchor: CalloutAnchor, p: CalloutPlacement): Box => {
  const left = p.align === 'left' ? p.x : p.x - anchor.width
  const top = p.below ? p.y : p.y - anchor.height
  return { left, right: left + anchor.width, top, bottom: top + anchor.height }
}
/** Segment–box intersection by sampling, independent of the implementation. A leader may graze a box's edge (text keeps its own padding from the leader), so the box is shrunk by a pixel. */
const through = (anchor: CalloutAnchor, p: CalloutPlacement, b: Box) => {
  for (let t = 0; t <= 1; t += 0.02) {
    const x = anchor.x + (p.x - anchor.x) * t
    const y = anchor.y + (p.y - anchor.y) * t
    if (x > b.left + 1 && x < b.right - 1 && y > b.top + 1 && y < b.bottom - 1) return true
  }
  return false
}
const expectNoCollisions = (anchors: CalloutAnchor[], placed: CalloutPlacement[], leaders = true) => {
  placed.forEach((p, i) => {
    const a = box(anchors[i], p)
    placed.forEach((q, j) => {
      if (i === j) return
      const b = box(anchors[j], q)
      const textOverlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      expect(textOverlap, `labels ${i} and ${j} overlap`).toBe(false)
      if (!leaders) return
      expect(through(anchors[j], q, a), `leader ${j} cuts through label ${i}`).toBe(false)
      const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px))
      const ai = anchors[i]
      const aj = anchors[j]
      const crossing = orient(ai.x, ai.y, p.x, p.y, aj.x, aj.y) * orient(ai.x, ai.y, p.x, p.y, q.x, q.y) < 0
        && orient(aj.x, aj.y, q.x, q.y, ai.x, ai.y) * orient(aj.x, aj.y, q.x, q.y, p.x, p.y) < 0
      expect(crossing, `leaders ${i} and ${j} cross`).toBe(false)
    })
  })
}
const expectInside = (anchors: CalloutAnchor[], placed: CalloutPlacement[], width: number, height: number) => {
  placed.forEach((p, i) => {
    const b = box(anchors[i], p)
    expect(b.left, `label ${i} left`).toBeGreaterThanOrEqual(CALLOUT.margin)
    expect(b.top, `label ${i} top`).toBeGreaterThanOrEqual(CALLOUT.margin)
    expect(b.right, `label ${i} right`).toBeLessThanOrEqual(width - CALLOUT.margin)
    expect(b.bottom, `label ${i} bottom`).toBeLessThanOrEqual(height - CALLOUT.margin)
  })
}
/** The leader really ends where the text attaches. */
const expectLeadersAttached = (anchors: CalloutAnchor[], placed: CalloutPlacement[]) => {
  placed.forEach((p, i) => {
    const a = anchors[i]
    expect(a.x + Math.sin(p.angle) * p.length).toBeCloseTo(p.x, 6)
    expect(a.y - Math.cos(p.angle) * p.length).toBeCloseTo(p.y, 6)
  })
}

describe('anchored thermal callouts', () => {
  it('stacks leaders into tiers when every anchor projects onto one point', () => {
    const anchors = Array.from({ length: 6 }, () => ({ x: 160, y: 320, ...label }))
    const placed = layoutCallouts(anchors, 320, 360)
    // Shared leaders cannot avoid each other, but the text never overlaps.
    expectNoCollisions(anchors, placed, false)
    expectInside(anchors, placed, 320, 360)
    expectLeadersAttached(anchors, placed)
  })

  it('keeps labels at one height when they fit side by side', () => {
    const anchors = [{ x: 40, y: 250, ...label }, { x: 200, y: 250, ...label }]
    const placed = layoutCallouts(anchors, 320, 300)
    expect(placed.map(p => p.length)).toEqual([CALLOUT.base, CALLOUT.base])
    expect(placed.map(p => p.angle)).toEqual([0, 0])
    expect(placed.map(p => p.below)).toEqual([false, false])
  })

  it('never lets a leader cut through a neighbour\'s text for the six staggered bed anchors', () => {
    // Screen positions of the six anchors at the default thermal camera (CSS px, 958 × 360 host).
    const anchors: CalloutAnchor[] = [
      { x: 372, y: 228, ...label }, { x: 428, y: 170, ...label }, { x: 470, y: 128, ...label },
      { x: 505, y: 112, ...label }, { x: 560, y: 150, ...label }, { x: 640, y: 196, ...label },
    ]
    const placed = layoutCallouts(anchors, 958, 360)
    expectNoCollisions(anchors, placed)
    expectInside(anchors, placed, 958, 360)
  })

  it('hangs labels below or slides them sideways when a crowd meets the top edge', () => {
    // The bed rotated end-on: four anchors in one column with no headroom (owner's screenshot).
    const anchors: CalloutAnchor[] = [
      { x: 404, y: 440, width: 84, height: 48 }, { x: 418, y: 270, width: 84, height: 48 },
      { x: 476, y: 318, width: 84, height: 48 }, { x: 474, y: 520, width: 84, height: 48 },
      { x: 342, y: 370, width: 84, height: 48 }, { x: 550, y: 290, width: 84, height: 48 },
    ]
    const placed = layoutCallouts(anchors, 824, 660)
    expectNoCollisions(anchors, placed)
    expectInside(anchors, placed, 824, 660)
    expectLeadersAttached(anchors, placed)
    expect(placed.some(p => p.below || p.angle !== 0)).toBe(true)
  })

  it('finds a clean layout for many random anchor sets', () => {
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let round = 0; round < 60; round++) {
      const width = 320 + Math.floor(random() * 640)
      const height = 300 + Math.floor(random() * 100)
      // Narrow hosts get the scene's compact labels (no zone name), as in thermalScene.ts.
      const compact = width < 520
      const anchors = Array.from({ length: 6 }, () => ({
        x: 60 + random() * (width - 120),
        y: 80 + random() * (height - 140),
        width: compact ? 40 + random() * 16 : 64 + random() * 30,
        height: compact ? 18 + random() * 6 : 30 + random() * 20,
      }))
      const placed = layoutCallouts(anchors, width, height)
      expectNoCollisions(anchors, placed)
      expectInside(anchors, placed, width, height)
      expectLeadersAttached(anchors, placed)
    }
  })

  it('flips text to the left of the leader near the right edge and keeps labels inside near the top', () => {
    const placed = layoutCallouts([{ x: 300, y: 60, ...label }, { x: -20, y: 250, ...label }], 320, 300)
    expect(placed[0].align).toBe('right')
    expect(placed[0].below).toBe(true)
    expect(placed[1].x).toBeGreaterThanOrEqual(CALLOUT.margin)
    expect(placed[1].align).toBe('left')
    expectInside([{ x: 300, y: 60, ...label }, { x: -20, y: 250, ...label }], placed, 320, 300)
  })
})

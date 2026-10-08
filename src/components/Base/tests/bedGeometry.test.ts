import { describe, expect, it } from 'vitest'
import { DECK_THICKNESS, liftArms, normal, offset, panels, pillow, profile, retainer, slab } from '../bedGeometry'

const close = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 6)

describe('bed geometry', () => {
  it('lays a flat base along the pivot line from x 40 to 560', () => {
    expect(profile({ head: 0, feet: 0 })).toEqual([
      { x: 40, y: 196 }, { x: 240, y: 196 }, { x: 330, y: 196 }, { x: 420, y: 196 }, { x: 560, y: 196 },
    ])
  })

  it('raises the head and thigh, and hangs the foot panel at a quarter of the feet angle', () => {
    const [headEnd, hinge, seatEnd, knee, footEnd] = profile({ head: 30, feet: 20 })
    close(Math.hypot(hinge.x - headEnd.x, hinge.y - headEnd.y), 200)
    close(Math.atan2(hinge.y - headEnd.y, hinge.x - headEnd.x) * 180 / Math.PI, 30)
    expect(seatEnd).toEqual({ x: 330, y: 196 })
    close(Math.atan2(seatEnd.y - knee.y, knee.x - seatEnd.x) * 180 / Math.PI, 20)
    close(Math.atan2(footEnd.y - knee.y, footEnd.x - knee.x) * 180 / Math.PI, 5)
    close(Math.hypot(footEnd.x - knee.x, footEnd.y - knee.y), 140)
  })

  it('offsets upward with mitred joints that keep the panel thickness', () => {
    const points = profile({ head: 40, feet: 15 })
    const top = offset(points, DECK_THICKNESS)
    // Every top point sits DECK_THICKNESS above both adjacent segments.
    for (let i = 0; i < points.length - 1; i++) {
      const n = normal(points[i], points[i + 1])
      for (const j of [i, i + 1]) close((top[j].x - points[j].x) * n.x + (top[j].y - points[j].y) * n.y, DECK_THICKNESS)
    }
    expect(normal({ x: 0, y: 0 }, { x: 1, y: 0 })).toEqual({ x: 0, y: -1 })
  })

  it('clamps the mitre on sharp folds', () => {
    const sharp = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 1 }]
    const [, joint] = offset(sharp, 10)
    expect(Math.hypot(joint.x - 100, joint.y)).toBeLessThanOrEqual(10 / 0.3 + 1e-9)
  })

  it('closes a slab outline and insets each panel quad at the seams', () => {
    const points = profile({ head: 0, feet: 0 })
    const outline = slab(points, 10)
    expect(outline).toHaveLength(10)
    expect(outline[5]).toEqual({ x: 560, y: 186 })
    const quads = panels(points)
    expect(quads).toHaveLength(4)
    expect(quads[0][0]).toEqual({ x: 41.2, y: 196 })
    expect(quads[0][1]).toEqual({ x: 238.8, y: 196 })
    expect(quads[0][2]).toEqual({ x: 238.8, y: 178 })
  })

  it('keeps the lift arms attached as the panels rise', () => {
    const length = ([a, b]: [{ x: number, y: number }, { x: number, y: number }]) => Math.hypot(b.x - a.x, b.y - a.y)
    const flat = liftArms(profile({ head: 0, feet: 0 }))
    const raised = liftArms(profile({ head: 45, feet: 30 }))
    expect(flat[0][0]).toEqual({ x: 300, y: 207 })
    expect(flat[1][0]).toEqual({ x: 395, y: 203 })
    expect(flat[0][1]).toEqual({ x: 156, y: 196 })
    expect(flat[1][1]).toEqual({ x: 402, y: 196 })
    // The head arm swings up with the panel; the knee arm extends.
    expect(raised[0][1].y).toBeLessThan(flat[0][1].y - 50)
    expect(length(raised[1])).toBeGreaterThan(length(flat[1]) + 30)
  })

  it('places the pillow on the raised mattress and the retainer post at the foot', () => {
    const rest = pillow(profile({ head: 0, feet: 0 }))
    expect(rest.center.x).toBeCloseTo(86, 6)
    expect(rest.center.y).toBeCloseTo(196 - 19 - 65, 6)
    expect(rest.angle).toBeCloseTo(0, 6)
    expect(pillow(profile({ head: 30, feet: 0 })).angle).toBeCloseTo(30, 6)
    const [from, to] = retainer(profile({ head: 0, feet: 0 }))
    expect(from).toEqual({ x: 560, y: 178 })
    expect(to).toEqual({ x: 560, y: 164 })
  })
})

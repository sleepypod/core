// Side-profile model of the split adjustable base, shared by the 2D and 3D bed
// views. Units match the SVG: the panel underside pivots on y=196, y grows down.

export interface Point { x: number, y: number }
export interface Pose { head: number, feet: number }

export const PIVOT_Y = 196
export const HEAD_HINGE_X = 240
export const SEAT_LENGTH = 90
export const HEAD_LENGTH = 200
export const THIGH_LENGTH = 90
export const FOOT_LENGTH = 140
/** The foot panel hangs from the knee, nearly level, like the real base. */
export const FOOT_DROP = 0.25
export const DECK_THICKNESS = 18
export const MATTRESS_THICKNESS = 56
const SEAM_INSET = 1.2
const MIN_MITER_DOT = 0.3

const rad = Math.PI / 180
const add = (a: Point, b: Point, scale = 1): Point => ({ x: a.x + b.x * scale, y: a.y + b.y * scale })
export const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
export const direction = (a: Point, b: Point): Point => {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
}
/** Upward normal of a segment drawn head → foot (y down). */
export const normal = (a: Point, b: Point): Point => {
  const d = direction(a, b)
  return { x: d.y, y: -d.x }
}

/** Pivot points [headEnd, headHinge, seatEnd, knee, footEnd]. */
export function profile({ head, feet }: Pose): Point[] {
  const hinge = { x: HEAD_HINGE_X, y: PIVOT_Y }
  const seatEnd = { x: HEAD_HINGE_X + SEAT_LENGTH, y: PIVOT_Y }
  const headEnd = { x: hinge.x - HEAD_LENGTH * Math.cos(head * rad), y: hinge.y - HEAD_LENGTH * Math.sin(head * rad) }
  const knee = { x: seatEnd.x + THIGH_LENGTH * Math.cos(feet * rad), y: seatEnd.y - THIGH_LENGTH * Math.sin(feet * rad) }
  const drop = feet * FOOT_DROP * rad
  const footEnd = { x: knee.x + FOOT_LENGTH * Math.cos(drop), y: knee.y + FOOT_LENGTH * Math.sin(drop) }
  return [headEnd, hinge, seatEnd, knee, footEnd]
}

/** Offset a polyline along its upward normal, mitered at the joints. */
export function offset(points: Point[], thickness: number): Point[] {
  return points.map((point, i) => {
    if (i === 0) return add(point, normal(point, points[1]), thickness)
    if (i === points.length - 1) return add(point, normal(points[i - 1], point), thickness)
    const before = normal(points[i - 1], point)
    const after = normal(point, points[i + 1])
    const sum = { x: before.x + after.x, y: before.y + after.y }
    const length = Math.hypot(sum.x, sum.y) || 1
    const miter = { x: sum.x / length, y: sum.y / length }
    const dot = Math.max(MIN_MITER_DOT, miter.x * before.x + miter.y * before.y)
    return add(point, miter, thickness / dot)
  })
}

/** Closed outline of a slab of the given thickness sitting on the polyline. */
export const slab = (points: Point[], thickness: number) => [...points, ...offset(points, thickness).reverse()]

/** One quad per rigid panel, inset along its own direction so the seams show. */
export function panels(points: Point[], thickness = DECK_THICKNESS): Point[][] {
  const top = offset(points, thickness)
  return points.slice(0, -1).map((start, i) => {
    const d = direction(start, points[i + 1])
    return [add(start, d, SEAM_INSET), add(points[i + 1], d, -SEAM_INSET), add(top[i + 1], d, -SEAM_INSET), add(top[i], d, SEAM_INSET)]
  })
}

/** Lift arms [from, to]: frame → head panel, frame → knee. Both extend as the panels rise. */
export function liftArms(points: Point[]): [Point, Point][] {
  return [
    [{ x: 300, y: 207 }, lerp(points[1], points[0], 0.42)],
    [{ x: 395, y: 203 }, lerp(points[2], points[3], 0.8)],
  ]
}

export const mattressBase = (points: Point[]) => offset(points, DECK_THICKNESS + 1)

/** Pillow centre and rotation (degrees, SVG orientation) for mattress mode. */
export function pillow(points: Point[]) {
  const base = mattressBase(points)
  const d = direction(base[0], base[1])
  const n = normal(base[0], base[1])
  return { center: add(add(base[0], d, 46), n, MATTRESS_THICKNESS + 9), angle: Math.atan2(d.y, d.x) / rad, width: 60, height: 16 }
}

/** Retainer post along the foot-panel normal at its end. */
export function retainer(points: Point[], length = 14): [Point, Point] {
  const top = offset(points, DECK_THICKNESS)
  const end = top[top.length - 1]
  return [end, add(end, normal(points[3], points[4]), length)]
}

export const path = (points: Point[], closed = true) => `M${points.map(p => `${round(p.x)} ${round(p.y)}`).join(' L')}${closed ? ' Z' : ''}`
const round = (value: number) => Math.round(value * 100) / 100

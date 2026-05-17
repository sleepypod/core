import { minutesToTimeStr, timeStringToMinutes } from './generate'

export interface RebasePoint {
  time: string
}

function span(fromMin: number, toMin: number): number {
  const raw = toMin - fromMin
  return raw >= 0 ? raw : raw + 24 * 60
}

/**
 * Rescale a set of points to fit a new sleep window while preserving each
 * point's fractional position within the window.
 *
 * - Overnight wrap is handled (bedtime > wake means the window crosses midnight).
 * - Degenerate cases (oldSpan or newSpan === 0) shift uniformly instead of
 *   scaling — avoids a divide-by-zero and a collapse to a single time.
 * - Points outside the old window are clamped to the window's endpoints before
 *   rescaling so they stay attached to the curve.
 */
export function rebaseSetPoints<P extends RebasePoint>(
  points: P[],
  oldBedtime: string,
  oldWake: string,
  newBedtime: string,
  newWake: string,
): P[] {
  if (points.length === 0) return points
  if (oldBedtime === newBedtime && oldWake === newWake) return points

  const ob = timeStringToMinutes(oldBedtime)
  const ow = timeStringToMinutes(oldWake)
  const nb = timeStringToMinutes(newBedtime)
  const nw = timeStringToMinutes(newWake)

  const oldSpan = span(ob, ow)
  const newSpan = span(nb, nw)

  // Degenerate old window: nothing to scale against — shift uniformly so the
  // curve follows the bedtime change instead of collapsing.
  if (oldSpan === 0) {
    const delta = nb - ob
    return points.map(p => ({ ...p, time: minutesToTimeStr(timeStringToMinutes(p.time) + delta) }))
  }

  return points.map((p) => {
    const t = timeStringToMinutes(p.time)
    const rawOffset = span(ob, t)
    const offset = Math.min(rawOffset, oldSpan)
    const newOffset = newSpan === 0 ? 0 : Math.round((offset / oldSpan) * newSpan)
    return { ...p, time: minutesToTimeStr(nb + newOffset) }
  })
}

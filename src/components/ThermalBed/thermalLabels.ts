export interface CalloutAnchor { x: number, y: number, width: number, height: number }
export interface CalloutPlacement {
  /** Where the leader meets the text: a bottom corner of a label above its anchor, a top corner of one below. */
  x: number
  y: number
  /** Which side of that point the text sits on. */
  align: 'left' | 'right'
  /** The label hangs under its anchor instead of rising above it. */
  below: boolean
  /** Leader from the anchor to (x, y): its length in px and its clockwise angle from straight up, in radians. */
  length: number
  angle: number
}

export const CALLOUT = { base: 44, step: 30, minLength: 14, gap: 8, margin: 4, slide: 26, maxSlide: 4, tiers: 8 } as const
/** Tiers are spaced so a label on one never touches the label on the next. */
const tierStep = (anchor: CalloutAnchor) => Math.max(CALLOUT.step, anchor.height + CALLOUT.gap)

interface Box { left: number, right: number, top: number, bottom: number }
interface Segment { x1: number, y1: number, x2: number, y2: number }
interface Placed { anchor: CalloutAnchor, box: Box, leader: Segment, placement: CalloutPlacement }

const overlaps = (a: Box, b: Box, g: number) => a.left < b.right + g && a.right > b.left - g && a.top < b.bottom + g && a.bottom > b.top - g

/** Does the segment pass through the box grown by g on every side? Liang–Barsky clipping. */
function crosses(s: Segment, box: Box, g: number) {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [[-dx, s.x1 - (box.left - g)], [dx, box.right + g - s.x1], [-dy, s.y1 - (box.top - g)], [dy, box.bottom + g - s.y1]]) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return true
}

/** Do two leaders cross? Proper crossings only; shared or touching endpoints do not count. */
function intersects(a: Segment, b: Segment) {
  const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px)
  const o1 = orient(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1)
  const o2 = orient(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2)
  const o3 = orient(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1)
  const o4 = orient(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2)
  return o1 * o2 < 0 && o3 * o4 < 0
}

/**
 * Anchored callouts: each label rides a thin leader from its point on the model, so it
 * stays attached while the bed rotates. Text sits to the right of the leader's end, or to
 * the left near the right edge. A label whose text would collide with another label or
 * cross a leader tries, in order: the next tier up, the same tier hanging below the
 * anchor, then sliding sideways on an angled leader; labels never leave the frame. Once
 * every label is placed, any that a later leader cut through is placed again against the
 * rest. Only when nothing fits does a label fall back to a short leader straight up.
 */
export function layoutCallouts(anchors: CalloutAnchor[], width: number, height: number): CalloutPlacement[] {
  const g = CALLOUT.gap
  const m = CALLOUT.margin
  const order = anchors.map((anchor, i) => i).sort((a, b) => anchors[a].x - anchors[b].x)
  const make = (anchor: CalloutAnchor, x: number, y: number, align: 'left' | 'right', below: boolean): Placed => {
    const left = align === 'left' ? x : x - anchor.width
    const top = below ? y : y - anchor.height
    const dx = x - anchor.x
    const dy = y - anchor.y
    return {
      anchor,
      box: { left, right: left + anchor.width, top, bottom: top + anchor.height },
      leader: { x1: anchor.x, y1: anchor.y, x2: x, y2: y },
      placement: { x, y, align, below, length: Math.hypot(dx, dy), angle: Math.atan2(dx, -dy) },
    }
  }
  const inside = (box: Box) => box.left >= m && box.right <= width - m && box.top >= m && box.bottom <= height - m
  // Text keeps the gap from other text and from other labels' dots; a leader may run along
  // a label's edge (the text has its own padding from the leader), it just may not cut
  // through the words. Only faults the candidate can fix by moving count against it: a
  // neighbour's text over this anchor is that neighbour's fault, and it moves instead.
  const covers = (box: Box, a: CalloutAnchor) => a.x > box.left - g && a.x < box.right + g && a.y > box.top - g && a.y < box.bottom + g
  const collides = (c: Placed, others: Placed[]) => others.some(o =>
    overlaps(c.box, o.box, g) || covers(c.box, o.anchor) || crosses(o.leader, c.box, -1) || crosses(c.leader, o.box, -1) || intersects(c.leader, o.leader))
  const preferredAlign = (anchor: CalloutAnchor): 'left' | 'right' => anchor.x + anchor.width + m > width ? 'right' : 'left'
  const violations = (c: Placed, others: Placed[]) => others.filter(o => collides(c, [o])).length
  /** The first clean candidate in preference order; failing that, the one that offends the fewest neighbours. */
  const search = (anchor: CalloutAnchor, others: Placed[]) => {
    const preferred = preferredAlign(anchor)
    const aligns: ('left' | 'right')[] = [preferred, preferred === 'left' ? 'right' : 'left']
    let best: Placed | null = null
    let fewest = Infinity
    for (let tier = 0; tier < CALLOUT.tiers; tier++) {
      const length = CALLOUT.base + tier * tierStep(anchor)
      for (let slide = 0; slide <= CALLOUT.maxSlide; slide++) {
        for (const sign of slide === 0 ? [1] : [1, -1]) {
          const x = anchor.x + sign * slide * CALLOUT.slide
          for (const below of [false, true]) {
            const y = below ? anchor.y + length : anchor.y - length
            for (const align of aligns) {
              const candidate = make(anchor, x, y, align, below)
              if (!inside(candidate.box)) continue
              const count = violations(candidate, others)
              if (count === 0) return candidate
              if (count < fewest) {
                fewest = count
                best = candidate
              }
            }
          }
        }
      }
    }
    return best
  }
  // Even the frame has no room: a short leader straight up, kept inside.
  const fallback = (anchor: CalloutAnchor) => {
    const x = Math.max(m, Math.min(width - m, anchor.x))
    const y = Math.max(anchor.height + m, anchor.y - Math.max(CALLOUT.minLength, Math.min(CALLOUT.base, anchor.y - anchor.height - m)))
    return make(anchor, x, y, preferredAlign(anchor), false)
  }
  const placed: Placed[] = []
  const result: Placed[] = new Array(anchors.length)
  for (const i of order) {
    const item = search(anchors[i], placed) ?? fallback(anchors[i])
    placed.push(item)
    result[i] = item
  }
  // A later label may collide with an earlier one: place the earlier one again against everyone else.
  for (let pass = 0; pass < 3; pass++) {
    let moved = false
    for (const item of placed) {
      const rest = placed.filter(o => o !== item)
      const before = violations(item, rest)
      if (before === 0) continue
      const better = search(item.anchor, rest)
      if (better && violations(better, rest) < before) {
        Object.assign(item, better)
        moved = true
      }
    }
    if (!moved) break
  }
  return result.map(item => item.placement)
}

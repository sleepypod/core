'use client'

import type { BaseSide } from '@/src/hardware/base/types'
import { DECK_THICKNESS, MATTRESS_THICKNESS, liftArms, mattressBase, offset, panels, path, pillow, profile, retainer, slab } from './bedGeometry'
import type { Point } from './bedGeometry'
import type { BedRendererProps } from './BedView'

const FRONT = { arm: '#4a4a51', panel: '#8b8b92', mattressPanel: '#3a3a40', post: '#b0b0b6', mattress: '#d8d8dc', pillow: '#f2f2f4', ghost: '#8b8b92' }
const BACK = { arm: '#2a2a2f', panel: '#45454c', mattressPanel: '#232327', post: '#5d5d63', mattress: '#4a4a51', pillow: '#5e5e66', ghost: '#5d5d63' }
// The mattress stroke adds 4 units on each side; shrink the slab to keep MT.
const MATTRESS_STROKE = 8

function Half({ side, pose, target, moving, colors, mattress }: { side: BaseSide, pose: BedRendererProps['left'], target: BedRendererProps['left'], moving: boolean, colors: typeof FRONT, mattress: boolean }) {
  const points = profile(pose)
  const top = offset(points, DECK_THICKNESS)
  const mattressSlab = (base: Point[]) => slab(offset(mattressBase(base), MATTRESS_STROKE / 2), MATTRESS_THICKNESS - MATTRESS_STROKE)
  const [postFrom, postTo] = retainer(points)
  const rest = pillow(points)
  const targetPoints = profile(target)
  return (
    <g data-testid={`bed-${side}`}>
      {liftArms(points).map(([from, to], i) => <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={colors.arm} strokeWidth={6} strokeLinecap="round" />)}
      {panels(points).map((quad, i) => <path key={i} d={path(quad)} fill={mattress ? colors.mattressPanel : colors.panel} />)}
      {[1, 2, 3].map(i => <line key={i} x1={points[i].x} y1={points[i].y} x2={top[i].x} y2={top[i].y} style={{ stroke: 'var(--surface-card, #0f0f11)' }} strokeWidth={2} />)}
      {mattress && (
        <>
          <path d={path(mattressSlab(points))} fill={colors.mattress} stroke={colors.mattress} strokeWidth={MATTRESS_STROKE} strokeLinejoin="round" />
          <rect x={rest.center.x - rest.width / 2} y={rest.center.y - rest.height / 2} width={rest.width} height={rest.height} rx={rest.height / 2} fill={colors.pillow} transform={`rotate(${rest.angle} ${rest.center.x} ${rest.center.y})`} />
        </>
      )}
      <line x1={postFrom.x} y1={postFrom.y} x2={postTo.x} y2={postTo.y} stroke={colors.post} strokeWidth={3} strokeLinecap="round" />
      {moving && <path data-testid={`ghost-${side}`} d={path(mattress ? slab(mattressBase(targetPoints), MATTRESS_THICKNESS) : slab(targetPoints, DECK_THICKNESS))} fill="none" stroke={colors.ghost} strokeWidth={1.5} strokeDasharray="6 5" />}
    </g>
  )
}

/** Side view of the base. Works fully offline; the 3D view's fallback. */
export function BedView2D({ left, right, leftTarget, rightTarget, moving, single, split, focus, bedModel }: BedRendererProps) {
  const mattress = bedModel === 'mattress'
  const front: BaseSide = single ?? (split && focus === 'right' ? 'right' : 'left')
  const back: BaseSide = front === 'left' ? 'right' : 'left'
  const pose = { left, right }
  const target = { left: leftTarget, right: rightTarget }
  return (
    <svg viewBox="0 -70 600 330" aria-hidden="true" data-testid="bed-view-2d" className="block size-full">
      {!single && split && (
        <g transform="translate(24 -16)">
          <Half side={back} pose={pose[back]} target={target[back]} moving={!!moving[back]} colors={BACK} mattress={mattress} />
        </g>
      )}
      <rect x={60} y={203} width={490} height={7} fill="#26262a" />
      {[82, 292, 512].map(x => <rect key={x} x={x} y={210} width={16} height={40} fill="#18181b" stroke="#3a3a40" strokeWidth={1} />)}
      <Half side={front} pose={pose[front]} target={target[front]} moving={!!moving[front]} colors={FRONT} mattress={mattress} />
    </svg>
  )
}

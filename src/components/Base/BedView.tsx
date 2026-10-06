'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useState } from 'react'
import { BASE_SIDES } from '@/src/hardware/base/types'
import type { BaseScope, BaseSide } from '@/src/hardware/base/types'
import type { Pose } from './bedGeometry'
import type { BedModel } from './bedModel3D'
import { BedView2D } from './BedView2D'
import { labelStyle, usePreference } from './controls'
import type { Names } from './controls'
import { hasWebGL, loadThree } from './loadThree'
import type { Three } from './loadThree'
import { useBedPose } from './useBedPose'

const BedView3D = dynamic(() => import('./BedView3D'), { ssr: false })

export const BED_MODELS = ['base', 'mattress'] as const
export const useBedModel = () => usePreference<BedModel>('bedModel', 'base', BED_MODELS)
export const useSimpleBedView = () => usePreference('simpleBedView', 'false', ['true', 'false'])

export interface BedViewProps {
  /** Measured angles; null while the position is unavailable. */
  left: Pose | null
  right: Pose | null
  leftTarget: Pose
  rightTarget: Pose
  moving: Partial<Record<BaseSide, boolean | null>>
  names: Names
  /** Draw one half only (a per-side card). */
  single?: BaseSide
  /** The halves move independently; a whole-bed 2D view draws only the front half. */
  split?: boolean
  /** The selected side faces the camera (3D) or is drawn in front (2D). */
  focus?: BaseScope
}

/** What both renderers draw: the interpolated pose, never the exact readout. */
export interface BedRendererProps {
  left: Pose
  right: Pose
  leftTarget: Pose
  rightTarget: Pose
  moving: Record<BaseSide, boolean>
  single?: BaseSide
  split: boolean
  focus?: BaseScope
  bedModel: BedModel
}

const angles = (pose: Pose | null) => pose ? `${pose.head}° / ${pose.feet}°` : '— / —'

export function BedView({ left, right, leftTarget, rightTarget, moving, names, single, split = true, focus }: BedViewProps) {
  const [bedModel] = useBedModel()
  const [simple] = useSimpleBedView()
  const [three, setThree] = useState<Three | null>(null)
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)
  const measured = left && right ? { left, right } : null
  const shown = useBedPose(measured)
  const want3D = simple !== 'true' && !failed

  useEffect(() => {
    // Without WebGL, 2D simply stays up; there is nothing to load.
    if (!want3D || three || !hasWebGL()) return
    let alive = true
    void loadThree().then((loaded) => {
      if (!alive) return
      if (loaded) setThree(() => loaded)
      else setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [want3D, three])

  const onReady = useCallback(() => setReady(true), [])
  const onFail = useCallback(() => {
    setFailed(true)
    setReady(false)
  }, [])
  const renderer: BedRendererProps = {
    left: shown.left,
    right: shown.right,
    leftTarget,
    rightTarget,
    moving: { left: !!moving.left, right: !!moving.right },
    single,
    split,
    focus,
    bedModel,
  }
  const use3D = want3D && three !== null
  const anyMoving = (single ? [single] : BASE_SIDES).some(side => moving[side])
  const sides = single ? [single] : split ? BASE_SIDES : null
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="relative aspect-[600/330] w-full overflow-hidden rounded-xl border border-line bg-surface">
        {/* 2D stays up until the first 3D frame lands, so the box is never empty. */}
        {!(use3D && ready) && <BedView2D {...renderer} />}
        {use3D && <BedView3D three={three} onReady={onReady} onFail={onFail} {...renderer} />}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-mono text-xs">
        <span data-testid="bed-readout" className="uppercase">
          {sides
            ? sides.map(side => `${names[side]} ${angles(side === 'left' ? left : right)}`).join(' · ')
            : `${names.left} · ${names.right} ${angles(left)}`}
        </span>
        <span className={`${labelStyle} ${anyMoving ? 'text-[#50c878]' : 'text-fg-2'}`}>{anyMoving ? 'MOVING' : 'IDLE'}</span>
      </div>
    </div>
  )
}

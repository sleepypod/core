'use client'

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { hasWebGL, loadThree } from '@/src/components/Base/loadThree'
import { mountStageScene } from './stageScene'
import type { StageLabelRefs, StageScene, StageSceneCallbacks, StageSceneState } from './stageScene'

export type StageMode = 'loading' | '3d' | '2d'

export interface StageCanvasHandle {
  orbitBy: (radians: number) => void
}

interface Props {
  state: StageSceneState
  callbacks: Omit<StageSceneCallbacks, 'onFail'>
  labels: () => StageLabelRefs
  onMode: (mode: StageMode) => void
}

/**
 * Hosts the three.js stage. Decorative: every readout is DOM text elsewhere. Falls to
 * the flat cards (via onMode('2d')) when WebGL is missing, three.js fails to load or
 * the context is lost.
 */
const StageCanvas = forwardRef<StageCanvasHandle, Props>(function StageCanvas({ state, callbacks, labels, onMode }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<StageScene | null>(null)
  const latest = useRef({ state, callbacks, labels, onMode })
  useLayoutEffect(() => {
    latest.current = { state, callbacks, labels, onMode }
    scene.current?.update(state)
  })
  useImperativeHandle(ref, () => ({ orbitBy: radians => scene.current?.orbitBy(radians) }), [])

  useEffect(() => {
    let alive = true
    const fail = () => {
      scene.current?.dispose()
      scene.current = null
      if (alive) latest.current.onMode('2d')
    }
    void (async () => {
      if (!hasWebGL()) {
        fail()
        return
      }
      const three = await loadThree()
      if (!alive) return
      if (!three || !host.current) {
        fail()
        return
      }
      try {
        const forward: StageSceneCallbacks = {
          onHover: side => latest.current.callbacks.onHover(side),
          onSelect: side => latest.current.callbacks.onSelect(side),
          onDrag: (side, f) => latest.current.callbacks.onDrag(side, f),
          onDragEnd: (side, f) => latest.current.callbacks.onDragEnd(side, f),
          onNudge: (side, delta) => latest.current.callbacks.onNudge(side, delta),
          onFail: fail,
        }
        scene.current = mountStageScene(three, host.current, forward, () => latest.current.labels())
        scene.current.update(latest.current.state)
        latest.current.onMode('3d')
      }
      catch {
        fail()
      }
    })()
    return () => {
      alive = false
      scene.current?.dispose()
      scene.current = null
    }
  }, [])

  return <div ref={host} aria-hidden="true" data-testid="stage-canvas" className="absolute inset-0 [&>canvas]:transition-opacity [&>canvas]:duration-700" />
})

export default StageCanvas

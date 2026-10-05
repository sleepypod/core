'use client'

import { useEffect, useRef, useState } from 'react'
import type { BasePosition, BaseSide } from '@/src/hardware/base/types'

type Positions = Record<BaseSide, Pick<BasePosition, 'head' | 'feet'>>

/** Animate only the drawing; command targets and measured readouts stay exact. */
export function useAnimatedPositions(positions: Positions, duration: number) {
  const [displayed, setDisplayed] = useState(positions)
  const current = useRef(positions)
  const { head: leftHead, feet: leftFeet } = positions.left
  const { head: rightHead, feet: rightFeet } = positions.right

  useEffect(() => {
    const target = { left: { head: leftHead, feet: leftFeet }, right: { head: rightHead, feet: rightFeet } }
    const from = current.current
    if (from.left.head === leftHead && from.left.feet === leftFeet && from.right.head === rightHead && from.right.feet === rightFeet) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const start = performance.now()
    let frame: number
    const tick = (now: number) => {
      const progress = reducedMotion.matches ? 1 : Math.min(1, (now - start) / duration)
      const lerp = (a: number, b: number) => a + (b - a) * progress
      const next = progress === 1
        ? target
        : {
            left: { head: lerp(from.left.head, leftHead), feet: lerp(from.left.feet, leftFeet) },
            right: { head: lerp(from.right.head, rightHead), feet: lerp(from.right.feet, rightFeet) },
          }
      current.current = next
      setDisplayed(next)
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [leftHead, leftFeet, rightHead, rightFeet, duration])

  return displayed
}

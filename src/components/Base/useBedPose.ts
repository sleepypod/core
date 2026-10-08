'use client'

import { useEffect, useRef, useState } from 'react'
import type { BaseSide } from '@/src/hardware/base/types'
import type { Pose } from './bedGeometry'

export type Poses = Record<BaseSide, Pose>

/** Degrees per second; 1–2 Hz polling still reads as continuous motion. */
export const POSE_RATE = 18
/** Larger gaps (first load, reconnect) snap instead of sweeping. */
export const POSE_SNAP = 20
const FLAT: Poses = { left: { head: 0, feet: 0 }, right: { head: 0, feet: 0 } }
const KEYS = [['left', 'head'], ['left', 'feet'], ['right', 'head'], ['right', 'feet']] as const

const step = (from: number, to: number, max: number) => Math.abs(to - from) > POSE_SNAP || Math.abs(to - from) <= max ? to : from + Math.sign(to - from) * max

/** Animate only the drawing toward the latest measurement; readouts stay exact. */
export function useBedPose(poses: Poses | null) {
  const [shown, setShown] = useState<Poses>(poses ?? FLAT)
  const current = useRef(shown)
  const hadPose = useRef(poses !== null)
  const values = KEYS.map(([side, field]) => poses?.[side][field] ?? 0)
  const key = poses ? values.join(',') : 'none'

  useEffect(() => {
    const target = poses ?? FLAT
    const snap = !hadPose.current || !poses || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    hadPose.current = poses !== null
    if (snap) {
      current.current = target
      setShown(target)
      return
    }
    if (KEYS.every(([side, field]) => current.current[side][field] === target[side][field])) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const max = POSE_RATE * Math.max(0, now - last) / 1000
      last = now
      const from = current.current
      const next: Poses = {
        left: { head: step(from.left.head, target.left.head, max), feet: step(from.left.feet, target.left.feet, max) },
        right: { head: step(from.right.head, target.right.head, max), feet: step(from.right.feet, target.right.feet, max) },
      }
      current.current = next
      setShown(next)
      const done = KEYS.every(([side, field]) => next[side][field] === target[side][field])
      if (!done) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // `key` captures every angle, so a new object with the same pose is a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return shown
}

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBedPose } from '../useBedPose'
import type { Poses } from '../useBedPose'

const pose = (lh: number, lf: number, rh = lh, rf = lf): Poses => ({ left: { head: lh, feet: lf }, right: { head: rh, feet: rf } })
let now = 0
let nextId = 0
let reduced = false
const frames = new Map<number, FrameRequestCallback>()
const advance = (time: number) => act(() => {
  now = time
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach(callback => callback(now))
})

beforeEach(() => {
  now = 0
  nextId = 0
  reduced = false
  frames.clear()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() {
      return reduced
    },
  })))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useBedPose', () => {
  it('starts at the first measurement without animating from flat', () => {
    const { result } = renderHook(() => useBedPose(pose(30, 10)))
    expect(result.current).toEqual(pose(30, 10))
    expect(frames.size).toBe(0)
  })

  it('moves toward the latest measurement at 18°/s and stops when it arrives', () => {
    const { result, rerender } = renderHook(({ value }) => useBedPose(value), { initialProps: { value: pose(0, 0) } })
    rerender({ value: pose(9, 3) })
    advance(250)
    expect(result.current.left.head).toBeCloseTo(4.5)
    expect(result.current.left.feet).toBe(3)
    advance(500)
    expect(result.current).toEqual(pose(9, 3))
    expect(frames.size).toBe(0)
  })

  it('snaps gaps over 20° instead of sweeping', () => {
    const { result, rerender } = renderHook(({ value }) => useBedPose(value), { initialProps: { value: pose(0, 0) } })
    rerender({ value: pose(40, 2) })
    advance(100)
    expect(result.current.left.head).toBe(40)
    expect(result.current.left.feet).toBeCloseTo(1.8)
  })

  it('ignores a new object carrying the same pose', () => {
    const { rerender } = renderHook(({ value }) => useBedPose(value), { initialProps: { value: pose(5, 5) } })
    rerender({ value: pose(5, 5) })
    expect(frames.size).toBe(0)
  })

  it('snaps under reduced motion', () => {
    reduced = true
    const { result, rerender } = renderHook(({ value }) => useBedPose(value), { initialProps: { value: pose(0, 0) } })
    rerender({ value: pose(10, 5) })
    expect(result.current).toEqual(pose(10, 5))
    expect(frames.size).toBe(0)
  })

  it('shows flat while unavailable and snaps to the first pose after reconnecting', () => {
    const { result, rerender, unmount } = renderHook(({ value }) => useBedPose(value), { initialProps: { value: pose(10, 5) as Poses | null } })
    rerender({ value: null })
    expect(result.current).toEqual(pose(0, 0))
    rerender({ value: pose(12, 6) })
    expect(result.current).toEqual(pose(12, 6))
    rerender({ value: pose(14, 6) })
    expect(frames.size).toBe(1)
    unmount()
    expect(frames.size).toBe(0)
  })
})

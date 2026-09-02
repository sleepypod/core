/**
 * Tests for useGuardRejectionNotice — latching the transient guardRejection
 * overlay that broadcastMutationStatus attaches to a single deviceStatus
 * frame when a guard-blocked HomeKit write is refused. The overlay vanishes
 * on the next poll frame, so the hook must hold the message across frames,
 * auto-dismiss it, and never resurrect an already-seen rejection.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGuardRejectionNotice } from '../useGuardRejectionNotice'
import type { GuardRejectionOverlay } from '../useGuardRejectionNotice'

interface Props {
  left: GuardRejectionOverlay | undefined
  right: GuardRejectionOverlay | undefined
}

const renderNotice = (initial: Props = { left: undefined, right: undefined }) =>
  renderHook(
    ({ left, right }: Props) => useGuardRejectionNotice(left, right),
    { initialProps: initial },
  )

const rejection = (ts: number): GuardRejectionOverlay => ({ ts, source: 'homekit' })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useGuardRejectionNotice', () => {
  it('is null with no rejection overlays', () => {
    const { result, rerender } = renderNotice()
    expect(result.current).toBeNull()
    rerender({ left: undefined, right: undefined })
    expect(result.current).toBeNull()
  })

  it('surfaces a per-side message when a rejection overlay arrives', () => {
    const { result, rerender } = renderNotice()
    rerender({ left: rejection(1_000), right: undefined })
    expect(result.current).toBe('Left side change from HomeKit blocked — pump stall protection active')

    rerender({ left: undefined, right: rejection(2_000) })
    expect(result.current).toBe('Right side change from HomeKit blocked — pump stall protection active')
  })

  it('keeps the message after the overlay drops off the next frame', () => {
    const { result, rerender } = renderNotice()
    rerender({ left: rejection(1_000), right: undefined })
    rerender({ left: undefined, right: undefined })
    expect(result.current).not.toBeNull()
  })

  it('auto-dismisses after the timeout', () => {
    const { result, rerender } = renderNotice()
    rerender({ left: rejection(1_000), right: undefined })
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(result.current).toBeNull()
  })

  it('does not resurrect an already-seen rejection when the same frame re-renders', () => {
    const { result, rerender } = renderNotice()
    rerender({ left: rejection(1_000), right: undefined })
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(result.current).toBeNull()

    // Same ts delivered again (stale frame re-render) — must stay dismissed.
    rerender({ left: rejection(1_000), right: undefined })
    expect(result.current).toBeNull()
  })

  it('a newer rejection restarts the dismiss timer', () => {
    const { result, rerender } = renderNotice()
    rerender({ left: rejection(1_000), right: undefined })
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    rerender({ left: rejection(9_000), right: undefined })
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    // 8s after the first rejection but only 4s after the second — still shown.
    expect(result.current).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(result.current).toBeNull()
  })
})

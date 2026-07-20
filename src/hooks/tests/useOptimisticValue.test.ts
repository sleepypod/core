/**
 * Tests for useOptimisticValue — optimistic UI state reconciled against a
 * server-observed value. Regressions covered: the temp dial snapping back to
 * the stale server value between mutation settle and the next WS frame
 * (review 3.8), and mutations giving no visible feedback because the
 * WS-preferred status ignores HTTP refetches (review 3.9).
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOptimisticValue } from '../useOptimisticValue'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useOptimisticValue', () => {
  it('returns the server value when no local override is set', () => {
    const { result } = renderHook(() => useOptimisticValue(70))
    expect(result.current.value).toBe(70)
    expect(result.current.isOptimistic).toBe(false)
  })

  it('commit shows the value immediately and keeps it while the server lags', () => {
    const { result, rerender } = renderHook(
      ({ server }) => useOptimisticValue(server),
      { initialProps: { server: 70 } },
    )

    act(() => result.current.commit(75))
    expect(result.current.value).toBe(75)
    expect(result.current.isOptimistic).toBe(true)

    // Server still reports the old value (WS frame not yet arrived) — the
    // committed value must not snap back.
    rerender({ server: 70 })
    expect(result.current.value).toBe(75)
  })

  it('drops the override once the server confirms the committed value', () => {
    const { result, rerender } = renderHook(
      ({ server }) => useOptimisticValue(server),
      { initialProps: { server: 70 } },
    )

    act(() => result.current.commit(75))
    rerender({ server: 75 })

    expect(result.current.value).toBe(75)
    expect(result.current.isOptimistic).toBe(false)

    // A later external change (e.g. scheduler) shows through immediately.
    rerender({ server: 68 })
    expect(result.current.value).toBe(68)
  })

  it('falls back to server truth when the commit times out unconfirmed', () => {
    const { result, rerender } = renderHook(
      ({ server }) => useOptimisticValue(server, 6_000),
      { initialProps: { server: 70 } },
    )

    act(() => result.current.commit(75))
    act(() => vi.advanceTimersByTime(6_001))
    rerender({ server: 70 })

    expect(result.current.value).toBe(70)
    expect(result.current.isOptimistic).toBe(false)
  })

  it('uses an updated timeout for commits made after rerender', () => {
    const { result, rerender } = renderHook(
      ({ timeoutMs }) => useOptimisticValue(70, timeoutMs),
      { initialProps: { timeoutMs: 6_000 } },
    )

    rerender({ timeoutMs: 1_000 })
    act(() => result.current.commit(75))
    act(() => vi.advanceTimersByTime(999))
    expect(result.current.isOptimistic).toBe(true)

    act(() => vi.advanceTimersByTime(1))
    expect(result.current.value).toBe(70)
    expect(result.current.isOptimistic).toBe(false)
  })

  it('preview shows the value with no expiry (in-progress drag)', () => {
    const { result } = renderHook(() => useOptimisticValue(70))

    act(() => result.current.preview(72))
    act(() => vi.advanceTimersByTime(60_000))

    expect(result.current.value).toBe(72)
    expect(result.current.isOptimistic).toBe(true)
  })

  it('does not clear a timer when no timer has been armed', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { result } = renderHook(() => useOptimisticValue(70))
    clearTimeoutSpy.mockClear()

    act(() => result.current.preview(72))

    expect(clearTimeoutSpy).not.toHaveBeenCalled()
  })

  it('clears an armed expiry timer on unmount', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { result, unmount } = renderHook(() => useOptimisticValue(70))
    act(() => result.current.commit(72))
    clearTimeoutSpy.mockClear()

    unmount()

    expect(clearTimeoutSpy).toHaveBeenCalledOnce()
  })

  it('discard reverts to server truth immediately (mutation error)', () => {
    const { result } = renderHook(() => useOptimisticValue(70))

    act(() => result.current.commit(75))
    act(() => result.current.discard())

    expect(result.current.value).toBe(70)
    expect(result.current.isOptimistic).toBe(false)
  })

  it('a new commit re-arms the expiry timer', () => {
    const { result } = renderHook(() => useOptimisticValue(false, 6_000))

    act(() => result.current.commit(true))
    act(() => vi.advanceTimersByTime(4_000))
    act(() => result.current.commit(true))
    act(() => vi.advanceTimersByTime(4_000))

    // 8s total, but only 4s since the second commit — still optimistic.
    expect(result.current.isOptimistic).toBe(true)
  })
})

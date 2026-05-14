/**
 * Tests for usePullToRefresh — touch handlers that translate finger
 * pulls into a refresh gesture. Only fires when scrolled to the top.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePullToRefresh } from '../usePullToRefresh'

function touchEvent(touches: Array<{ clientY: number }>): any {
  return { touches, changedTouches: touches }
}

beforeEach(() => {
  // Reset scroll position before each test.
  Object.defineProperty(document.documentElement, 'scrollTop', {
    configurable: true,
    get: () => 0,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('usePullToRefresh', () => {
  it('initializes idle', () => {
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    expect(result.current.isRefreshing).toBe(false)
    expect(result.current.pullDistance).toBe(0)
    expect(result.current.isPastThreshold).toBe(false)
  })

  it('tracks pull distance with resistance applied', () => {
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 100 }]))
    })
    // 100px pull * 0.4 resistance = 40px indicator travel
    expect(result.current.pullDistance).toBe(40)
    expect(result.current.isPastThreshold).toBe(true) // PULL_THRESHOLD * resistance = 32, 40 ≥ 32
  })

  it('caps pull distance at MAX_PULL', () => {
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 1000 }]))
    })
    expect(result.current.pullDistance).toBe(120)
  })

  it('ignores upward drags (deltaY < 0)', () => {
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 100 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 50 }]))
    })
    expect(result.current.pullDistance).toBe(0)
  })

  it('does nothing when disabled', () => {
    const onRefresh = vi.fn(async () => {})
    const { result } = renderHook(() => usePullToRefresh({ onRefresh, enabled: false }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 200 }]))
    })
    expect(result.current.pullDistance).toBe(0)
  })

  it('does not activate when scrolled away from the top', () => {
    Object.defineProperty(document.documentElement, 'scrollTop', {
      configurable: true,
      get: () => 50,
    })
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 200 }]))
    })
    expect(result.current.pullDistance).toBe(0)
  })

  it('ignores multi-touch gestures', () => {
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }, { clientY: 50 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 100 }]))
    })
    expect(result.current.pullDistance).toBe(0)
  })

  it('triggers onRefresh when threshold is crossed on touch end', async () => {
    let resolve!: () => void
    const onRefresh = vi.fn(() => new Promise<void>((r) => {
      resolve = r
    }))
    const { result } = renderHook(() => usePullToRefresh({ onRefresh }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 200 }]))
    })
    expect(result.current.isPastThreshold).toBe(true)
    let endPromise!: Promise<void>
    act(() => {
      endPromise = result.current.pullHandlers.onTouchEnd()
    })
    await waitFor(() => expect(result.current.isRefreshing).toBe(true))
    expect(onRefresh).toHaveBeenCalled()
    await act(async () => {
      resolve()
      await endPromise
    })
    expect(result.current.isRefreshing).toBe(false)
    expect(result.current.pullDistance).toBe(0)
  })

  it('clears state when touch end fires below threshold', async () => {
    const onRefresh = vi.fn(async () => {})
    const { result } = renderHook(() => usePullToRefresh({ onRefresh }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 50 }])) // 50*0.4 = 20 < 32
    })
    expect(result.current.isPastThreshold).toBe(false)
    await act(async () => {
      await result.current.pullHandlers.onTouchEnd()
    })
    expect(onRefresh).not.toHaveBeenCalled()
    expect(result.current.pullDistance).toBe(0)
  })

  it('clears pull state if the finger drags back up after a pull began', () => {
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 100 }]))
    })
    expect(result.current.pullDistance).toBeGreaterThan(0)
    act(() => {
      // Finger now goes back above the start point — deltaY < 0 path.
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: -10 }]))
    })
    expect(result.current.pullDistance).toBe(0)
    expect(result.current.isPastThreshold).toBe(false)
  })

  it('touchEnd is a no-op when no pull was registered', async () => {
    const onRefresh = vi.fn(async () => {})
    const { result } = renderHook(() => usePullToRefresh({ onRefresh }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
    })
    await act(async () => {
      await result.current.pullHandlers.onTouchEnd()
    })
    expect(onRefresh).not.toHaveBeenCalled()
    expect(result.current.isRefreshing).toBe(false)
  })

  it('still resets onRefresh even if it rejects', async () => {
    const onRefresh = vi.fn(() => Promise.reject(new Error('boom')))
    const { result } = renderHook(() => usePullToRefresh({ onRefresh }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 200 }]))
    })
    await act(async () => {
      await result.current.pullHandlers.onTouchEnd().catch(() => {})
    })
    expect(result.current.isRefreshing).toBe(false)
    expect(result.current.pullDistance).toBe(0)
  })
})

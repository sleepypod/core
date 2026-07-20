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

  it('touch end without a pull does not update state', async () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return usePullToRefresh({ onRefresh: vi.fn(async () => {}) })
    })
    const rendersBeforeEnd = renders

    await act(async () => result.current.pullHandlers.onTouchEnd())

    expect(renders).toBe(rendersBeforeEnd)
  })

  it('touch start without movement does not turn into a pull', async () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return usePullToRefresh({ onRefresh: vi.fn(async () => {}) })
    })
    act(() => result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 10 }])))
    const rendersBeforeEnd = renders

    await act(async () => result.current.pullHandlers.onTouchEnd())

    expect(renders).toBe(rendersBeforeEnd)
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

  it('does not update state for an upward drag before pulling begins', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return usePullToRefresh({ onRefresh: vi.fn(async () => {}) })
    })
    act(() => result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 100 }])))
    const rendersBeforeMove = renders
    act(() => result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 50 }])))
    expect(renders).toBe(rendersBeforeMove)
  })

  it('clears an active pull when the finger moves above its start', () => {
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 100 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 200 }]))
    })
    expect(result.current.pullDistance).toBe(40)

    act(() => result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 90 }])))

    expect(result.current.pullDistance).toBe(0)
    expect(result.current.isPastThreshold).toBe(false)
  })

  it('ends idempotently after an upward move cancels an active pull', async () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return usePullToRefresh({ onRefresh: vi.fn(async () => {}) })
    })
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 100 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 200 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 90 }]))
    })
    const rendersBeforeEnd = renders
    await act(async () => result.current.pullHandlers.onTouchEnd())
    expect(renders).toBe(rendersBeforeEnd)
  })

  it('treats zero movement as the beginning of a downward pull', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return usePullToRefresh({ onRefresh: vi.fn(async () => {}) })
    })
    act(() => result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 100 }])))
    const rendersBeforeMove = renders

    act(() => result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 100 }])))

    expect(renders).toBeGreaterThan(rendersBeforeMove)
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

  it('does not remember a touch that started while disabled', () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => usePullToRefresh({ onRefresh: vi.fn(async () => {}), enabled }),
      { initialProps: { enabled: false } },
    )
    act(() => result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }])))
    rerender({ enabled: true })
    act(() => result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 200 }])))
    expect(result.current.pullDistance).toBe(0)
  })

  it('uses the latest enabled value in the touch-start callback', () => {
    const onRefresh = vi.fn(async () => {})
    const { result, rerender } = renderHook(
      ({ enabled }) => usePullToRefresh({ onRefresh, enabled }),
      { initialProps: { enabled: false } },
    )
    rerender({ enabled: true })
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 100 }]))
    })
    expect(result.current.pullDistance).toBe(40)
  })

  it('uses the latest enabled value in the touch-move callback', () => {
    const onRefresh = vi.fn(async () => {})
    const { result, rerender } = renderHook(
      ({ enabled }) => usePullToRefresh({ onRefresh, enabled }),
      { initialProps: { enabled: true } },
    )
    act(() => result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }])))
    rerender({ enabled: false })
    act(() => result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 100 }])))
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

  it('does not retain a start recorded while scrolled away from the top', () => {
    let scrollTop = 6
    Object.defineProperty(document.documentElement, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
    })
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    act(() => result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }])))
    scrollTop = 0
    act(() => result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 200 }])))
    expect(result.current.pullDistance).toBe(0)
  })

  it('stops tracking if the page scrolls after touch start', () => {
    let scrollTop = 0
    Object.defineProperty(document.documentElement, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
    })
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    act(() => result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }])))
    scrollTop = 6
    act(() => result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 200 }])))
    expect(result.current.pullDistance).toBe(0)
  })

  it('allows a pull when scrollTop is exactly five pixels', () => {
    Object.defineProperty(document.documentElement, 'scrollTop', {
      configurable: true,
      get: () => 5,
    })
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 100 }]))
    })
    expect(result.current.pullDistance).toBe(40)
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

  it('treats a pull exactly at the threshold as refreshable', async () => {
    const onRefresh = vi.fn(async () => {})
    const { result } = renderHook(() => usePullToRefresh({ onRefresh }))
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 80 }]))
    })
    expect(result.current.pullDistance).toBe(32)
    expect(result.current.isPastThreshold).toBe(true)

    await act(async () => result.current.pullHandlers.onTouchEnd())
    expect(onRefresh).toHaveBeenCalledOnce()
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
    expect(result.current.isRefreshing).toBe(false)
    expect(result.current.isPastThreshold).toBe(false)
  })

  it('clears the remembered start when touch end fires before movement', async () => {
    const { result } = renderHook(() => usePullToRefresh({ onRefresh: vi.fn(async () => {}) }))
    act(() => result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 10 }])))
    await act(async () => result.current.pullHandlers.onTouchEnd())

    act(() => result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 100 }])))

    expect(result.current.pullDistance).toBe(0)
  })

  it('leaves touch end idempotent after finishing a pull', async () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return usePullToRefresh({ onRefresh: vi.fn(async () => {}) })
    })
    act(() => {
      result.current.pullHandlers.onTouchStart(touchEvent([{ clientY: 0 }]))
      result.current.pullHandlers.onTouchMove(touchEvent([{ clientY: 50 }]))
    })
    await act(async () => result.current.pullHandlers.onTouchEnd())
    const rendersAfterFirstEnd = renders

    await act(async () => result.current.pullHandlers.onTouchEnd())

    expect(renders).toBe(rendersAfterFirstEnd)
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

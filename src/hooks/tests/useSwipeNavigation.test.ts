/**
 * Tests for useSwipeNavigation — horizontal swipes between the 5 main
 * screens. Filters out vertical scroll, slow swipes, and gestures that
 * start inside horizontally-scrollable elements.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const navMock = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: '/en/' as string,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navMock.push }),
  usePathname: () => navMock.pathname,
}))

import { useSwipeNavigation } from '../useSwipeNavigation'

function touchEvent(touches: Array<{ clientX: number, clientY: number }>, target?: any): any {
  return {
    touches,
    changedTouches: touches,
    target: target ?? { closest: () => null },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  navMock.push.mockReset()
  navMock.pathname = '/en/'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSwipeNavigation', () => {
  it('navigates to the next screen on a leftward swipe', () => {
    const { result } = renderHook(() => useSwipeNavigation())
    act(() => {
      result.current.onTouchStart(touchEvent([{ clientX: 200, clientY: 100 }]))
      result.current.onTouchEnd(touchEvent([{ clientX: 50, clientY: 100 }]))
    })
    expect(navMock.push).toHaveBeenCalledWith('/en/schedule')
  })

  it('navigates to the previous screen on a rightward swipe', () => {
    navMock.pathname = '/en/schedule'
    const { result } = renderHook(() => useSwipeNavigation())
    act(() => {
      result.current.onTouchStart(touchEvent([{ clientX: 50, clientY: 100 }]))
      result.current.onTouchEnd(touchEvent([{ clientX: 200, clientY: 100 }]))
    })
    expect(navMock.push).toHaveBeenCalledWith('/en/')
  })

  it('does not navigate past the first screen', () => {
    navMock.pathname = '/en/'
    const { result } = renderHook(() => useSwipeNavigation())
    act(() => {
      result.current.onTouchStart(touchEvent([{ clientX: 50, clientY: 100 }]))
      result.current.onTouchEnd(touchEvent([{ clientX: 200, clientY: 100 }])) // swipe right at index 0
    })
    expect(navMock.push).not.toHaveBeenCalled()
  })

  it('does not navigate past the last screen', () => {
    navMock.pathname = '/en/settings'
    const { result } = renderHook(() => useSwipeNavigation())
    act(() => {
      result.current.onTouchStart(touchEvent([{ clientX: 200, clientY: 100 }]))
      result.current.onTouchEnd(touchEvent([{ clientX: 50, clientY: 100 }])) // swipe left at last
    })
    expect(navMock.push).not.toHaveBeenCalled()
  })

  it('rejects swipes that are too vertical', () => {
    const { result } = renderHook(() => useSwipeNavigation())
    act(() => {
      result.current.onTouchStart(touchEvent([{ clientX: 200, clientY: 50 }]))
      result.current.onTouchEnd(touchEvent([{ clientX: 50, clientY: 200 }])) // 150px vertical > 80
    })
    expect(navMock.push).not.toHaveBeenCalled()
  })

  it('rejects swipes shorter than the threshold', () => {
    const { result } = renderHook(() => useSwipeNavigation())
    act(() => {
      result.current.onTouchStart(touchEvent([{ clientX: 200, clientY: 100 }]))
      result.current.onTouchEnd(touchEvent([{ clientX: 170, clientY: 100 }])) // 30 < 60
    })
    expect(navMock.push).not.toHaveBeenCalled()
  })

  it('rejects swipes that take longer than 500ms', () => {
    const { result } = renderHook(() => useSwipeNavigation())
    act(() => {
      result.current.onTouchStart(touchEvent([{ clientX: 200, clientY: 100 }]))
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    act(() => {
      result.current.onTouchEnd(touchEvent([{ clientX: 50, clientY: 100 }]))
    })
    expect(navMock.push).not.toHaveBeenCalled()
  })

  it('ignores swipes inside horizontally-scrollable containers', () => {
    const { result } = renderHook(() => useSwipeNavigation())
    const target = { closest: vi.fn(() => ({})) }
    act(() => {
      result.current.onTouchStart(touchEvent([{ clientX: 200, clientY: 100 }], target))
      result.current.onTouchEnd(touchEvent([{ clientX: 50, clientY: 100 }], target))
    })
    expect(navMock.push).not.toHaveBeenCalled()
  })

  it('ignores multi-touch swipes', () => {
    const { result } = renderHook(() => useSwipeNavigation())
    act(() => {
      result.current.onTouchStart(touchEvent([
        { clientX: 200, clientY: 100 },
        { clientX: 250, clientY: 100 },
      ]))
      result.current.onTouchEnd(touchEvent([{ clientX: 50, clientY: 100 }]))
    })
    expect(navMock.push).not.toHaveBeenCalled()
  })

  it('locks navigation for 400ms after a successful swipe', () => {
    const { result } = renderHook(() => useSwipeNavigation())
    act(() => {
      result.current.onTouchStart(touchEvent([{ clientX: 200, clientY: 100 }]))
      result.current.onTouchEnd(touchEvent([{ clientX: 50, clientY: 100 }]))
    })
    expect(navMock.push).toHaveBeenCalledTimes(1)

    // Second swipe before the lock expires — should be ignored
    act(() => {
      result.current.onTouchStart(touchEvent([{ clientX: 200, clientY: 100 }]))
      result.current.onTouchEnd(touchEvent([{ clientX: 50, clientY: 100 }]))
    })
    expect(navMock.push).toHaveBeenCalledTimes(1)

    // After the lock expires, navigation works again
    act(() => {
      vi.advanceTimersByTime(500)
    })
    act(() => {
      result.current.onTouchStart(touchEvent([{ clientX: 200, clientY: 100 }]))
      result.current.onTouchEnd(touchEvent([{ clientX: 50, clientY: 100 }]))
    })
    expect(navMock.push).toHaveBeenCalledTimes(2)
  })

  it('does nothing on touch end with no recorded start', () => {
    const { result } = renderHook(() => useSwipeNavigation())
    act(() => {
      result.current.onTouchEnd(touchEvent([{ clientX: 50, clientY: 100 }]))
    })
    expect(navMock.push).not.toHaveBeenCalled()
  })
})

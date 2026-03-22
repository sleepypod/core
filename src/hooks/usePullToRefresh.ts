'use client'

import { useCallback, useRef, useState } from 'react'

/** Minimum pull distance in px to trigger refresh. */
const PULL_THRESHOLD = 80

/** Maximum indicator travel in px. */
const MAX_PULL = 120

interface PullToRefreshOptions {
  /** Async function to call on refresh trigger. */
  onRefresh: () => Promise<void>
  /** Whether pull-to-refresh is enabled. Default true. */
  enabled?: boolean
}

interface PullToRefreshState {
  /** Whether currently refreshing. */
  isRefreshing: boolean
  /** Current pull distance (0 when not pulling). */
  pullDistance: number
  /** Whether the threshold has been reached. */
  isPastThreshold: boolean
}

/**
 * Hook that implements pull-to-refresh for mobile touch screens.
 * Returns touch handlers and state for rendering the pull indicator.
 *
 * Only activates when the container is scrolled to the top (scrollTop === 0).
 */
export function usePullToRefresh({ onRefresh, enabled = true }: PullToRefreshOptions) {
  const [state, setState] = useState<PullToRefreshState>({
    isRefreshing: false,
    pullDistance: 0,
    isPastThreshold: false,
  })

  const startYRef = useRef<number | null>(null)
  const isPullingRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (!enabled || state.isRefreshing) return
    if (e.touches.length !== 1) return

    // Only activate when scrolled to the top
    const container = containerRef.current
    const scrollParent = (container?.closest('[data-scroll-container]') as HTMLElement | null) ?? document.documentElement
    if (scrollParent.scrollTop > 5) return

    startYRef.current = e.touches[0].clientY
    isPullingRef.current = false
  }, [enabled, state.isRefreshing])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!enabled || state.isRefreshing) return
    if (startYRef.current === null) return

    const deltaY = e.touches[0].clientY - startYRef.current

    // Only track downward pulls
    if (deltaY < 0) {
      if (isPullingRef.current) {
        isPullingRef.current = false
        setState(prev => ({ ...prev, pullDistance: 0, isPastThreshold: false }))
      }
      return
    }

    // Check scroll position — only activate at scroll top
    const container = containerRef.current
    const scrollParent = (container?.closest('[data-scroll-container]') as HTMLElement | null) ?? document.documentElement
    if (scrollParent.scrollTop > 5) return

    isPullingRef.current = true

    // Apply resistance — pull feels heavier as you go further
    const resistance = 0.4
    const pull = Math.min(MAX_PULL, deltaY * resistance)

    setState(prev => ({
      ...prev,
      pullDistance: pull,
      isPastThreshold: pull >= PULL_THRESHOLD * resistance,
    }))
  }, [enabled, state.isRefreshing])

  const onTouchEnd = useCallback(async () => {
    if (!isPullingRef.current) {
      startYRef.current = null
      return
    }

    isPullingRef.current = false
    startYRef.current = null

    if (state.isPastThreshold && !state.isRefreshing) {
      setState({ isRefreshing: true, pullDistance: 0, isPastThreshold: false })

      try {
        await onRefresh()
      } finally {
        setState({ isRefreshing: false, pullDistance: 0, isPastThreshold: false })
      }
    } else {
      setState({ isRefreshing: false, pullDistance: 0, isPastThreshold: false })
    }
  }, [state.isPastThreshold, state.isRefreshing, onRefresh])

  return {
    containerRef,
    pullHandlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
    },
    ...state,
  }
}

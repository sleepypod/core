'use client'

import { type ReactNode } from 'react'
import { usePullToRefresh } from '@/src/hooks/usePullToRefresh'
import { RefreshCw } from 'lucide-react'

interface PullToRefreshProps {
  /** Async function called when refresh is triggered. */
  onRefresh: () => Promise<void>
  /** Whether pull-to-refresh is enabled. Default true. */
  enabled?: boolean
  children: ReactNode
}

/**
 * Wrapper component that adds pull-to-refresh behavior.
 * Shows a spinner indicator while pulling and during refresh.
 */
export function PullToRefresh({ onRefresh, enabled = true, children }: PullToRefreshProps) {
  const { containerRef, pullHandlers, isRefreshing, pullDistance, isPastThreshold } = usePullToRefresh({
    onRefresh,
    enabled,
  })

  const showIndicator = pullDistance > 0 || isRefreshing
  const indicatorHeight = isRefreshing ? 40 : pullDistance

  return (
    <div
      ref={containerRef}
      {...pullHandlers}
      className="relative"
    >
      {/* Pull indicator */}
      {showIndicator && (
        <div
          className="flex items-center justify-center overflow-hidden transition-[height] duration-150 ease-out"
          style={{ height: indicatorHeight }}
        >
          <RefreshCw
            size={20}
            className={`text-zinc-400 transition-transform duration-200 ${
              isRefreshing ? 'animate-spin' : ''
            } ${isPastThreshold ? 'text-sky-400' : ''}`}
            style={{
              transform: isRefreshing
                ? undefined
                : `rotate(${(pullDistance / 80) * 360}deg)`,
              opacity: Math.min(1, pullDistance / 30),
            }}
          />
        </div>
      )}

      {children}
    </div>
  )
}

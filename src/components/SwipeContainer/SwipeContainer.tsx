'use client'

import { type ReactNode } from 'react'
import { useSwipeNavigation } from '@/src/hooks/useSwipeNavigation'

/**
 * Wrapper component that enables horizontal swipe navigation between screens.
 * Wraps the main content area in the layout.
 */
export function SwipeContainer({ children }: { children: ReactNode }) {
  const { onTouchStart, onTouchEnd } = useSwipeNavigation()

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="min-h-0 flex-1"
    >
      {children}
    </div>
  )
}

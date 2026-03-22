'use client'

import { useCallback } from 'react'
import { useSide as useSideContext, type Side } from '@/src/providers/SideProvider'

/**
 * Compatibility shim that delegates to SideProvider context.
 *
 * Returns a simple { side, setSide, toggleSide } interface for components
 * that only need left/right selection (no linked/both mode).
 *
 * All components share the same side state via SideProvider.
 */
export function useSide() {
  const { primarySide, selectSide } = useSideContext()

  const setSide = useCallback(
    (newSide: Side) => selectSide(newSide),
    [selectSide],
  )

  const toggleSide = useCallback(() => {
    selectSide(primarySide === 'left' ? 'right' : 'left')
  }, [selectSide, primarySide])

  return { side: primarySide, setSide, toggleSide } as const
}

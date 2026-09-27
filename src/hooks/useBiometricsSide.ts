'use client'

import { useCallback } from 'react'
import { useSide, type Side } from '@/src/providers/SideProvider'

/**
 * Side selection for biometrics views (sleep, vitals, movement).
 *
 * With exactly one side in away mode the biometrics modules merge both
 * sides' presence, movement and vitals into the single sleeper's side, so
 * these views show only that side — no left/right split or side toggle.
 * Otherwise they follow the shared SideProvider selection.
 */
export function useBiometricsSide(): {
  side: Side
  sides: Side[]
  showBothSides: boolean
  singleSleeperSide: Side | null
  /** Swap sides; undefined when the view has a single sleeper. */
  toggleSide: (() => void) | undefined
} {
  const { selectedSide, activeSides, primarySide, selectSide, singleSleeperSide } = useSide()
  const toggle = useCallback(() => {
    selectSide(primarySide === 'left' ? 'right' : 'left')
  }, [selectSide, primarySide])

  if (singleSleeperSide) {
    return {
      side: singleSleeperSide,
      sides: [singleSleeperSide],
      showBothSides: false,
      singleSleeperSide,
      toggleSide: undefined,
    }
  }
  return {
    side: primarySide,
    sides: activeSides,
    showBothSides: selectedSide === 'both',
    singleSleeperSide: null,
    toggleSide: toggle,
  }
}

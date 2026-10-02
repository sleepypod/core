import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBiometricsSide } from '../useBiometricsSide'

const state = vi.hoisted(() => ({
  selectedSide: 'both' as 'left' | 'right' | 'both',
  activeSides: ['left', 'right'] as Array<'left' | 'right'>,
  primarySide: 'left' as 'left' | 'right',
  singleSleeperSide: null as 'left' | 'right' | null,
  selectSide: vi.fn(),
}))
vi.mock('@/src/providers/SideProvider', () => ({ useSide: () => state }))

beforeEach(() => {
  state.selectedSide = 'both'
  state.activeSides = ['left', 'right']
  state.primarySide = 'left'
  state.singleSleeperSide = null
  state.selectSide.mockReset()
})

describe('useBiometricsSide', () => {
  it('follows the shared selection normally', () => {
    const { result } = renderHook(() => useBiometricsSide())
    expect(result.current).toMatchObject({ side: 'left', sides: ['left', 'right'], showBothSides: true })
    result.current.toggleSide?.()
    expect(state.selectSide).toHaveBeenCalledWith('right')
  })

  it('shows only the single sleeper, even while controls are on both', () => {
    state.singleSleeperSide = 'right'
    const { result } = renderHook(() => useBiometricsSide())
    expect(result.current).toMatchObject({
      side: 'right', sides: ['right'], showBothSides: false, singleSleeperSide: 'right',
    })
    expect(result.current.toggleSide).toBeUndefined()
  })
})

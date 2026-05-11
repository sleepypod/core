/**
 * Tests for the useSide compatibility shim — wraps SideProvider's context
 * down to a simple { side, setSide, toggleSide } interface for legacy
 * components that only need left/right selection.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sideMock = vi.hoisted(() => {
  const state: { primarySide: 'left' | 'right' } = { primarySide: 'left' }
  const selectSide = vi.fn((side: 'left' | 'right' | 'both') => {
    if (side === 'left' || side === 'right') state.primarySide = side
  })
  return { state, selectSide }
})

vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => ({
    primarySide: sideMock.state.primarySide,
    selectSide: sideMock.selectSide,
  }),
}))

import { useSide } from '../useSide'

afterEach(() => {
  sideMock.state.primarySide = 'left'
  sideMock.selectSide.mockClear()
})

describe('useSide', () => {
  it('returns the current primary side from context', () => {
    sideMock.state.primarySide = 'right'
    const { result } = renderHook(() => useSide())
    expect(result.current.side).toBe('right')
  })

  it('setSide delegates to selectSide', () => {
    const { result } = renderHook(() => useSide())
    act(() => result.current.setSide('right'))
    expect(sideMock.selectSide).toHaveBeenCalledWith('right')
  })

  it('toggleSide flips left → right', () => {
    sideMock.state.primarySide = 'left'
    const { result } = renderHook(() => useSide())
    act(() => result.current.toggleSide())
    expect(sideMock.selectSide).toHaveBeenLastCalledWith('right')
  })

  it('toggleSide flips right → left', () => {
    sideMock.state.primarySide = 'right'
    const { result } = renderHook(() => useSide())
    act(() => result.current.toggleSide())
    expect(sideMock.selectSide).toHaveBeenLastCalledWith('left')
  })
})

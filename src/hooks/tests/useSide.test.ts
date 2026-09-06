/**
 * Tests for the useSide compatibility shim — wraps SideProvider's context
 * down to a simple { side, setSide, toggleSide } interface for legacy
 * components that only need left/right selection.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sideMock = vi.hoisted(() => {
  const selectSide = vi.fn((side: 'left' | 'right' | 'both') => {
    if (side === 'left' || side === 'right') state.primarySide = side
  })
  const state: {
    primarySide: 'left' | 'right'
    selectSide: (side: 'left' | 'right' | 'both') => void
  } = { primarySide: 'left', selectSide }
  return { state, selectSide }
})

vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => ({
    primarySide: sideMock.state.primarySide,
    selectSide: sideMock.state.selectSide,
  }),
}))

import { useSide } from '../useSide'

afterEach(() => {
  sideMock.state.primarySide = 'left'
  sideMock.state.selectSide = sideMock.selectSide
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

  it('refreshes both callbacks when the context values change', () => {
    const replacementSelectSide = vi.fn()
    const { result, rerender } = renderHook(() => useSide())

    sideMock.state.primarySide = 'right'
    sideMock.state.selectSide = replacementSelectSide
    rerender()
    act(() => {
      result.current.setSide('right')
      result.current.toggleSide()
    })

    expect(replacementSelectSide).toHaveBeenNthCalledWith(1, 'right')
    expect(replacementSelectSide).toHaveBeenNthCalledWith(2, 'left')
    expect(sideMock.selectSide).not.toHaveBeenCalled()
  })
})

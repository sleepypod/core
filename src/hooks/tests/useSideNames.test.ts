/**
 * Tests for useSideNames — surfaces left/right display names from
 * settings.getAll, falling back to "Left"/"Right" when unset.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const trpcMock = vi.hoisted(() => {
  const state: { data: any } = { data: undefined }
  return {
    state,
    trpc: {
      settings: {
        getAll: {
          useQuery: vi.fn(() => ({ data: state.data })),
        },
      },
    },
  }
})

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))

import { useSideNames } from '../useSideNames'

afterEach(() => {
  trpcMock.state.data = undefined
})

describe('useSideNames', () => {
  it('keeps side-name settings fresh for thirty seconds', () => {
    renderHook(() => useSideNames())
    expect(trpcMock.trpc.settings.getAll.useQuery).toHaveBeenLastCalledWith(
      {},
      { staleTime: 30_000 },
    )
  })

  it('falls back to Left/Right when no settings data', () => {
    const { result } = renderHook(() => useSideNames())
    expect(result.current.leftName).toBe('Left')
    expect(result.current.rightName).toBe('Right')
    expect(result.current.sideName('left')).toBe('Left')
    expect(result.current.sideName('right')).toBe('Right')
  })

  it('returns custom names from settings', () => {
    trpcMock.state.data = { sides: { left: { name: 'Alice' }, right: { name: 'Bob' } } }
    const { result } = renderHook(() => useSideNames())
    expect(result.current.leftName).toBe('Alice')
    expect(result.current.rightName).toBe('Bob')
    expect(result.current.sideName('left')).toBe('Alice')
    expect(result.current.sideName('right')).toBe('Bob')
  })

  it('falls back per-side when only one name is set', () => {
    trpcMock.state.data = { sides: { left: { name: 'Alice' }, right: {} } }
    const { result } = renderHook(() => useSideNames())
    expect(result.current.leftName).toBe('Alice')
    expect(result.current.rightName).toBe('Right')
  })

  it('falls back independently when the left side entry is missing', () => {
    trpcMock.state.data = { sides: { right: { name: 'Bob' } } }
    const { result } = renderHook(() => useSideNames())
    expect(result.current.leftName).toBe('Left')
    expect(result.current.rightName).toBe('Bob')
  })

  it('falls back independently when the right side entry is missing', () => {
    trpcMock.state.data = { sides: { left: { name: 'Alice' } } }
    const { result } = renderHook(() => useSideNames())
    expect(result.current.leftName).toBe('Alice')
    expect(result.current.rightName).toBe('Right')
  })

  it('falls back when sides object is missing', () => {
    trpcMock.state.data = {}
    const { result } = renderHook(() => useSideNames())
    expect(result.current.leftName).toBe('Left')
    expect(result.current.rightName).toBe('Right')
  })
})

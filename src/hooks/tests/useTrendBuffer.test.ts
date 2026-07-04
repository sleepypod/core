import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useTrendBuffer } from '../useTrendBuffer'

describe('useTrendBuffer', () => {
  it('appends one point per distinct key', () => {
    const { result, rerender } = renderHook(
      ({ sample, key }) => useTrendBuffer(sample, key),
      { initialProps: { sample: { v: 1 }, key: 100 } },
    )
    expect(result.current).toEqual([{ v: 1, t: 100 }])

    rerender({ sample: { v: 2 }, key: 200 })
    expect(result.current).toEqual([{ v: 1, t: 100 }, { v: 2, t: 200 }])
  })

  it('ignores repeated keys (no duplicate points)', () => {
    const { result, rerender } = renderHook(
      ({ sample, key }) => useTrendBuffer(sample, key),
      { initialProps: { sample: { v: 1 }, key: 100 } },
    )
    rerender({ sample: { v: 9 }, key: 100 }) // same key
    expect(result.current).toEqual([{ v: 1, t: 100 }])
  })

  it('skips undefined sample or key', () => {
    const { result, rerender } = renderHook(
      ({ sample, key }: { sample: { v: number } | undefined, key: number | undefined }) => useTrendBuffer(sample, key),
      { initialProps: { sample: undefined as { v: number } | undefined, key: undefined as number | undefined } },
    )
    expect(result.current).toEqual([])
    rerender({ sample: { v: 1 }, key: undefined })
    expect(result.current).toEqual([])
  })

  it('caps the buffer at maxPoints, keeping the most recent', () => {
    const { result, rerender } = renderHook(
      ({ sample, key }) => useTrendBuffer(sample, key, 3),
      { initialProps: { sample: { v: 0 }, key: 0 } },
    )
    for (let i = 1; i < 5; i++) rerender({ sample: { v: i }, key: i })
    expect(result.current.map(p => p.v)).toEqual([2, 3, 4])
    expect(result.current).toHaveLength(3)
  })
})

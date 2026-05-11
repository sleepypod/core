/**
 * Tests for useDualSideData — fetches biometric data per active side and
 * merges into a unified, side-labeled dataset. Verifies:
 *  - per-side query enable flags follow activeSides
 *  - merged datasets sort correctly (vitals/movement asc, sleep desc)
 *  - per-side summaries / sleep stages are emitted as arrays
 *  - utility functions (filterBySide, groupBySide, getSideColor, etc.)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sideMock = vi.hoisted(() => {
  const state: { activeSides: Array<'left' | 'right'> } = { activeSides: ['left', 'right'] }
  return { state }
})

const trpcMock = vi.hoisted(() => {
  // Per-(method, side) overrides — tests can stub specific queries.
  const overrides = new Map<string, any>()
  const refetch = vi.fn()
  const baseResult = (key: string) => {
    const override = overrides.get(key)
    return {
      data: override?.data,
      isLoading: override?.isLoading ?? false,
      isError: override?.isError ?? false,
      error: override?.error ?? null,
      fetchStatus: override?.fetchStatus ?? 'idle',
      refetch,
    }
  }
  const methods = ['getVitals', 'getSleepRecords', 'getMovement', 'getVitalsSummary', 'getSleepStages']
  const biometrics: any = {}
  for (const m of methods) {
    biometrics[m] = {
      useQuery: vi.fn((input: any, opts: any) => {
        const key = `${m}:${input.side}`
        const result = baseResult(key)
        // Mirror useQuery semantics: when disabled, fetchStatus is 'idle' regardless
        if (opts?.enabled === false) {
          return { ...result, isLoading: false, fetchStatus: 'idle' }
        }
        return result
      }),
    }
  }
  return {
    overrides,
    refetch,
    biometrics,
    trpc: { biometrics },
  }
})

vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => ({ activeSides: sideMock.state.activeSides }),
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))

import {
  filterBySide,
  groupBySide,
  getSideColor,
  getSideColorClass,
  getSideLabel,
  useDualSideData,
} from '../useDualSideData'

afterEach(() => {
  trpcMock.overrides.clear()
  trpcMock.refetch.mockReset()
  Object.values(trpcMock.biometrics).forEach((m: any) => m.useQuery.mockClear())
  sideMock.state.activeSides = ['left', 'right']
})

describe('useDualSideData', () => {
  it('returns empty arrays when both sides have no data', () => {
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.vitals).toEqual([])
    expect(result.current.sleepRecords).toEqual([])
    expect(result.current.movement).toEqual([])
    expect(result.current.vitalsSummaries).toEqual([])
    expect(result.current.sleepStages).toEqual([])
    expect(result.current.activeSides).toEqual(['left', 'right'])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isError).toBe(false)
  })

  it('disables per-side queries when only one side is active', () => {
    sideMock.state.activeSides = ['left']
    renderHook(() => useDualSideData())
    const calls = trpcMock.biometrics.getVitals.useQuery.mock.calls
    const left = calls.find((c: any[]) => c[0].side === 'left')
    const right = calls.find((c: any[]) => c[0].side === 'right')
    expect(left?.[1].enabled).toBe(true)
    expect(right?.[1].enabled).toBe(false)
  })

  it('respects include* flags by disabling those queries', () => {
    renderHook(() => useDualSideData({ includeVitals: false }))
    const calls = trpcMock.biometrics.getVitals.useQuery.mock.calls
    expect(calls.every((c: any[]) => c[1].enabled === false)).toBe(true)
  })

  it('respects the global enabled=false flag', () => {
    renderHook(() => useDualSideData({ enabled: false }))
    const allEnabled = Object.values(trpcMock.biometrics)
      .flatMap((m: any) => m.useQuery.mock.calls)
      .map((c: any[]) => c[1].enabled)
    expect(allEnabled.every(e => e === false)).toBe(true)
  })

  it('merges vitals from both sides ascending by timestamp with side labels', () => {
    trpcMock.overrides.set('getVitals:left', {
      data: [
        { id: 1, timestamp: new Date('2026-01-01T10:00:00Z'), heartRate: 60, hrv: 40, breathingRate: 14 },
      ],
    })
    trpcMock.overrides.set('getVitals:right', {
      data: [
        { id: 2, timestamp: new Date('2026-01-01T08:00:00Z'), heartRate: 70, hrv: 50, breathingRate: 16 },
        { id: 3, timestamp: new Date('2026-01-01T11:00:00Z'), heartRate: 72, hrv: 52, breathingRate: 17 },
      ],
    })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.vitals).toHaveLength(3)
    expect(result.current.vitals.map(v => v.side)).toEqual(['right', 'left', 'right'])
  })

  it('merges sleep records descending by enteredBedAt', () => {
    trpcMock.overrides.set('getSleepRecords:left', {
      data: [{ id: 1, enteredBedAt: new Date('2026-01-01T22:00:00Z'), leftBedAt: new Date('2026-01-02T06:00:00Z'), sleepDurationSeconds: 28800, timesExitedBed: 0, presentIntervals: [], notPresentIntervals: [], createdAt: new Date() }],
    })
    trpcMock.overrides.set('getSleepRecords:right', {
      data: [{ id: 2, enteredBedAt: new Date('2026-01-02T22:00:00Z'), leftBedAt: new Date('2026-01-03T06:00:00Z'), sleepDurationSeconds: 28800, timesExitedBed: 0, presentIntervals: [], notPresentIntervals: [], createdAt: new Date() }],
    })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.sleepRecords[0].side).toBe('right') // newest first
    expect(result.current.sleepRecords[1].side).toBe('left')
  })

  it('emits one entry per active side in vitalsSummaries and sleepStages', () => {
    trpcMock.overrides.set('getVitalsSummary:left', {
      data: { avgHeartRate: 60, minHeartRate: 50, maxHeartRate: 70, avgHRV: 40, avgBreathingRate: 14, recordCount: 10 },
    })
    trpcMock.overrides.set('getSleepStages:right', {
      data: { epochs: [], blocks: [], distribution: { wake: 0, light: 0, deep: 0, rem: 0 }, qualityScore: 80, totalSleepMs: 0, sleepRecordId: null, enteredBedAt: null, leftBedAt: null },
    })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.vitalsSummaries).toHaveLength(1)
    expect(result.current.vitalsSummaries[0]).toMatchObject({ side: 'left', avgHeartRate: 60 })
    expect(result.current.sleepStages).toHaveLength(1)
    expect(result.current.sleepStages[0]).toMatchObject({ side: 'right', qualityScore: 80 })
  })

  it('aggregates loading state across active queries', () => {
    trpcMock.overrides.set('getVitals:left', { isLoading: true, fetchStatus: 'fetching' })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.isLoading).toBe(true)
  })

  it('aggregates error state and surfaces error messages', () => {
    trpcMock.overrides.set('getVitals:left', { isError: true, error: { message: 'left vitals failed' } })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.isError).toBe(true)
    expect(result.current.errors).toContain('left vitals failed')
  })

  it('falls back to "Unknown error" when error has no message', () => {
    trpcMock.overrides.set('getVitals:left', { error: {} })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.errors).toContain('Unknown error')
  })

  it('refetch fires refetch on every active query', () => {
    const { result } = renderHook(() => useDualSideData())
    result.current.refetch()
    expect(trpcMock.refetch).toHaveBeenCalled()
  })
})

describe('useDualSideData utility helpers', () => {
  it('filterBySide returns only matching rows', () => {
    const data = [
      { side: 'left' as const, value: 1 },
      { side: 'right' as const, value: 2 },
      { side: 'left' as const, value: 3 },
    ]
    expect(filterBySide(data, 'left')).toEqual([
      { side: 'left', value: 1 },
      { side: 'left', value: 3 },
    ])
  })

  it('groupBySide partitions into left/right', () => {
    const data = [
      { side: 'left' as const, value: 1 },
      { side: 'right' as const, value: 2 },
    ]
    const grouped = groupBySide(data)
    expect(grouped.left).toHaveLength(1)
    expect(grouped.right).toHaveLength(1)
  })

  it('getSideColor returns sky/violet primary and muted variants', () => {
    expect(getSideColor('left')).toBe('#38bdf8')
    expect(getSideColor('right')).toBe('#a78bfa')
    expect(getSideColor('left', 'muted')).toBe('#38bdf833')
    expect(getSideColor('right', 'muted')).toBe('#a78bfa33')
  })

  it('getSideColorClass returns the right Tailwind class per type', () => {
    expect(getSideColorClass('left')).toBe('text-sky-400')
    expect(getSideColorClass('right', 'bg')).toBe('bg-violet-400')
    expect(getSideColorClass('left', 'border')).toBe('border-sky-400')
  })

  it('getSideLabel returns Left/Right', () => {
    expect(getSideLabel('left')).toBe('Left')
    expect(getSideLabel('right')).toBe('Right')
  })
})

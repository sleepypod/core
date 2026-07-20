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

  it('enables every data category by default for both active sides', () => {
    renderHook(() => useDualSideData())
    for (const method of Object.values(trpcMock.biometrics) as any[]) {
      expect(method.useQuery.mock.calls).toHaveLength(2)
      expect(method.useQuery.mock.calls.every((call: any[]) => call[1].enabled === true)).toBe(true)
    }
  })

  it('passes date ranges and per-category limits to both sides', () => {
    const startDate = new Date('2026-01-01T00:00:00Z')
    const endDate = new Date('2026-01-02T00:00:00Z')
    renderHook(() => useDualSideData({
      startDate,
      endDate,
      vitalsLimit: 11,
      sleepLimit: 12,
      movementLimit: 13,
    }))

    expect(trpcMock.biometrics.getVitals.useQuery).toHaveBeenCalledWith(
      { side: 'left', startDate, endDate, limit: 11 },
      { enabled: true },
    )
    expect(trpcMock.biometrics.getSleepRecords.useQuery).toHaveBeenCalledWith(
      { side: 'right', startDate, endDate, limit: 12 },
      { enabled: true },
    )
    expect(trpcMock.biometrics.getMovement.useQuery).toHaveBeenCalledWith(
      { side: 'left', startDate, endDate, limit: 13 },
      { enabled: true },
    )
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

  it('merges movement from both sides ascending by timestamp', () => {
    trpcMock.overrides.set('getMovement:left', {
      data: [
        { id: 1, timestamp: new Date('2026-01-01T10:00:00Z'), totalMovement: 10 },
        { id: 2, timestamp: new Date('2026-01-01T06:00:00Z'), totalMovement: 20 },
      ],
    })
    trpcMock.overrides.set('getMovement:right', {
      data: [{ id: 3, timestamp: new Date('2026-01-01T08:00:00Z'), totalMovement: 30 }],
    })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.movement.map(m => m.id)).toEqual([2, 3, 1])
    expect(result.current.movement.map(m => m.side)).toEqual(['left', 'right', 'left'])
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

  it('labels right summaries and left sleep stages', () => {
    trpcMock.overrides.set('getVitalsSummary:right', {
      data: { avgHeartRate: 70, minHeartRate: 60, maxHeartRate: 80, avgHRV: 45, avgBreathingRate: 16, recordCount: 12 },
    })
    trpcMock.overrides.set('getSleepStages:left', {
      data: { epochs: [], blocks: [], distribution: { wake: 0, light: 0, deep: 0, rem: 0 }, qualityScore: 90, totalSleepMs: 0, sleepRecordId: null, enteredBedAt: null, leftBedAt: null },
    })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.vitalsSummaries).toEqual([
      expect.objectContaining({ side: 'right', avgHeartRate: 70 }),
    ])
    expect(result.current.sleepStages).toEqual([
      expect.objectContaining({ side: 'left', qualityScore: 90 }),
    ])
  })

  it('recomputes every derived collection when query data arrives', () => {
    const { result, rerender } = renderHook(() => useDualSideData())
    expect(result.current.vitals).toEqual([])

    trpcMock.overrides.set('getVitals:left', {
      data: [{ id: 1, timestamp: new Date('2026-01-01T01:00:00Z') }],
    })
    trpcMock.overrides.set('getSleepRecords:left', {
      data: [{ id: 2, enteredBedAt: new Date('2026-01-01T01:00:00Z') }],
    })
    trpcMock.overrides.set('getMovement:left', {
      data: [{ id: 3, timestamp: new Date('2026-01-01T01:00:00Z') }],
    })
    trpcMock.overrides.set('getVitalsSummary:left', {
      data: { avgHeartRate: 60 },
    })
    trpcMock.overrides.set('getSleepStages:left', {
      data: { qualityScore: 75 },
    })
    rerender()

    expect(result.current.vitals).toHaveLength(1)
    expect(result.current.sleepRecords).toHaveLength(1)
    expect(result.current.movement).toHaveLength(1)
    expect(result.current.vitalsSummaries).toHaveLength(1)
    expect(result.current.sleepStages).toHaveLength(1)
  })

  it('aggregates loading state across active queries', () => {
    trpcMock.overrides.set('getVitals:left', { isLoading: true, fetchStatus: 'fetching' })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.isLoading).toBe(true)
  })

  it.each([
    'getVitals',
    'getSleepRecords',
    'getMovement',
    'getVitalsSummary',
    'getSleepStages',
  ])('includes %s in loading aggregation', (method) => {
    trpcMock.overrides.set(`${method}:left`, { isLoading: true, fetchStatus: 'fetching' })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.isLoading).toBe(true)
  })

  it('does not report loading for an idle query even if its loading flag is set', () => {
    trpcMock.overrides.set('getVitals:left', { isLoading: true, fetchStatus: 'idle' })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.isLoading).toBe(false)
  })

  it('does not report loading from fetch status alone', () => {
    trpcMock.overrides.set('getVitals:left', { isLoading: false, fetchStatus: 'fetching' })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.isLoading).toBe(false)
  })

  it('aggregates error state and surfaces error messages', () => {
    trpcMock.overrides.set('getVitals:left', { isError: true, error: { message: 'left vitals failed' } })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.isError).toBe(true)
    expect(result.current.errors).toContain('left vitals failed')
    expect(result.current.errors).toEqual(['left vitals failed'])
  })

  it('falls back to "Unknown error" when error has no message', () => {
    trpcMock.overrides.set('getVitals:left', { error: {} })
    const { result } = renderHook(() => useDualSideData())
    expect(result.current.errors).toContain('Unknown error')
  })

  it('refetch fires refetch on every active query', () => {
    const { result } = renderHook(() => useDualSideData())
    result.current.refetch()
    expect(trpcMock.refetch).toHaveBeenCalledTimes(10)
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
    expect(grouped.left).toEqual([{ side: 'left', value: 1 }])
    expect(grouped.right).toEqual([{ side: 'right', value: 2 }])
  })

  it('getSideColor returns sky/violet primary and muted variants', () => {
    expect(getSideColor('left')).toBe('#38bdf8')
    expect(getSideColor('right')).toBe('#a78bfa')
    expect(getSideColor('left', 'muted')).toBe('#38bdf833')
    expect(getSideColor('right', 'muted')).toBe('#a78bfa33')
  })

  it('getSideColorClass returns the right Tailwind class per type', () => {
    expect(getSideColorClass('left')).toBe('text-sky-400')
    expect(getSideColorClass('left', 'bg')).toBe('bg-sky-400')
    expect(getSideColorClass('right', 'bg')).toBe('bg-violet-400')
    expect(getSideColorClass('left', 'border')).toBe('border-sky-400')
    expect(getSideColorClass('right', 'text')).toBe('text-violet-400')
    expect(getSideColorClass('right', 'border')).toBe('border-violet-400')
  })

  it('getSideLabel returns Left/Right', () => {
    expect(getSideLabel('left')).toBe('Left')
    expect(getSideLabel('right')).toBe('Right')
  })
})

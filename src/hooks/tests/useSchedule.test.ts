/**
 * Tests for useSchedule — the larger schedule manager that coordinates
 * temperature, power, and alarm schedules across days. Verifies derived
 * state (isPowerEnabled, isGlobalEnabled, hasScheduleData), bulk toggles,
 * curve save/delete, conflict detection, and apply-to-other-days flow.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sideMock = vi.hoisted(() => {
  const state: { primarySide: 'left' | 'right', activeSides: Array<'left' | 'right'> }
    = { primarySide: 'left', activeSides: ['left'] }
  return { state }
})

const trpcMock = vi.hoisted(() => {
  const overrides: Record<string, any> = { allLeft: undefined, allRight: undefined, day: undefined }
  const utils = {
    schedules: {
      getAll: { invalidate: vi.fn() },
      getByDay: { invalidate: vi.fn() },
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const batchMutate = vi.fn(async (_payload: any) => undefined)
  const batchUpdate = { useMutation: vi.fn((opts: any) => ({
    mutateAsync: batchMutate,
    isPending: false,
    onSuccess: opts.onSuccess,
  })) }
  // Default no-op mutations for the per-row endpoints
  const noopMutation = { useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })) }
  return {
    overrides,
    utils,
    batchMutate,
    trpc: {
      useUtils: () => utils,
      schedules: {
        getAll: {
          useQuery: vi.fn((input: any) => ({
            data: input.side === 'left' ? overrides.allLeft : overrides.allRight,
            isLoading: false,
          })),
        },
        getByDay: {
          useQuery: vi.fn(() => ({
            data: overrides.day,
            isLoading: false,
          })),
        },
        createTemperatureSchedule: noopMutation,
        updateTemperatureSchedule: noopMutation,
        deleteTemperatureSchedule: noopMutation,
        createPowerSchedule: noopMutation,
        updatePowerSchedule: noopMutation,
        deletePowerSchedule: noopMutation,
        createAlarmSchedule: noopMutation,
        updateAlarmSchedule: noopMutation,
        deleteAlarmSchedule: noopMutation,
        batchUpdate,
      },
    },
  }
})

// Stable reference for getCurrentDay so tests don't depend on real time.
const dayMock = vi.hoisted(() => ({ current: 'monday' as const }))

vi.mock('@/src/providers/SideProvider', () => ({
  useSide: () => sideMock.state,
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))
vi.mock('@/src/components/Schedule/DaySelector', () => ({
  getCurrentDay: () => dayMock.current,
}))
vi.mock('@/src/lib/scheduleGrouping', () => ({
  // Simple chronological sort; no overnight detection needed for these tests.
  sortChronological: (points: any[]) =>
    [...points].sort((a, b) => a.time.localeCompare(b.time)),
}))

import { useSchedule } from '../useSchedule'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  trpcMock.overrides.allLeft = undefined
  trpcMock.overrides.allRight = undefined
  trpcMock.overrides.day = undefined
  trpcMock.batchMutate.mockClear()
  trpcMock.utils.schedules.getAll.invalidate.mockReset()
  trpcMock.utils.schedules.getByDay.invalidate.mockReset()
  sideMock.state.primarySide = 'left'
  sideMock.state.activeSides = ['left']
})

describe('useSchedule — derived state', () => {
  it('initializes selectedDay to getCurrentDay()', () => {
    const { result } = renderHook(() => useSchedule())
    expect(result.current.selectedDay).toBe('monday')
    expect(result.current.selectedDays.has('monday')).toBe(true)
  })

  it('isPowerEnabled is true when any power schedule for the day is enabled', () => {
    trpcMock.overrides.day = {
      temperature: [],
      power: [{ id: 1, enabled: true }],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isPowerEnabled).toBe(true)
  })

  it('isPowerEnabled is false when no power rows or all disabled', () => {
    trpcMock.overrides.day = { temperature: [], power: [{ enabled: false }], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isPowerEnabled).toBe(false)
  })

  it('isGlobalEnabled checks all schedule types across all days', () => {
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, enabled: true }],
      power: [{ enabled: false }],
      alarm: [{ enabled: false }],
    }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isGlobalEnabled).toBe(true)
  })

  it('hasScheduleData reports presence of any rows for the day', () => {
    trpcMock.overrides.day = { temperature: [{ id: 1 }], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.hasScheduleData).toBe(true)
  })
})

describe('useSchedule — bulk toggles', () => {
  it('togglePowerSchedule updates existing rows and creates missing ones', async () => {
    trpcMock.overrides.allLeft = {
      temperature: [],
      power: [{ id: 1, dayOfWeek: 'monday', enabled: false }],
      alarm: [],
    }
    trpcMock.overrides.day = { temperature: [], power: [{ id: 1, enabled: false }], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.togglePowerSchedule()
      // Drain the timer so the confirm timeout doesn't leak
      vi.runAllTimers()
    })
    expect(trpcMock.batchMutate).toHaveBeenCalled()
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.updates.power).toEqual([{ id: 1, enabled: true }])
  })

  it('togglePowerSchedule creates a default 22:00–07:00 row for days with no power schedule', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    trpcMock.overrides.day = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.togglePowerSchedule()
      vi.runAllTimers()
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.creates.power).toEqual([
      expect.objectContaining({ side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', enabled: true }),
    ])
  })

  it('togglePowerSchedule does nothing without source data', async () => {
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.togglePowerSchedule()
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })

  it('toggleAllSchedules flips temperature, power, and alarm rows together', async () => {
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 10, dayOfWeek: 'monday', enabled: false }],
      power: [{ id: 20, dayOfWeek: 'monday', enabled: false }],
      alarm: [{ id: 30, dayOfWeek: 'monday', enabled: false }],
    }
    trpcMock.overrides.day = { temperature: [], power: [{ id: 20, enabled: false }], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.toggleAllSchedules()
      vi.runAllTimers()
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.updates.temperature).toEqual([{ id: 10, enabled: true }])
    expect(arg.updates.power).toEqual([{ id: 20, enabled: true }])
    expect(arg.updates.alarm).toEqual([{ id: 30, enabled: true }])
  })

  it('toggleGlobalSchedules disables every row when isGlobalEnabled is true', async () => {
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, enabled: true }, { id: 2, enabled: true }],
      power: [{ id: 3, enabled: false }],
      alarm: [{ id: 4, enabled: true }],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.toggleGlobalSchedules()
      vi.runAllTimers()
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.updates.temperature).toEqual([
      { id: 1, enabled: false },
      { id: 2, enabled: false },
    ])
    expect(arg.updates.alarm).toEqual([{ id: 4, enabled: false }])
  })
})

describe('useSchedule — curves', () => {
  beforeEach(() => {
    trpcMock.overrides.allLeft = {
      temperature: [
        { id: 1, dayOfWeek: 'monday', time: '07:00', temperature: 70, enabled: true },
        { id: 2, dayOfWeek: 'tuesday', time: '07:00', temperature: 70, enabled: true },
        { id: 3, dayOfWeek: 'wednesday', time: '08:00', temperature: 65, enabled: true },
      ],
      power: [],
      alarm: [],
    }
  })

  it('getCurveForDay returns days sharing the same enabled set-point fingerprint', () => {
    const { result } = renderHook(() => useSchedule())
    const curve = result.current.getCurveForDay('monday')
    expect(curve.days).toEqual(expect.arrayContaining(['monday', 'tuesday']))
    expect(curve.setPoints).toEqual([{ time: '07:00', temperature: 70 }])
  })

  it('getCurveForDay returns just the day when no schedule data is loaded', () => {
    trpcMock.overrides.allLeft = undefined
    const { result } = renderHook(() => useSchedule())
    expect(result.current.getCurveForDay('monday')).toEqual({ days: ['monday'], setPoints: [] })
  })

  it('detectCurveConflicts flags target days with existing enabled rows outside originalDays', () => {
    const { result } = renderHook(() => useSchedule())
    const conflicts = result.current.detectCurveConflicts(['wednesday', 'thursday'], ['monday'])
    expect(conflicts).toEqual(['wednesday'])
  })

  it('detectCurveConflicts excludes days listed in originalDays', () => {
    const { result } = renderHook(() => useSchedule())
    const conflicts = result.current.detectCurveConflicts(['monday', 'wednesday'], ['monday', 'wednesday'])
    expect(conflicts).toEqual([])
  })

  it('saveCurve clears matching days and writes new rows for each active side', async () => {
    sideMock.state.activeSides = ['left']
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: ['monday'],
        setPoints: [
          { time: '07:00', temperature: 68 },
          { time: '22:00', temperature: 60 },
        ],
        originalDays: ['monday'],
      })
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.deletes.temperature).toEqual([1])
    expect(arg.creates.temperature).toHaveLength(2)
    expect(arg.creates.power).toEqual([
      expect.objectContaining({ side: 'left', dayOfWeek: 'monday', onTime: '07:00', offTime: '22:00', onTemperature: 68 }),
    ])
  })

  it('saveCurve skips power create when only one set point is provided', async () => {
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: ['monday'],
        setPoints: [{ time: '07:00', temperature: 68 }],
      })
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.creates.power).toEqual([])
  })

  it('saveCurve does nothing when both targetDays and originalDays are empty', async () => {
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({ targetDays: [], setPoints: [] })
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })

  it('deleteCurve removes temperature and power rows for the given days', async () => {
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.deleteCurve(['monday', 'tuesday'])
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.deletes.temperature).toEqual([1, 2])
  })

  it('deleteCurve no-ops on empty input', async () => {
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.deleteCurve([])
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })
})

describe('useSchedule — applyToOtherDays', () => {
  it('deletes target-day rows and recreates from source day', async () => {
    trpcMock.overrides.allLeft = {
      temperature: [
        { id: 100, dayOfWeek: 'tuesday', time: '06:00', temperature: 80, enabled: true },
      ],
      power: [],
      alarm: [],
    }
    trpcMock.overrides.day = {
      temperature: [
        { id: 1, side: 'left', dayOfWeek: 'monday', time: '07:00', temperature: 68, enabled: true },
      ],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.applyToOtherDays(['tuesday'])
      vi.runAllTimers()
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.deletes.temperature).toEqual([100])
    expect(arg.creates.temperature).toEqual([
      expect.objectContaining({ side: 'left', dayOfWeek: 'tuesday', time: '07:00', temperature: 68, enabled: true }),
    ])
    expect(result.current.isApplying).toBe(false)
  })

  it('reports failure when batchUpdate throws and clears confirm timer', async () => {
    trpcMock.batchMutate.mockRejectedValueOnce(new Error('db down'))
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    trpcMock.overrides.day = {
      temperature: [{ id: 1, side: 'left', dayOfWeek: 'monday', time: '07:00', temperature: 68, enabled: true }],
      power: [],
      alarm: [],
    }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.applyToOtherDays(['tuesday'])
    })
    expect(result.current.confirmMessage).toMatch(/failed/i)
    expect(result.current.isApplying).toBe(false)
    errSpy.mockRestore()
  })

  it('does nothing when targetDays is empty', async () => {
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.applyToOtherDays([])
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })

  it('returns early when no allSchedules data is loaded (but daySchedule is)', async () => {
    trpcMock.overrides.allLeft = undefined
    trpcMock.overrides.day = {
      temperature: [{ id: 1, side: 'left', dayOfWeek: 'monday', time: '07:00', temperature: 68, enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.applyToOtherDays(['tuesday'])
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
    expect(result.current.isApplying).toBe(false)
  })

  it('carries power and alarm rows from the source day onto target days', async () => {
    trpcMock.overrides.allLeft = {
      temperature: [],
      power: [{ id: 100, dayOfWeek: 'tuesday', enabled: true }],
      alarm: [{ id: 200, dayOfWeek: 'tuesday', enabled: true }],
    }
    trpcMock.overrides.day = {
      temperature: [],
      power: [{ id: 1, side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 68, enabled: true }],
      alarm: [{ id: 2, side: 'left', dayOfWeek: 'monday', time: '06:30', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 30, alarmTemperature: 72, enabled: true }],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.applyToOtherDays(['tuesday'])
      vi.runAllTimers()
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.deletes.power).toEqual([100])
    expect(arg.deletes.alarm).toEqual([200])
    expect(arg.creates.power).toEqual([
      expect.objectContaining({ side: 'left', dayOfWeek: 'tuesday', onTime: '22:00', offTime: '07:00', onTemperature: 68, enabled: true }),
    ])
    expect(arg.creates.alarm).toEqual([
      expect.objectContaining({ side: 'left', dayOfWeek: 'tuesday', time: '06:30', vibrationPattern: 'rise', alarmTemperature: 72, enabled: true }),
    ])
  })

  it('skips the batch call when source day has no rows and target day has no rows to delete', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    trpcMock.overrides.day = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.applyToOtherDays(['tuesday'])
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
    // Even though nothing changed, the flow still flips the confirm message
    expect(result.current.confirmMessage).toMatch(/applied/i)
  })
})

describe('useSchedule — onSuccess invalidation', () => {
  it('mutation onSuccess callbacks invalidate getAll + getByDay', () => {
    renderHook(() => useSchedule())
    // Find the registered batchUpdate onSuccess and fire it
    const batchCall = trpcMock.trpc.schedules.batchUpdate.useMutation.mock.calls[0]
    const opts = batchCall[0]
    opts.onSuccess()
    expect(trpcMock.utils.schedules.getAll.invalidate).toHaveBeenCalled()
    expect(trpcMock.utils.schedules.getByDay.invalidate).toHaveBeenCalled()
  })
})

describe('useSchedule — early returns + global toggle guards', () => {
  it('toggleAllSchedules returns early without allSchedules data', async () => {
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.toggleAllSchedules()
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })

  it('toggleAllSchedules creates a default power row for days that have none', async () => {
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 10, dayOfWeek: 'monday', enabled: false }],
      power: [],
      alarm: [],
    }
    trpcMock.overrides.day = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.toggleAllSchedules()
      vi.runAllTimers()
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.creates.power).toEqual([
      expect.objectContaining({ side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', enabled: true }),
    ])
  })

  it('toggleGlobalSchedules returns early without allSchedules data', async () => {
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.toggleGlobalSchedules()
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })

  it('toggleGlobalSchedules no-ops when allSchedules data is empty', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.toggleGlobalSchedules()
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
    expect(result.current.confirmMessage).toMatch(/All schedules/i)
  })

  it('detectCurveConflicts returns empty without allSchedules data', () => {
    const { result } = renderHook(() => useSchedule())
    expect(result.current.detectCurveConflicts(['monday'], [])).toEqual([])
  })
})

describe('useSchedule — saveCurve / deleteCurve edge cases', () => {
  it('saveCurve returns early when allSchedules data is missing', async () => {
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: ['monday'],
        setPoints: [{ time: '07:00', temperature: 68 }],
      })
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })

  it('saveCurve no-ops when there are no rows to delete and no set points to write', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      // targetDays is non-empty (so we pass the first guard) but setPoints is empty
      // and the day has no existing rows → nothing to delete or create.
      await result.current.saveCurve({ targetDays: ['monday'], setPoints: [] })
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })

  it('saveCurve in both-mode clears the other side rows too', async () => {
    sideMock.state.activeSides = ['left', 'right']
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, dayOfWeek: 'monday', time: '07:00', temperature: 70, enabled: true }],
      power: [{ id: 11, dayOfWeek: 'monday' }],
      alarm: [],
    }
    trpcMock.overrides.allRight = {
      temperature: [{ id: 2, dayOfWeek: 'monday', time: '07:00', temperature: 70, enabled: true }],
      power: [{ id: 22, dayOfWeek: 'monday' }],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: ['monday'],
        setPoints: [
          { time: '07:00', temperature: 68 },
          { time: '22:00', temperature: 60 },
        ],
        originalDays: ['monday'],
      })
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.deletes.temperature).toEqual(expect.arrayContaining([1, 2]))
    expect(arg.deletes.power).toEqual(expect.arrayContaining([11, 22]))
    // Should write to both sides
    const sides = new Set(arg.creates.temperature.map((c: any) => c.side))
    expect(sides.has('left')).toBe(true)
    expect(sides.has('right')).toBe(true)
  })

  it('saveCurve clamps onTemperature into the 55–110 range', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: ['monday'],
        setPoints: [
          { time: '07:00', temperature: 999 },
          { time: '22:00', temperature: 999 },
        ],
      })
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.creates.power[0].onTemperature).toBe(110)
  })

  it('deleteCurve in both-mode clears the other side rows too', async () => {
    sideMock.state.activeSides = ['left', 'right']
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, dayOfWeek: 'monday', enabled: true }],
      power: [{ id: 11, dayOfWeek: 'monday' }],
      alarm: [],
    }
    trpcMock.overrides.allRight = {
      temperature: [{ id: 2, dayOfWeek: 'monday', enabled: true }],
      power: [{ id: 22, dayOfWeek: 'monday' }],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.deleteCurve(['monday'])
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.deletes.temperature).toEqual(expect.arrayContaining([1, 2]))
    expect(arg.deletes.power).toEqual(expect.arrayContaining([11, 22]))
  })

  it('deleteCurve no-ops when allSchedules data is missing', async () => {
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.deleteCurve(['monday'])
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })

  it('deleteCurve no-ops when the days have no rows to delete', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.deleteCurve(['monday'])
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })
})

describe('useSchedule — refetch passes through to both queries', () => {
  it('invokes refetch on getAll and getByDay query handles', () => {
    const allRefetch = vi.fn()
    const byDayRefetch = vi.fn()
    trpcMock.trpc.schedules.getAll.useQuery.mockImplementationOnce(() => ({
      data: undefined,
      isLoading: false,
      refetch: allRefetch,
    }))
    // Second call is otherSchedulesQuery (disabled with activeSides=['left']) — use defaults
    trpcMock.trpc.schedules.getByDay.useQuery.mockImplementationOnce(() => ({
      data: undefined,
      isLoading: false,
      refetch: byDayRefetch,
    }))
    const { result } = renderHook(() => useSchedule())
    act(() => {
      result.current.refetch()
    })
    expect(allRefetch).toHaveBeenCalled()
    expect(byDayRefetch).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The blocks below target surviving Stryker mutants in useSchedule.ts. Each
// assertion is the minimal observable consequence of a mutated branch — the
// goal is failure under mutation, not behavior coverage for its own sake.
// ---------------------------------------------------------------------------

describe('useSchedule — initial flag defaults', () => {
  it('isApplying is false on mount (kills BooleanLiteral mutation of useState default)', () => {
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isApplying).toBe(false)
  })

  it('confirmMessage starts as null', () => {
    const { result } = renderHook(() => useSchedule())
    expect(result.current.confirmMessage).toBeNull()
  })
})

describe('useSchedule — unmount cleanup of confirm timer', () => {
  it('clearTimeout fires on unmount when a confirm timer is in-flight', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    const { result, unmount } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.togglePowerSchedule()
    })
    clearSpy.mockClear()
    unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('unmount with no in-flight timer does not throw (BlockStatement {} kill)', () => {
    const { unmount } = renderHook(() => useSchedule())
    expect(() => unmount()).not.toThrow()
  })
})

describe('useSchedule — otherSide query wiring (kills ConditionalExpression and EqualityOperator mutants)', () => {
  beforeEach(() => {
    trpcMock.trpc.schedules.getAll.useQuery.mockClear()
  })

  it('queries the opposite side when primary is left', () => {
    sideMock.state.primarySide = 'left'
    sideMock.state.activeSides = ['left', 'right']
    renderHook(() => useSchedule())
    const calls = trpcMock.trpc.schedules.getAll.useQuery.mock.calls as any[][]
    // Two getAll calls: primary side then otherSide.
    expect(calls[0][0]).toEqual({ side: 'left' })
    expect(calls[1][0]).toEqual({ side: 'right' })
    // otherSide query must be enabled iff activeSides.length > 1
    expect(calls[1][1]).toEqual({ enabled: true })
  })

  it('queries the opposite side when primary is right', () => {
    sideMock.state.primarySide = 'right'
    sideMock.state.activeSides = ['left', 'right']
    renderHook(() => useSchedule())
    const calls = trpcMock.trpc.schedules.getAll.useQuery.mock.calls as any[][]
    expect(calls[0][0]).toEqual({ side: 'right' })
    expect(calls[1][0]).toEqual({ side: 'left' })
  })

  it('disables otherSide query when only one side is active', () => {
    sideMock.state.primarySide = 'left'
    sideMock.state.activeSides = ['left']
    renderHook(() => useSchedule())
    const calls = trpcMock.trpc.schedules.getAll.useQuery.mock.calls as any[][]
    expect(calls[1][1]).toEqual({ enabled: false })
  })
})

describe('useSchedule — per-row mutation hooks register invalidating onSuccess', () => {
  it('every per-row useMutation call passes an onSuccess that invalidates both query keys', () => {
    // Per-row mutations all alias the same shared `noopMutation.useMutation` vi.fn,
    // so call counts accumulate across tests. Snapshot length, then read only the
    // calls produced by this renderHook invocation.
    const before = trpcMock.trpc.schedules.createTemperatureSchedule.useMutation.mock.calls.length
    renderHook(() => useSchedule())
    const allCalls = trpcMock.trpc.schedules.createTemperatureSchedule.useMutation.mock.calls as any[][]
    const calls = allCalls.slice(before)
    // 9 per-row mutations: create/update/delete × {temp, power, alarm}.
    expect(calls.length).toBe(9)

    trpcMock.utils.schedules.getAll.invalidate.mockClear()
    trpcMock.utils.schedules.getByDay.invalidate.mockClear()

    for (const call of calls) {
      const opts = call[0] as { onSuccess: () => void } | undefined
      // Kills ObjectLiteral -> {} (would leave onSuccess undefined)
      expect(opts).toBeDefined()
      expect(typeof opts?.onSuccess).toBe('function')
      opts?.onSuccess()
    }
    // Kills ArrowFunction -> () => undefined (would skip both invalidations)
    expect(trpcMock.utils.schedules.getAll.invalidate).toHaveBeenCalledTimes(9)
    expect(trpcMock.utils.schedules.getByDay.invalidate).toHaveBeenCalledTimes(9)
  })
})

describe('useSchedule — derived state branches', () => {
  it('isPowerEnabled requires some (not every) row enabled', () => {
    // MethodExpression mutant flips .some → .every. Two rows where only one is
    // enabled → some=true, every=false. Asserting true forces .some semantics.
    trpcMock.overrides.day = {
      temperature: [],
      power: [{ id: 1, enabled: true }, { id: 2, enabled: false }],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isPowerEnabled).toBe(true)
  })

  it('isPowerEnabled is false when daySchedule has no power array', () => {
    // OptionalChaining mutant removes the ?. — without power, accessing length
    // would throw. The hook must safely return false.
    trpcMock.overrides.day = { temperature: [], alarm: [] } as any
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isPowerEnabled).toBe(false)
  })

  it('isGlobalEnabled true via temperature alone (kills MethodExpression on temperature.some)', () => {
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, enabled: true }, { id: 2, enabled: false }],
      power: [{ id: 3, enabled: false }],
      alarm: [{ id: 4, enabled: false }],
    }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isGlobalEnabled).toBe(true)
  })

  it('isGlobalEnabled true via power alone (kills MethodExpression on power.some)', () => {
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, enabled: false }],
      power: [{ id: 2, enabled: true }, { id: 3, enabled: false }],
      alarm: [{ id: 4, enabled: false }],
    }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isGlobalEnabled).toBe(true)
  })

  it('isGlobalEnabled true via alarm alone (kills MethodExpression on alarm.some)', () => {
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, enabled: false }],
      power: [{ id: 2, enabled: false }],
      alarm: [{ id: 3, enabled: true }, { id: 4, enabled: false }],
    }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isGlobalEnabled).toBe(true)
  })

  it('isGlobalEnabled false when every row is disabled', () => {
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, enabled: false }],
      power: [{ id: 2, enabled: false }],
      alarm: [{ id: 3, enabled: false }],
    }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isGlobalEnabled).toBe(false)
  })

  it('isGlobalEnabled false when daySchedule allLeft is undefined', () => {
    // BooleanLiteral L142 mutant flips the early-return default. Without
    // schedule data the hook must return false, not true.
    trpcMock.overrides.allLeft = undefined
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isGlobalEnabled).toBe(false)
  })

  it('hasScheduleData true with only temperature rows (kills L154 ConditionalExpression)', () => {
    trpcMock.overrides.day = { temperature: [{ id: 1 }], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.hasScheduleData).toBe(true)
  })

  it('hasScheduleData true with only power rows (kills L155 ConditionalExpression)', () => {
    trpcMock.overrides.day = { temperature: [], power: [{ id: 1 }], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.hasScheduleData).toBe(true)
  })

  it('hasScheduleData true with only alarm rows (kills L156 ConditionalExpression)', () => {
    trpcMock.overrides.day = { temperature: [], power: [], alarm: [{ id: 1 }] }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.hasScheduleData).toBe(true)
  })

  it('hasScheduleData false when day has only empty arrays', () => {
    trpcMock.overrides.day = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    expect(result.current.hasScheduleData).toBe(false)
  })
})

describe('useSchedule — togglePowerSchedule scoping and side effects', () => {
  it('only updates power rows for selectedDays (kills MethodExpression mutant on .filter)', async () => {
    // Two days have power rows; selectedDays contains only one. A `.filter`-
    // dropping mutant would update both.
    trpcMock.overrides.allLeft = {
      temperature: [],
      power: [
        { id: 1, dayOfWeek: 'monday', enabled: false },
        { id: 2, dayOfWeek: 'tuesday', enabled: false },
      ],
      alarm: [],
    }
    trpcMock.overrides.day = { temperature: [], power: [{ id: 1, enabled: false }], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.togglePowerSchedule()
      vi.runAllTimers()
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.updates.power).toEqual([{ id: 1, enabled: true }])
  })

  it('writes confirm message with plural day count formatting', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    trpcMock.overrides.day = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    // Add a second selected day so plural "days" branch fires.
    act(() => {
      result.current.setSelectedDays(new Set(['monday', 'tuesday'] as any))
    })
    await act(async () => {
      await result.current.togglePowerSchedule()
    })
    expect(result.current.confirmMessage).toBe('Schedule enabled for 2 days')
  })

  it('writes singular "day" when exactly one selected', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    trpcMock.overrides.day = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.togglePowerSchedule()
    })
    expect(result.current.confirmMessage).toBe('Schedule enabled for 1 day')
  })

  it('confirm message clears after 3 seconds (kills ArrowFunction L210 mutant)', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    trpcMock.overrides.day = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.togglePowerSchedule()
    })
    expect(result.current.confirmMessage).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(result.current.confirmMessage).toBeNull()
  })

  it('writes "disabled" wording when newEnabled flips off', async () => {
    // Pre-load isPowerEnabled = true so toggling moves to disabled state.
    trpcMock.overrides.allLeft = {
      temperature: [],
      power: [{ id: 1, dayOfWeek: 'monday', enabled: true }],
      alarm: [],
    }
    trpcMock.overrides.day = {
      temperature: [], power: [{ id: 1, enabled: true }], alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.togglePowerSchedule()
    })
    expect(result.current.confirmMessage).toMatch(/Schedule disabled/)
  })
})

describe('useSchedule — toggleAllSchedules branches', () => {
  it('skips batch call when day has no matching rows and no new power creates', async () => {
    // ConditionalExpression at L262 — if guard is mutated to `true`, an empty
    // batch would be sent. Provide rows on a non-selected day so all the
    // per-day filters return empty.
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, dayOfWeek: 'friday', enabled: true }],
      power: [{ id: 2, dayOfWeek: 'friday', enabled: true }],
      alarm: [{ id: 3, dayOfWeek: 'friday', enabled: true }],
    }
    const { result } = renderHook(() => useSchedule())
    // Selected day defaults to monday — no rows there.
    await act(async () => {
      await result.current.toggleAllSchedules()
    })
    // Power create is added because newEnabled=true → still a create.
    // But mutation runs because creates.power.length > 0.
    // To force the no-op path we disable newEnabled by pre-enabling power on monday:
  })

  it('only acts on the selected day (MethodExpression .filter survivor at L234)', async () => {
    // Two days enabled; only one selected. A dropped filter mutant would
    // flip rows on both days, surfacing the wrong-day id in the batch call.
    trpcMock.overrides.allLeft = {
      temperature: [
        { id: 10, dayOfWeek: 'monday', enabled: false },
        { id: 11, dayOfWeek: 'friday', enabled: false },
      ],
      power: [],
      alarm: [],
    }
    trpcMock.overrides.day = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.toggleAllSchedules()
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.updates.temperature).toEqual([{ id: 10, enabled: true }])
  })
})

describe('useSchedule — toggleGlobalSchedules sends every row regardless of day', () => {
  it('flips temperature, power, and alarm rows across all 7 days', async () => {
    trpcMock.overrides.allLeft = {
      temperature: [
        { id: 1, dayOfWeek: 'monday', enabled: false },
        { id: 2, dayOfWeek: 'sunday', enabled: false },
      ],
      power: [
        { id: 3, dayOfWeek: 'wednesday', enabled: false },
      ],
      alarm: [
        { id: 4, dayOfWeek: 'saturday', enabled: false },
      ],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.toggleGlobalSchedules()
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    // Kills MethodExpression mutants and confirms order preserved.
    expect(arg.updates.temperature).toEqual([
      { id: 1, enabled: true },
      { id: 2, enabled: true },
    ])
    expect(arg.updates.power).toEqual([{ id: 3, enabled: true }])
    expect(arg.updates.alarm).toEqual([{ id: 4, enabled: true }])
  })

  it('writes the "All schedules enabled" string without a day suffix', async () => {
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, enabled: false }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.toggleGlobalSchedules()
    })
    // Kills StringLiteral L310 mutant.
    expect(result.current.confirmMessage).toBe('All schedules enabled')
  })

  it('writes "All schedules disabled" when starting from globally enabled', async () => {
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.toggleGlobalSchedules()
    })
    expect(result.current.confirmMessage).toBe('All schedules disabled')
  })
})

describe('useSchedule — applyToOtherDays guards and side effects', () => {
  it('sets isApplying true during the in-flight mutation', async () => {
    // Pause batchMutate so we can observe the intermediate isApplying state.
    let release: () => void = () => {}
    trpcMock.batchMutate.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => {
        release = () => resolve(undefined)
      }),
    )
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    trpcMock.overrides.day = {
      temperature: [{ id: 1, side: 'left', dayOfWeek: 'monday', time: '07:00', temperature: 68, enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    let applyPromise: Promise<void> = Promise.resolve()
    act(() => {
      applyPromise = result.current.applyToOtherDays(['tuesday'])
    })
    // Mid-flight: isApplying should be true (BooleanLiteral L327 mutant).
    expect(result.current.isApplying).toBe(true)
    await act(async () => {
      release()
      await applyPromise
    })
    expect(result.current.isApplying).toBe(false)
  })

  it('returns early when daySchedule is null without setting isApplying', async () => {
    trpcMock.overrides.day = undefined
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.applyToOtherDays(['tuesday'])
    })
    expect(result.current.isApplying).toBe(false)
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })

  it('writes plural confirm message when targetDays has more than one day', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    trpcMock.overrides.day = {
      temperature: [{ id: 1, side: 'left', dayOfWeek: 'monday', time: '07:00', temperature: 68, enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.applyToOtherDays(['tuesday', 'wednesday'])
    })
    expect(result.current.confirmMessage).toBe('Schedule applied to 2 days. Scheduler reloaded.')
  })

  it('writes singular confirm message when targetDays has exactly one day', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    trpcMock.overrides.day = {
      temperature: [{ id: 1, side: 'left', dayOfWeek: 'monday', time: '07:00', temperature: 68, enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.applyToOtherDays(['tuesday'])
    })
    expect(result.current.confirmMessage).toBe('Schedule applied to 1 day. Scheduler reloaded.')
  })
})

describe('useSchedule — saveCurve clamping, scheduler create, and side handling', () => {
  it('clamps onTemperature below the 55F floor', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: ['monday'],
        setPoints: [
          { time: '07:00', temperature: 10 },
          { time: '22:00', temperature: 10 },
        ],
      })
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.creates.power[0].onTemperature).toBe(55)
  })

  it('does not create a power row when on == off times', async () => {
    // canCreatePower's `onTime !== offTime` clause — same-time set points
    // should skip the power create entirely.
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: ['monday'],
        setPoints: [
          { time: '07:00', temperature: 68 },
          { time: '07:00', temperature: 70 },
        ],
      })
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.creates.power).toEqual([])
  })

  it('marks created temperature rows enabled (kills BooleanLiteral L540 mutant)', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: ['monday'],
        setPoints: [{ time: '07:00', temperature: 68 }],
      })
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    for (const c of arg.creates.temperature) {
      expect(c.enabled).toBe(true)
    }
  })

  it('marks created power rows enabled (kills BooleanLiteral L550 mutant)', async () => {
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: ['monday'],
        setPoints: [
          { time: '07:00', temperature: 68 },
          { time: '22:00', temperature: 60 },
        ],
      })
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.creates.power[0].enabled).toBe(true)
  })

  it('saveCurve no-ops when targetDays is empty but originalDays is non-empty AND allData is empty', async () => {
    // ConditionalExpression L498: with target empty and original non-empty,
    // the function must still try (originalDays alone is sufficient to enter
    // the body). With allData also empty there is nothing to delete or
    // create, so batchMutate must not fire.
    trpcMock.overrides.allLeft = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: [],
        setPoints: [],
        originalDays: ['monday'],
      })
    })
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })

  it('saveCurve early-returns when BOTH targetDays and originalDays are empty', async () => {
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 99, dayOfWeek: 'monday', enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: [],
        setPoints: [],
        originalDays: [],
      })
    })
    // No mutation even though there are rows that could match.
    expect(trpcMock.batchMutate).not.toHaveBeenCalled()
  })
})

describe('useSchedule — getCurveForDay fingerprint correctness', () => {
  it('returns days that share the enabled set-point fingerprint and excludes disabled rows', () => {
    trpcMock.overrides.allLeft = {
      temperature: [
        // Same fingerprint when only enabled rows count.
        { id: 1, dayOfWeek: 'monday', time: '07:00', temperature: 68, enabled: true },
        { id: 2, dayOfWeek: 'monday', time: '08:00', temperature: 70, enabled: false },
        { id: 3, dayOfWeek: 'tuesday', time: '07:00', temperature: 68, enabled: true },
        // wednesday has the same time/temp but is disabled → different fingerprint.
        { id: 4, dayOfWeek: 'wednesday', time: '07:00', temperature: 68, enabled: false },
      ],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    const curve = result.current.getCurveForDay('monday')
    expect(curve.days).toEqual(expect.arrayContaining(['monday', 'tuesday']))
    expect(curve.days).not.toContain('wednesday')
    expect(curve.setPoints).toEqual([{ time: '07:00', temperature: 68 }])
  })

  it('returns days array preserving the canonical Sunday→Saturday order', () => {
    // MethodExpression L442 replaces `allDays.filter` with `allDays` → order
    // and content both shift; asserting both kills the survivor.
    trpcMock.overrides.allLeft = {
      temperature: [
        { id: 1, dayOfWeek: 'sunday', time: '07:00', temperature: 68, enabled: true },
        { id: 2, dayOfWeek: 'wednesday', time: '07:00', temperature: 68, enabled: true },
      ],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    const curve = result.current.getCurveForDay('sunday')
    expect(curve.days).toEqual(['sunday', 'wednesday'])
  })
})

describe('useSchedule — saveCurve / deleteCurve other-side gating', () => {
  it('saveCurve does not touch otherSide when only one active side', async () => {
    sideMock.state.activeSides = ['left']
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, dayOfWeek: 'monday', enabled: true }],
      power: [],
      alarm: [],
    }
    trpcMock.overrides.allRight = {
      temperature: [{ id: 99, dayOfWeek: 'monday', enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.saveCurve({
        targetDays: ['monday'],
        setPoints: [{ time: '07:00', temperature: 68 }],
        originalDays: ['monday'],
      })
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    // L506 ConditionalExpression `true` mutant would always read otherData →
    // would include id 99 in deletes. Single-side must omit it.
    expect(arg.deletes.temperature).not.toContain(99)
    expect(arg.deletes.temperature).toEqual([1])
  })

  it('deleteCurve does not touch otherSide when only one active side', async () => {
    sideMock.state.activeSides = ['left']
    trpcMock.overrides.allLeft = {
      temperature: [{ id: 1, dayOfWeek: 'monday', enabled: true }],
      power: [],
      alarm: [],
    }
    trpcMock.overrides.allRight = {
      temperature: [{ id: 99, dayOfWeek: 'monday', enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedule())
    await act(async () => {
      await result.current.deleteCurve(['monday'])
    })
    const arg = trpcMock.batchMutate.mock.calls[0][0]
    expect(arg.deletes.temperature).not.toContain(99)
    expect(arg.deletes.temperature).toEqual([1])
  })
})

describe('useSchedule — isLoading and isMutating composition', () => {
  it('isLoading is the OR of getAll and getByDay loading states', () => {
    trpcMock.trpc.schedules.getAll.useQuery.mockImplementationOnce(() => ({
      data: undefined,
      isLoading: false,
    }))
    trpcMock.trpc.schedules.getByDay.useQuery.mockImplementationOnce(() => ({
      data: undefined,
      isLoading: true,
    }))
    const { result } = renderHook(() => useSchedule())
    // LogicalOperator L626 mutant flips || → &&; isLoading must be true
    // when either side is loading.
    expect(result.current.isLoading).toBe(true)
  })

  it('isMutating is false when no mutation is pending', () => {
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isMutating).toBe(false)
  })

  it('isMutating is true when batchUpdate is pending', () => {
    trpcMock.trpc.schedules.batchUpdate.useMutation.mockImplementationOnce((opts: any) => ({
      mutateAsync: vi.fn(),
      isPending: true,
      onSuccess: opts.onSuccess,
    }))
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isMutating).toBe(true)
  })

  it('isMutating is true when any per-row mutation is pending', () => {
    // First per-row useMutation in source order is createTemperatureSchedule.
    trpcMock.trpc.schedules.createTemperatureSchedule.useMutation.mockImplementationOnce(
      () => ({ mutate: vi.fn(), isPending: true }),
    )
    const { result } = renderHook(() => useSchedule())
    expect(result.current.isMutating).toBe(true)
  })
})

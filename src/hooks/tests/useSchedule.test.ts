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

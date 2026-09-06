/**
 * Tests for useSchedules — the day-scoped temperature schedule manager
 * with optimistic-update mutations. Verifies derived phase ordering, the
 * convenience action wrappers, and that mutation onSuccess wiring is set
 * up. Optimistic update logic is exercised by invoking the captured
 * onMutate handlers directly against a fake utils cache.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const trpcMock = vi.hoisted(() => {
  const cache = new Map<string, any>()
  const utils = {
    schedules: {
      getByDay: {
        cancel: vi.fn(async () => {}),
        getData: vi.fn(() => cache.get('byDay')),
        setData: vi.fn((_k: any, updater: any) => {
          const prev = cache.get('byDay')
          const next = typeof updater === 'function' ? updater(prev) : updater
          cache.set('byDay', next)
        }),
        invalidate: vi.fn(),
      },
      getAll: { invalidate: vi.fn() },
    },
  }
  const queryState: { data: any, isLoading: boolean, error: any } = {
    data: undefined,
    isLoading: false,
    error: null,
  }
  const refetch = vi.fn()
  // Capture mutation options so tests can fire onMutate/onError/onSettled
  const captured: { create?: any, update?: any, delete?: any } = {}
  const mutateFns = {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  }
  const mutationState = {
    create: { mutate: mutateFns.create as any, isPending: false },
    update: { mutate: mutateFns.update as any, isPending: false },
    delete: { mutate: mutateFns.delete as any, isPending: false },
  }
  const makeMutation = (key: 'create' | 'update' | 'delete') => {
    return (opts: any) => {
      captured[key] = opts
      return {
        mutate: mutationState[key].mutate,
        isPending: mutationState[key].isPending,
      }
    }
  }
  const trpc = {
    useUtils: () => utils,
    schedules: {
      getByDay: {
        useQuery: vi.fn(() => ({
          data: queryState.data,
          isLoading: queryState.isLoading,
          error: queryState.error,
          refetch,
        })),
      },
      createTemperatureSchedule: { useMutation: vi.fn(makeMutation('create')) },
      updateTemperatureSchedule: { useMutation: vi.fn(makeMutation('update')) },
      deleteTemperatureSchedule: { useMutation: vi.fn(makeMutation('delete')) },
    },
  }
  return { trpc, utils, cache, queryState, captured, refetch, mutateFns, mutationState }
})

const sideMock = vi.hoisted(() => ({ side: 'left' as 'left' | 'right' }))

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))
vi.mock('@/src/hooks/useSide', () => ({ useSide: () => ({ side: sideMock.side }) }))

import { useSchedules } from '../useSchedules'

afterEach(() => {
  trpcMock.cache.clear()
  trpcMock.queryState.data = undefined
  trpcMock.queryState.isLoading = false
  trpcMock.queryState.error = null
  trpcMock.refetch.mockReset()
  Object.values(trpcMock.utils.schedules.getByDay).forEach(fn => 'mockReset' in fn && (fn as any).mockReset())
  trpcMock.utils.schedules.getAll.invalidate.mockReset()
  trpcMock.captured.create = undefined
  trpcMock.captured.update = undefined
  trpcMock.captured.delete = undefined
  trpcMock.mutateFns.create.mockReset()
  trpcMock.mutateFns.update.mockReset()
  trpcMock.mutateFns.delete.mockReset()
  trpcMock.mutationState.create = { mutate: trpcMock.mutateFns.create, isPending: false }
  trpcMock.mutationState.update = { mutate: trpcMock.mutateFns.update, isPending: false }
  trpcMock.mutationState.delete = { mutate: trpcMock.mutateFns.delete, isPending: false }
  sideMock.side = 'left'
})

describe('useSchedules', () => {
  it('returns empty phases when no data', () => {
    const { result } = renderHook(() => useSchedules('monday'))
    expect(result.current.phases).toEqual([])
    expect(result.current.scheduleData).toBeUndefined()
  })

  it('derives phases from temperature schedules sorted by time', () => {
    trpcMock.queryState.data = {
      temperature: [
        { id: 2, time: '07:00', temperature: 68, enabled: true },
        { id: 1, time: '22:00', temperature: 60, enabled: true },
        { id: 3, time: '13:00', temperature: 75, enabled: false },
      ],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedules('monday'))
    const phases = result.current.phases
    expect(phases).toHaveLength(3)
    expect(phases[0]).toMatchObject({ id: 2, time: '07:00', icon: 'sunrise', name: 'Morning' })
    expect(phases[1]).toMatchObject({ id: 3, time: '13:00', icon: 'sun', name: 'Daytime' })
    expect(phases[2]).toMatchObject({ id: 1, time: '22:00', icon: 'moon', name: 'Evening' })
  })

  it('labels every time-of-day boundary', () => {
    trpcMock.queryState.data = {
      temperature: [
        { id: 1, time: '00:00', temperature: 60, enabled: true },
        { id: 2, time: '01:00', temperature: 60, enabled: true },
        { id: 3, time: '02:00', temperature: 60, enabled: true },
        { id: 4, time: '05:00', temperature: 60, enabled: true },
        { id: 5, time: '08:00', temperature: 60, enabled: true },
        { id: 6, time: '17:00', temperature: 60, enabled: true },
        { id: 7, time: '18:00', temperature: 60, enabled: true },
        { id: 8, time: '21:00', temperature: 60, enabled: true },
      ],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedules('monday'))
    expect(result.current.phases.map(({ time, name, icon }) => ({ time, name, icon }))).toEqual([
      { time: '00:00', name: 'Evening', icon: 'moon' },
      { time: '01:00', name: 'Overnight', icon: 'moon' },
      { time: '02:00', name: 'Overnight', icon: 'moon' },
      { time: '05:00', name: 'Morning', icon: 'sunrise' },
      { time: '08:00', name: 'Daytime', icon: 'sun' },
      { time: '17:00', name: 'Evening', icon: 'sun' },
      { time: '18:00', name: 'Evening', icon: 'sun' },
      { time: '21:00', name: 'Evening', icon: 'moon' },
    ])
  })

  it('recomputes query keys and invalidation keys after side and day changes', () => {
    const { rerender } = renderHook(
      ({ day }) => useSchedules(day),
      { initialProps: { day: 'monday' as const } },
    )
    sideMock.side = 'right'
    rerender({ day: 'tuesday' as any })

    expect(trpcMock.trpc.schedules.getByDay.useQuery).toHaveBeenLastCalledWith({
      side: 'right',
      dayOfWeek: 'tuesday',
    })
    trpcMock.captured.create.onSettled()
    expect(trpcMock.utils.schedules.getByDay.invalidate).toHaveBeenLastCalledWith({
      side: 'right',
      dayOfWeek: 'tuesday',
    })
    expect(trpcMock.utils.schedules.getAll.invalidate).toHaveBeenLastCalledWith({ side: 'right' })
  })

  it('recomputes phases when the query data changes', () => {
    trpcMock.queryState.data = {
      temperature: [{ id: 1, time: '07:00', temperature: 68, enabled: true }],
      power: [],
      alarm: [],
    }
    const { result, rerender } = renderHook(() => useSchedules('monday'))
    expect(result.current.phases.map(p => p.id)).toEqual([1])

    trpcMock.queryState.data = {
      temperature: [{ id: 2, time: '08:00', temperature: 70, enabled: true }],
      power: [],
      alarm: [],
    }
    rerender()
    expect(result.current.phases.map(p => p.id)).toEqual([2])
  })

  it('createSetPoint forwards side, day, time and temperature to the mutation', () => {
    const { result } = renderHook(() => useSchedules('monday'))
    act(() => result.current.createSetPoint('07:00', 70))
    const create = trpcMock.captured.create
    expect(create.onMutate).toBeTypeOf('function')
    // ensure the mutate call shape is correct via the mock fn
    const mutateFn = trpcMock.mutateFns.create
    expect(mutateFn).toHaveBeenCalledWith({ side: 'left', dayOfWeek: 'monday', time: '07:00', temperature: 70, enabled: true })
  })

  it('createSetPoint uses the latest side, day, and mutation function', () => {
    const replacementMutate = vi.fn()
    const { result, rerender } = renderHook(
      ({ day }) => useSchedules(day),
      { initialProps: { day: 'monday' as const } },
    )
    sideMock.side = 'right'
    trpcMock.mutationState.create.mutate = replacementMutate
    rerender({ day: 'tuesday' as any })

    act(() => result.current.createSetPoint('09:00', 71))

    expect(replacementMutate).toHaveBeenCalledWith({
      side: 'right',
      dayOfWeek: 'tuesday',
      time: '09:00',
      temperature: 71,
      enabled: true,
    })
  })

  it('updateSetPoint passes id and updates through to the mutation', () => {
    const { result } = renderHook(() => useSchedules('monday'))
    act(() => result.current.updateSetPoint(42, { time: '08:00', temperature: 72 }))
    const mutateFn = trpcMock.mutateFns.update
    expect(mutateFn).toHaveBeenCalledWith({ id: 42, time: '08:00', temperature: 72 })
  })

  it('updateSetPoint uses a replacement mutation function after rerender', () => {
    const replacementMutate = vi.fn()
    const { result, rerender } = renderHook(() => useSchedules('monday'))
    trpcMock.mutationState.update.mutate = replacementMutate
    rerender()

    act(() => result.current.updateSetPoint(42, { enabled: false }))

    expect(replacementMutate).toHaveBeenCalledWith({ id: 42, enabled: false })
  })

  it('adjustTemperature clamps to 55..110 and updates by delta', () => {
    trpcMock.queryState.data = {
      temperature: [{ id: 1, time: '07:00', temperature: 70, enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedules('monday'))
    act(() => result.current.adjustTemperature(1, 5))
    const mutateFn = trpcMock.mutateFns.update
    expect(mutateFn).toHaveBeenCalledWith({ id: 1, temperature: 75 })
  })

  it('adjustTemperature is a no-op for unknown phase ids', () => {
    trpcMock.queryState.data = { temperature: [], power: [], alarm: [] }
    const { result } = renderHook(() => useSchedules('monday'))
    act(() => result.current.adjustTemperature(999, 5))
    const mutateFn = trpcMock.mutateFns.update
    expect(mutateFn).not.toHaveBeenCalled()
  })

  it('adjustTemperature selects the requested phase rather than the first phase', () => {
    trpcMock.queryState.data = {
      temperature: [
        { id: 1, time: '07:00', temperature: 60, enabled: true },
        { id: 2, time: '08:00', temperature: 80, enabled: true },
      ],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedules('monday'))
    act(() => result.current.adjustTemperature(2, 5))
    expect(trpcMock.mutateFns.update).toHaveBeenCalledWith({ id: 2, temperature: 85 })
  })

  it('adjustTemperature uses recomputed phases after rerender', () => {
    trpcMock.queryState.data = {
      temperature: [{ id: 1, time: '07:00', temperature: 60, enabled: true }],
      power: [],
      alarm: [],
    }
    const { result, rerender } = renderHook(() => useSchedules('monday'))
    trpcMock.queryState.data = {
      temperature: [{ id: 1, time: '07:00', temperature: 80, enabled: true }],
      power: [],
      alarm: [],
    }
    rerender()

    act(() => result.current.adjustTemperature(1, 5))

    expect(trpcMock.mutateFns.update).toHaveBeenCalledWith({ id: 1, temperature: 85 })
  })

  it('adjustTemperature clamps high values to 110', () => {
    trpcMock.queryState.data = {
      temperature: [{ id: 1, time: '07:00', temperature: 108, enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedules('monday'))
    act(() => result.current.adjustTemperature(1, 10))
    const mutateFn = trpcMock.mutateFns.update
    expect(mutateFn).toHaveBeenCalledWith({ id: 1, temperature: 110 })
  })

  it('deleteSetPoint forwards id', () => {
    const { result } = renderHook(() => useSchedules('monday'))
    act(() => result.current.deleteSetPoint(7))
    const mutateFn = trpcMock.mutateFns.delete
    expect(mutateFn).toHaveBeenCalledWith({ id: 7 })
  })

  it('deleteSetPoint uses a replacement mutation function after rerender', () => {
    const replacementMutate = vi.fn()
    const { result, rerender } = renderHook(() => useSchedules('monday'))
    trpcMock.mutationState.delete.mutate = replacementMutate
    rerender()

    act(() => result.current.deleteSetPoint(7))

    expect(replacementMutate).toHaveBeenCalledWith({ id: 7 })
  })

  it.each([
    ['create', true, false, false],
    ['update', false, true, false],
    ['delete', false, false, true],
  ] as const)('reports mutation state when only %s is pending', (_name, create, update, del) => {
    trpcMock.mutationState.create.isPending = create
    trpcMock.mutationState.update.isPending = update
    trpcMock.mutationState.delete.isPending = del
    const { result } = renderHook(() => useSchedules('monday'))
    expect(result.current.isMutating).toBe(true)
  })

  it('reports no mutation when every operation is idle', () => {
    const { result } = renderHook(() => useSchedules('monday'))
    expect(result.current.isMutating).toBe(false)
  })

  it('create onMutate appends an optimistic row, onSettled invalidates', async () => {
    trpcMock.cache.set('byDay', { temperature: [], power: [], alarm: [] })
    renderHook(() => useSchedules('monday'))
    const create = trpcMock.captured.create
    await create.onMutate({ side: 'left', dayOfWeek: 'monday', time: '07:00', temperature: 70 })
    const next = trpcMock.cache.get('byDay')
    expect(next.temperature).toHaveLength(1)
    expect(next.temperature[0]).toMatchObject({ side: 'left', time: '07:00', temperature: 70, enabled: true })
    expect(next.temperature[0].id).toBeLessThan(0)
    create.onSettled()
    expect(trpcMock.utils.schedules.getByDay.invalidate).toHaveBeenCalled()
    expect(trpcMock.utils.schedules.getAll.invalidate).toHaveBeenCalled()
  })

  it('create onError restores previous cache snapshot', async () => {
    const prev = { temperature: [{ id: 1, time: '07:00', temperature: 70, enabled: true }], power: [], alarm: [] }
    trpcMock.cache.set('byDay', prev)
    renderHook(() => useSchedules('monday'))
    const create = trpcMock.captured.create
    const ctx = await create.onMutate({ side: 'left', dayOfWeek: 'monday', time: '08:00', temperature: 65 })
    create.onError(new Error('boom'), {}, ctx)
    expect(trpcMock.cache.get('byDay')).toBe(prev)
  })

  it('update onMutate patches the matching row in cache', async () => {
    trpcMock.cache.set('byDay', {
      temperature: [
        { id: 1, time: '07:00', temperature: 70, enabled: true },
        { id: 2, time: '22:00', temperature: 60, enabled: true },
      ],
      power: [],
      alarm: [],
    })
    renderHook(() => useSchedules('monday'))
    const update = trpcMock.captured.update
    await update.onMutate({ id: 1, time: '08:00', temperature: 72, enabled: false })
    const next = trpcMock.cache.get('byDay')
    expect(next.temperature[0]).toMatchObject({ id: 1, time: '08:00', temperature: 72, enabled: false })
    expect(next.temperature[1]).toMatchObject({ id: 2, time: '22:00', temperature: 60 })
  })

  it('update onError restores previous cache snapshot and onSettled invalidates', async () => {
    const previous = {
      temperature: [{ id: 1, time: '07:00', temperature: 70, enabled: true }],
      power: [],
      alarm: [],
    }
    trpcMock.cache.set('byDay', previous)
    renderHook(() => useSchedules('monday'))
    const update = trpcMock.captured.update
    const context = await update.onMutate({ id: 1, temperature: 80 })
    update.onError(new Error('boom'), {}, context)
    expect(trpcMock.cache.get('byDay')).toBe(previous)

    update.onSettled()
    expect(trpcMock.utils.schedules.getByDay.invalidate).toHaveBeenCalled()
    expect(trpcMock.utils.schedules.getAll.invalidate).toHaveBeenCalled()
  })

  it('delete onMutate removes the targeted row', async () => {
    trpcMock.cache.set('byDay', {
      temperature: [
        { id: 1, time: '07:00', temperature: 70, enabled: true },
        { id: 2, time: '22:00', temperature: 60, enabled: true },
      ],
      power: [],
      alarm: [],
    })
    renderHook(() => useSchedules('monday'))
    const del = trpcMock.captured.delete
    await del.onMutate({ id: 1 })
    expect(trpcMock.cache.get('byDay').temperature).toEqual([
      expect.objectContaining({ id: 2 }),
    ])
  })

  it('delete onError restores previous cache snapshot and onSettled invalidates', async () => {
    const previous = {
      temperature: [{ id: 1, time: '07:00', temperature: 70, enabled: true }],
      power: [],
      alarm: [],
    }
    trpcMock.cache.set('byDay', previous)
    renderHook(() => useSchedules('monday'))
    const del = trpcMock.captured.delete
    const context = await del.onMutate({ id: 1 })
    del.onError(new Error('boom'), {}, context)
    expect(trpcMock.cache.get('byDay')).toBe(previous)

    del.onSettled()
    expect(trpcMock.utils.schedules.getByDay.invalidate).toHaveBeenCalled()
    expect(trpcMock.utils.schedules.getAll.invalidate).toHaveBeenCalled()
  })
})

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
  const makeMutation = (key: 'create' | 'update' | 'delete') => {
    return (opts: any) => {
      captured[key] = opts
      return {
        mutate: mutateFns[key],
        isPending: false,
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
  return { trpc, utils, cache, queryState, captured, refetch, mutateFns }
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

  it('createSetPoint forwards side, day, time and temperature to the mutation', () => {
    const { result } = renderHook(() => useSchedules('monday'))
    act(() => result.current.createSetPoint('07:00', 70))
    const create = trpcMock.captured.create
    expect(create.onMutate).toBeTypeOf('function')
    // ensure the mutate call shape is correct via the mock fn
    const mutateFn = trpcMock.mutateFns.create
    expect(mutateFn).toHaveBeenCalledWith({ side: 'left', dayOfWeek: 'monday', time: '07:00', temperature: 70, enabled: true })
  })

  it('updateSetPoint passes id and updates through to the mutation', () => {
    const { result } = renderHook(() => useSchedules('monday'))
    act(() => result.current.updateSetPoint(42, { time: '08:00', temperature: 72 }))
    const mutateFn = trpcMock.mutateFns.update
    expect(mutateFn).toHaveBeenCalledWith({ id: 42, time: '08:00', temperature: 72 })
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

  it('create onMutate appends an optimistic row, onSettled invalidates', async () => {
    trpcMock.cache.set('byDay', { temperature: [], power: [], alarm: [] })
    renderHook(() => useSchedules('monday'))
    const create = trpcMock.captured.create
    await create.onMutate({ side: 'left', dayOfWeek: 'monday', time: '07:00', temperature: 70 })
    const next = trpcMock.cache.get('byDay')
    expect(next.temperature).toHaveLength(1)
    expect(next.temperature[0]).toMatchObject({ side: 'left', time: '07:00', temperature: 70, enabled: true })
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

  it('labels evening phases between 17:00 and 21:00 as Evening/sun', () => {
    trpcMock.queryState.data = {
      temperature: [{ id: 1, time: '18:00', temperature: 65, enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedules('monday'))
    expect(result.current.phases[0]).toMatchObject({ name: 'Evening', icon: 'sun' })
  })

  it('labels overnight phases between 01:00 and 05:00 as Overnight/moon', () => {
    trpcMock.queryState.data = {
      temperature: [{ id: 1, time: '03:00', temperature: 62, enabled: true }],
      power: [],
      alarm: [],
    }
    const { result } = renderHook(() => useSchedules('monday'))
    expect(result.current.phases[0]).toMatchObject({ name: 'Overnight', icon: 'moon' })
  })

  it('update onError restores previous cache snapshot', async () => {
    const prev = {
      temperature: [{ id: 1, time: '07:00', temperature: 70, enabled: true }],
      power: [],
      alarm: [],
    }
    trpcMock.cache.set('byDay', prev)
    renderHook(() => useSchedules('monday'))
    const update = trpcMock.captured.update
    const ctx = await update.onMutate({ id: 1, time: '08:00', temperature: 75 })
    update.onError(new Error('boom'), {}, ctx)
    expect(trpcMock.cache.get('byDay')).toBe(prev)
  })

  it('update onSettled invalidates both queries', () => {
    renderHook(() => useSchedules('monday'))
    trpcMock.captured.update.onSettled()
    expect(trpcMock.utils.schedules.getByDay.invalidate).toHaveBeenCalled()
    expect(trpcMock.utils.schedules.getAll.invalidate).toHaveBeenCalled()
  })

  it('delete onError restores previous cache snapshot', async () => {
    const prev = {
      temperature: [{ id: 1, time: '07:00', temperature: 70, enabled: true }],
      power: [],
      alarm: [],
    }
    trpcMock.cache.set('byDay', prev)
    renderHook(() => useSchedules('monday'))
    const del = trpcMock.captured.delete
    const ctx = await del.onMutate({ id: 1 })
    del.onError(new Error('boom'), {}, ctx)
    expect(trpcMock.cache.get('byDay')).toBe(prev)
  })

  it('delete onSettled invalidates both queries', () => {
    renderHook(() => useSchedules('monday'))
    trpcMock.captured.delete.onSettled()
    expect(trpcMock.utils.schedules.getByDay.invalidate).toHaveBeenCalled()
    expect(trpcMock.utils.schedules.getAll.invalidate).toHaveBeenCalled()
  })
})

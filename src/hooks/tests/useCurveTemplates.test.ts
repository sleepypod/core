import { renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  save: vi.fn(),
  put: vi.fn(),
  setActive: vi.fn(),
  remove: vi.fn(),
  invalidate: {
    list: vi.fn(),
    getAll: vi.fn(),
    getByDay: vi.fn(),
    getNotes: vi.fn(),
  },
  pending: { save: false, put: false, setActive: false, delete: false },
  onSuccess: {} as Record<string, () => unknown>,
  // tRPC hands back a fresh mutateAsync on some renders; record which render's copy each call went through.
  generation: 0,
  calledGeneration: {} as Record<string, number>,
}))
vi.mock('@/src/utils/trpc', () => {
  const mutation = (key: 'save' | 'put' | 'setActive' | 'delete', fn: () => unknown) => ({
    useMutation: (opts: { onSuccess: () => unknown }) => {
      state.onSuccess[key] = opts.onSuccess
      const generation = state.generation
      const mutateAsync = (...args: unknown[]) => {
        state.calledGeneration[key] = generation
        return (fn as (...a: unknown[]) => unknown)(...args)
      }
      return { mutateAsync, isPending: state.pending[key] }
    },
  })
  return {
    trpc: {
      useUtils: () => ({
        curveTemplates: { list: { invalidate: state.invalidate.list } },
        schedules: {
          getAll: { invalidate: state.invalidate.getAll },
          getByDay: { invalidate: state.invalidate.getByDay },
          getNotes: { invalidate: state.invalidate.getNotes },
        },
      }),
      curveTemplates: {
        list: { useQuery: (_input: unknown, opts: { enabled: boolean }) => ({ data: opts.enabled ? state.data : undefined }) },
        save: mutation('save', (...args: unknown[]) => state.save(...args)),
        put: mutation('put', (...args: unknown[]) => state.put(...args)),
        setActive: mutation('setActive', (...args: unknown[]) => state.setActive(...args)),
        delete: mutation('delete', (...args: unknown[]) => state.remove(...args)),
      },
    },
  }
})

const { useCurveTemplates } = await import('@/src/hooks/useCurveTemplates')

const row = (name: string) => ({
  id: 1, name, bedtime: '22:00', wake: '07:00', points: { '22:00': 78, '07:00': 80 }, notes: '',
  endAction: 'maintain' as const, days: { left: ['monday' as const], right: [] }, active: true,
  createdAt: new Date(5), updatedAt: new Date(5),
})
const local = (name: string) => ({ name, bedtime: '23:00', wake: '06:00', points: { '23:00': 75, '06:00': 82 }, reasoning: 'r', createdAt: 1 })
const KEY = 'sleepypod_curve_templates'

beforeEach(() => {
  localStorage.clear()
  state.data = [row('On Pod')]
  state.save.mockReset().mockResolvedValue(undefined)
  state.put.mockReset().mockResolvedValue(undefined)
  state.setActive.mockReset().mockResolvedValue(undefined)
  state.remove.mockReset().mockResolvedValue(undefined)
  for (const fn of Object.values(state.invalidate)) fn.mockReset()
  state.pending = { save: false, put: false, setActive: false, delete: false }
  state.generation = 0
  state.calledGeneration = {}
})

const flush = () => act(() => new Promise(resolve => setTimeout(resolve, 0)))

describe('useCurveTemplates', () => {
  it('maps pod rows to templates and saves or deletes by name', async () => {
    const { result } = renderHook(() => useCurveTemplates(true))
    expect(result.current.templates).toEqual([{
      id: 1,
      name: 'On Pod',
      bedtime: '22:00',
      wake: '07:00',
      points: { '22:00': 78, '07:00': 80 },
      notes: '',
      endAction: 'maintain',
      days: { left: ['monday'], right: [] },
      active: true,
      createdAt: 5,
    }])
    await act(() => result.current.save({ name: 'New', bedtime: '22:00', wake: '07:00', points: { '22:00': 70 }, reasoning: 'x' }))
    expect(state.save).toHaveBeenCalledWith({ name: 'New', bedtime: '22:00', wake: '07:00', points: { '22:00': 70 }, notes: 'x' })
    await act(() => result.current.save({ name: 'Long', bedtime: '22:00', wake: '07:00', points: { '22:00': 70 }, reasoning: 'y'.repeat(1500) }))
    expect(state.save.mock.lastCall?.[0].notes).toHaveLength(1000)
    await act(() => result.current.remove('On Pod'))
    expect(state.remove).toHaveBeenCalledWith({ name: 'On Pod' })
  })

  it('puts a curve with its days and turns curves on or off by id', async () => {
    const { result } = renderHook(() => useCurveTemplates(true))
    const curve = {
      id: 1, name: 'Late', bedtime: '22:00', wake: '07:00', points: { '22:00': 70, '07:00': 80 }, notes: '',
      endAction: 'turn_off' as const, days: { left: ['monday' as const], right: [] }, active: true,
    }
    await act(() => result.current.put(curve))
    expect(state.put).toHaveBeenCalledWith(curve)
    await act(() => result.current.setActive(1, false))
    expect(state.setActive).toHaveBeenCalledWith({ id: 1, active: false })
  })

  it('refetches the library, schedules and notes after any library change', async () => {
    renderHook(() => useCurveTemplates(true))
    for (const key of ['save', 'put', 'setActive', 'delete']) {
      for (const fn of Object.values(state.invalidate)) fn.mockReset()
      await act(async () => {
        await state.onSuccess[key]()
      })
      expect(state.invalidate.list).toHaveBeenCalledTimes(1)
      expect(state.invalidate.getAll).toHaveBeenCalledTimes(1)
      expect(state.invalidate.getByDay).toHaveBeenCalledTimes(1)
      expect(state.invalidate.getNotes).toHaveBeenCalledTimes(1)
    }
  })

  it('reports saving for save or put, and changing and deleting separately', () => {
    const { result, rerender } = renderHook(() => useCurveTemplates(true))
    expect(result.current).toMatchObject({ isSaving: false, isChanging: false, isDeleting: false })
    state.pending.put = true
    rerender()
    expect(result.current.isSaving).toBe(true)
    state.pending = { save: true, put: false, setActive: true, delete: true }
    rerender()
    expect(result.current).toMatchObject({ isSaving: true, isChanging: true, isDeleting: true })
  })

  it('moves browser-only templates to the pod once and keeps any the pod rejects', async () => {
    localStorage.setItem(KEY, JSON.stringify([local('On Pod'), local('Moves'), local('Rejected')]))
    state.save.mockImplementation(async ({ name }: { name: string }) => {
      if (name === 'Rejected') throw new Error('bad')
    })
    const { rerender } = renderHook(() => useCurveTemplates(true))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY) ?? '[]').map((t: { name: string }) => t.name)).toEqual(['Rejected']))
    expect(state.save.mock.calls.map(c => c[0].name)).toEqual(['Moves', 'Rejected'])
    rerender()
    expect(state.save).toHaveBeenCalledTimes(2)
  })

  it('does not query or migrate while disabled', () => {
    localStorage.setItem(KEY, JSON.stringify([local('Moves')]))
    const { result } = renderHook(() => useCurveTemplates(false))
    expect(result.current.templates).toEqual([])
    expect(state.save).not.toHaveBeenCalled()
  })

  it('maps rows that load after the first render', () => {
    state.data = undefined
    const { result, rerender } = renderHook(() => useCurveTemplates(true))
    expect(result.current.templates).toEqual([])
    state.data = [row('Later')]
    rerender()
    expect(result.current.templates.map(t => t.name)).toEqual(['Later'])
  })

  it('calls the latest mutation after tRPC hands back a new one', async () => {
    const { result, rerender } = renderHook(() => useCurveTemplates(true))
    state.generation = 1
    rerender()
    await act(async () => {
      await result.current.save(local('New'))
      await result.current.put({ ...row('Put'), days: { left: [], right: [] } })
      await result.current.setActive(1, true)
      await result.current.remove('On Pod')
    })
    expect(state.calledGeneration).toEqual({ save: 1, put: 1, setActive: 1, delete: 1 })
  })

  it('migrates once the library loads, not only on the first render', async () => {
    localStorage.setItem(KEY, JSON.stringify([local('Moves')]))
    state.data = undefined
    const { rerender } = renderHook(() => useCurveTemplates(true))
    expect(state.save).not.toHaveBeenCalled()
    state.data = [row('On Pod')]
    rerender()
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
    expect(state.save).toHaveBeenCalledTimes(1)
    expect(state.save.mock.calls[0][0]).toMatchObject({ name: 'Moves' })
  })

  it('does not migrate again when the library refetches', async () => {
    localStorage.setItem(KEY, JSON.stringify([local('Rejected')]))
    state.save.mockRejectedValue(new Error('bad'))
    const { rerender } = renderHook(() => useCurveTemplates(true))
    await flush()
    expect(state.save).toHaveBeenCalledTimes(1)
    state.data = [row('On Pod')]
    rerender()
    await flush()
    expect(state.save).toHaveBeenCalledTimes(1)
  })

  it('leaves browser storage alone when it has nothing to move', async () => {
    localStorage.setItem(KEY, '[]')
    renderHook(() => useCurveTemplates(true))
    await flush()
    expect(localStorage.getItem(KEY)).toBe('[]')
  })

  it('matches pod names after trimming and trims long reasoning to the notes limit', async () => {
    localStorage.setItem(KEY, JSON.stringify([local('  On Pod  '), { ...local('Long'), reasoning: 'z'.repeat(1500) }]))
    renderHook(() => useCurveTemplates(true))
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
    expect(state.save).toHaveBeenCalledTimes(1)
    expect(state.save.mock.calls[0][0]).toEqual({
      name: 'Long', bedtime: '23:00', wake: '06:00', points: { '23:00': 75, '06:00': 82 }, notes: 'z'.repeat(1000),
    })
  })
})

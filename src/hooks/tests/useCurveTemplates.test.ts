import { renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  save: vi.fn(),
  remove: vi.fn(),
  invalidate: vi.fn(),
}))
vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ curveTemplates: { list: { invalidate: state.invalidate } } }),
    curveTemplates: {
      list: { useQuery: (_input: unknown, opts: { enabled: boolean }) => ({ data: opts.enabled ? state.data : undefined }) },
      save: { useMutation: () => ({ mutateAsync: state.save, isPending: false }) },
      delete: { useMutation: () => ({ mutateAsync: state.remove }) },
    },
  },
}))

const { useCurveTemplates } = await import('@/src/hooks/useCurveTemplates')

const row = (name: string) => ({
  id: 1, name, bedtime: '22:00', wake: '07:00', points: { '22:00': 78, '07:00': 80 }, notes: '',
  createdAt: new Date(5), updatedAt: new Date(5),
})
const local = (name: string) => ({ name, bedtime: '23:00', wake: '06:00', points: { '23:00': 75, '06:00': 82 }, reasoning: 'r', createdAt: 1 })
const KEY = 'sleepypod_curve_templates'

beforeEach(() => {
  localStorage.clear()
  state.data = [row('On Pod')]
  state.save.mockReset().mockResolvedValue(undefined)
  state.remove.mockReset().mockResolvedValue(undefined)
})

describe('useCurveTemplates', () => {
  it('maps pod rows to templates and saves or deletes by name', async () => {
    const { result } = renderHook(() => useCurveTemplates(true))
    expect(result.current.templates).toEqual([{ name: 'On Pod', bedtime: '22:00', wake: '07:00', points: { '22:00': 78, '07:00': 80 }, notes: '', createdAt: 5 }])
    await act(() => result.current.save({ name: 'New', bedtime: '22:00', wake: '07:00', points: { '22:00': 70 }, reasoning: 'x' }))
    expect(state.save).toHaveBeenCalledWith({ name: 'New', bedtime: '22:00', wake: '07:00', points: { '22:00': 70 }, notes: 'x' })
    await act(() => result.current.save({ name: 'Long', bedtime: '22:00', wake: '07:00', points: { '22:00': 70 }, reasoning: 'y'.repeat(1500) }))
    expect(state.save.mock.lastCall?.[0].notes).toHaveLength(1000)
    await act(() => result.current.remove('On Pod'))
    expect(state.remove).toHaveBeenCalledWith({ name: 'On Pod' })
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
})

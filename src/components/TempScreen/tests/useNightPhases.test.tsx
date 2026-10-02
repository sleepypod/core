import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleTempRow } from '../nightPhases'
import { useNightPhases } from '../useNightPhases'

interface Opts { onSettled: () => void, onError: () => void }

const m = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  error: null as { message: string } | null,
  isPending: false,
  mutate: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ schedules: { getAll: { invalidate: m.invalidate } } }),
    schedules: {
      getAll: { useQuery: () => ({ data: m.data, isLoading: m.isLoading, error: m.error }) },
      batchUpdate: { useMutation: () => ({ mutate: m.mutate, isPending: m.isPending }) },
    },
  },
}))

// Monday 2026-09-28 14:00 local — tonight is Monday's schedule.
const MON_14 = new Date(2026, 8, 28, 14, 0, 0)
const TUE_14 = new Date(2026, 8, 29, 14, 0, 0)

function curve(day: ScheduleTempRow['dayOfWeek'], idBase: number, temps = [76, 72, 74, 84]): ScheduleTempRow[] {
  const times = ['22:00', '00:00', '03:00', '06:00']
  return times.map((time, i) => ({ id: idBase + i, dayOfWeek: day, time, temperature: temps[i], enabled: true }))
}

function schedule(temperature: ScheduleTempRow[]) {
  return { temperature, power: [], alarm: [] }
}

const lastOpts = () => m.mutate.mock.calls.at(-1)?.[1] as Opts

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(m, { data: schedule(curve('monday', 1)), isLoading: false, error: null, isPending: false })
  m.mutate.mockReset()
  m.invalidate.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('useNightPhases', () => {
  it('reads tonight\'s phases and reports loading only while enabled', () => {
    m.isLoading = true
    const { result, rerender } = renderHook(({ enabled }) => useNightPhases('left', MON_14, 'F', 'degrees', enabled), { initialProps: { enabled: true } })
    expect(result.current.draft).toBe(false)
    expect(result.current.phases?.days).toEqual(['monday'])
    expect(result.current.valueF('dawn')).toBe(84)
    expect(result.current.isLoading).toBe(true)
    rerender({ enabled: false })
    expect(result.current.isLoading).toBe(false)
  })

  it('surfaces the query error', () => {
    m.error = { message: 'boom' }
    const { result } = renderHook(() => useNightPhases('left', MON_14, 'F', 'degrees', true))
    expect(result.current.error).toBe('boom')
  })

  it('batches taps into one write, then drops the optimistic value once the server agrees', () => {
    const { result, rerender } = renderHook(() => useNightPhases('left', MON_14, 'F', 'degrees', true))
    act(() => result.current.nudge('dawn', 1))
    act(() => result.current.nudge('dawn', 1))
    expect(result.current.valueF('dawn')).toBe(86)
    expect(m.mutate).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(700))
    expect(m.mutate).toHaveBeenCalledOnce()
    const { updates } = m.mutate.mock.calls[0][0]
    expect(updates.temperature).toEqual([{ id: 4, temperature: 86 }])
    act(() => lastOpts().onSettled())
    expect(m.invalidate).toHaveBeenCalledOnce()

    m.data = schedule(curve('monday', 1, [76, 72, 74, 86]))
    rerender()
    expect(result.current.valueF('dawn')).toBe(86)
    act(() => vi.advanceTimersByTime(8_000))
    expect(result.current.valueF('dawn')).toBe(86)
  })

  it('gives up on an optimistic value the server never reports', () => {
    const { result } = renderHook(() => useNightPhases('left', MON_14, 'F', 'degrees', true))
    act(() => result.current.nudge('dawn', -1))
    act(() => vi.advanceTimersByTime(700))
    act(() => lastOpts().onSettled())
    expect(result.current.valueF('dawn')).toBe(83)
    act(() => vi.advanceTimersByTime(8_000))
    expect(result.current.valueF('dawn')).toBe(84)
  })

  it('reverts on error', () => {
    const { result } = renderHook(() => useNightPhases('left', MON_14, 'F', 'degrees', true))
    act(() => result.current.nudge('dawn', 1))
    act(() => vi.advanceTimersByTime(700))
    act(() => lastOpts().onError())
    expect(result.current.valueF('dawn')).toBe(84)
  })

  it('skips the write when taps cancel out', () => {
    const { result } = renderHook(() => useNightPhases('left', MON_14, 'F', 'degrees', true))
    act(() => result.current.nudge('dawn', 1))
    act(() => result.current.nudge('dawn', -1))
    act(() => vi.advanceTimersByTime(700))
    expect(m.mutate).not.toHaveBeenCalled()
    expect(result.current.valueF('dawn')).toBe(84)
  })

  it('previews the template with no schedule tonight and writes it once for both phases', () => {
    const { result } = renderHook(() => useNightPhases('left', TUE_14, 'F', 'degrees', true))
    expect(result.current.draft).toBe(true)
    expect(result.current.phases?.days).toHaveLength(6)
    const night = result.current.valueF('night') as number
    act(() => result.current.nudge('night', -1))
    act(() => result.current.nudge('dawn', 1))
    expect(result.current.valueF('night')).toBe(night - 1)
    act(() => vi.advanceTimersByTime(700))
    expect(m.mutate).toHaveBeenCalledOnce()
    const batch = m.mutate.mock.calls[0][0]
    expect(batch.creates.temperature.length).toBeGreaterThan(0)
    expect(batch.creates.temperature.every((r: { side: string }) => r.side === 'left')).toBe(true)
  })

  it('ignores draft taps while the template write is in flight', () => {
    m.isPending = true
    const { result } = renderHook(() => useNightPhases('left', TUE_14, 'F', 'degrees', true))
    const night = result.current.valueF('night')
    act(() => result.current.nudge('night', 1))
    expect(result.current.valueF('night')).toBe(night)
    expect(result.current.saving).toBe(true)
  })

  it('has nothing to show or nudge before the schedule loads', () => {
    m.data = undefined
    const { result } = renderHook(() => useNightPhases('left', MON_14, 'F', 'degrees', true))
    expect(result.current.phases).toBeNull()
    act(() => result.current.nudge('night', 1))
    expect(result.current.valueF('night')).toBeNull()
  })
})

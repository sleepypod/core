/**
 * Tests for useScheduleActive — finds the next upcoming temperature
 * set point across the next 7 days. Reports active state and the next
 * event with formatted 12h time.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trpcMock = vi.hoisted(() => {
  const state: { data: any } = { data: undefined }
  return {
    state,
    trpc: {
      schedules: {
        getAll: { useQuery: vi.fn(() => ({ data: state.data })) },
      },
    },
  }
})

const sideMock = vi.hoisted(() => ({ side: 'left' as const }))

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))
vi.mock('../useSide', () => ({ useSide: () => ({ side: sideMock.side }) }))

import { useScheduleActive } from '../useScheduleActive'

beforeEach(() => {
  vi.useFakeTimers()
  // Wednesday, 2026-05-13 at 10:00 local time. JS Date uses local TZ so
  // construct via setHours to keep the day-of-week stable across runners.
  const d = new Date(2026, 4, 13, 10, 0, 0) // months are 0-indexed
  vi.setSystemTime(d)
})

afterEach(() => {
  vi.useRealTimers()
  trpcMock.state.data = undefined
})

describe('useScheduleActive', () => {
  it('returns inactive when no data', () => {
    const { result } = renderHook(() => useScheduleActive())
    expect(result.current).toEqual({ isActive: false, nextEvent: null, nextTime: null })
  })

  it('returns inactive when no temperature schedules are enabled', () => {
    trpcMock.state.data = {
      temperature: [
        { enabled: false, dayOfWeek: 'wednesday', time: '14:00', temperature: 70 },
      ],
    }
    const { result } = renderHook(() => useScheduleActive())
    expect(result.current.isActive).toBe(false)
  })

  it('finds the next set point later today', () => {
    trpcMock.state.data = {
      temperature: [
        { enabled: true, dayOfWeek: 'wednesday', time: '08:00', temperature: 65 }, // already passed
        { enabled: true, dayOfWeek: 'wednesday', time: '14:30', temperature: 70 }, // next
        { enabled: true, dayOfWeek: 'wednesday', time: '22:00', temperature: 60 },
      ],
    }
    const { result } = renderHook(() => useScheduleActive())
    expect(result.current.isActive).toBe(true)
    expect(result.current.nextEvent).toEqual({ time: '2:30 PM', temperature: 70 })
    expect(result.current.nextTime).toBe('2:30 PM')
  })

  it('walks forward to a later day when today has nothing left', () => {
    trpcMock.state.data = {
      temperature: [
        { enabled: true, dayOfWeek: 'wednesday', time: '08:00', temperature: 65 }, // passed
        { enabled: true, dayOfWeek: 'friday', time: '07:00', temperature: 68 },
      ],
    }
    const { result } = renderHook(() => useScheduleActive())
    expect(result.current.isActive).toBe(true)
    expect(result.current.nextEvent).toEqual({ time: '7:00 AM', temperature: 68 })
  })

  it('reports active with no nextEvent when only past points exist', () => {
    trpcMock.state.data = {
      temperature: [
        { enabled: true, dayOfWeek: 'wednesday', time: '08:00', temperature: 65 },
      ],
    }
    const { result } = renderHook(() => useScheduleActive())
    expect(result.current.isActive).toBe(true)
    expect(result.current.nextEvent).toBeNull()
  })
})

/**
 * Tests for useWeekNavigator — week-based date selection with prev/next/jump
 * controls. The hook clamps forward navigation at the current week.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWeekNavigator } from '../useWeekNavigator'

beforeEach(() => {
  vi.useFakeTimers()
  // Wednesday, 2026-05-13 at noon. Sunday-anchored week starts 2026-05-10.
  vi.setSystemTime(new Date(2026, 4, 13, 12, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useWeekNavigator', () => {
  it('initializes to the current Sunday-anchored week', () => {
    const { result } = renderHook(() => useWeekNavigator())
    const start = result.current.weekStart
    expect(start.getDay()).toBe(0) // Sunday
    expect(start.getDate()).toBe(10)
    expect(start.getMonth()).toBe(4)
    expect(result.current.weekEnd.getDate()).toBe(16)
    expect(result.current.weekEnd.getHours()).toBe(23)
    expect(result.current.isCurrentWeek).toBe(true)
  })

  it('formats a label spanning weekStart through weekEnd', () => {
    const { result } = renderHook(() => useWeekNavigator())
    expect(result.current.label).toContain('May 10')
    expect(result.current.label).toContain('May 16')
  })

  it('goToPreviousWeek shifts back 7 days and clears isCurrentWeek', () => {
    const { result } = renderHook(() => useWeekNavigator())
    act(() => result.current.goToPreviousWeek())
    expect(result.current.weekStart.getDate()).toBe(3)
    expect(result.current.isCurrentWeek).toBe(false)
  })

  it('goToNextWeek does not advance past the current week', () => {
    const { result } = renderHook(() => useWeekNavigator())
    act(() => result.current.goToNextWeek())
    expect(result.current.weekStart.getDate()).toBe(10) // unchanged
    expect(result.current.isCurrentWeek).toBe(true)
  })

  it('goToNextWeek advances when not on the current week', () => {
    const { result } = renderHook(() => useWeekNavigator())
    act(() => result.current.goToPreviousWeek()) // → May 3
    act(() => result.current.goToPreviousWeek()) // → Apr 26
    expect(result.current.weekStart.getDate()).toBe(26)
    act(() => result.current.goToNextWeek()) // → May 3
    expect(result.current.weekStart.getDate()).toBe(3)
    expect(result.current.weekStart.getMonth()).toBe(4)
  })

  it('goToCurrentWeek snaps back to the current week', () => {
    const { result } = renderHook(() => useWeekNavigator())
    act(() => result.current.goToPreviousWeek())
    expect(result.current.isCurrentWeek).toBe(false)
    act(() => result.current.goToCurrentWeek())
    expect(result.current.isCurrentWeek).toBe(true)
    expect(result.current.weekStart.getDate()).toBe(10)
  })
})

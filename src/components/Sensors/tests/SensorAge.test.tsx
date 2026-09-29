import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SensorAge } from '../SensorAge'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SensorAge', () => {
  it('hides missing readings and updates measurement age across the minute boundary', () => {
    const { container, rerender, unmount } = render(<SensorAge />)
    expect(container.textContent).toBe('')
    rerender(<SensorAge timestamp={41} />)
    expect(screen.getByText('59s ago')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText('1m ago')).toBeTruthy()
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByText('2m ago')).toBeTruthy()
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clamps clock skew to zero and immediately switches to a new measurement timestamp', () => {
    const { rerender } = render(<SensorAge timestamp={105} />)
    expect(screen.getByText('0s ago')).toBeTruthy()
    rerender(<SensorAge timestamp={95} />)
    expect(screen.getByText('5s ago')).toBeTruthy()
    rerender(<SensorAge />)
    expect(screen.queryByText(/ago/)).toBeNull()
  })
})

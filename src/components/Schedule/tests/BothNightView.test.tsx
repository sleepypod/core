import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BothNightView } from '../BothNightView'
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))
afterEach(() => vi.useRealTimers())
it('shows the end countdown while tonight is running and selects another night', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 28, 23, 0))
  const left = [{ dayOfWeek: 'monday', time: '22:00', temperature: 80, enabled: true }, { dayOfWeek: 'monday', time: '07:00', temperature: 82, enabled: true }]
  render(<BothNightView temps={{ left, right: undefined }} names={{ left: 'Alex', right: 'Sam' }} />)
  expect(screen.getByText(/ends in 8h 0m/)).toBeTruthy()
  expect(screen.getByText('No curve on Mon')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Tue' }))
  expect(screen.getByText('Tuesday night')).toBeTruthy()
  expect(screen.getAllByText('No curve on Tue')).toHaveLength(2)
})

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BothNightView, PersonCurveList } from '../BothNightView'
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))
const fmt = vi.hoisted(() => ({ value: '12h' as '12h' | '24h' }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => fmt.value }))
afterEach(() => {
  vi.useRealTimers()
  fmt.value = '12h'
})
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
it('shows each person’s sleep window in the pod’s time format', () => {
  fmt.value = '24h'
  const left = [{ dayOfWeek: 'monday', time: '23:15', temperature: 80, enabled: true }, { dayOfWeek: 'monday', time: '07:00', temperature: 82, enabled: true }]
  render(<PersonCurveList temps={{ left, right: undefined }} names={{ left: 'Alex', right: 'Sam' }} onEdit={vi.fn()} onDelete={vi.fn()} />)
  expect(screen.getByText(/23:15 → 07:00/)).toBeTruthy()
  expect(screen.queryByText(/PM/)).toBeNull()
})

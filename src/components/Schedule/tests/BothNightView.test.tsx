import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BothNightView, PersonCurveList } from '../BothNightView'
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

it('shows a maintained final temperature only for the side whose curve maintains it', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 28, 23, 0))
  const curve = (dayOfWeek: string) => [{ dayOfWeek, time: '22:00', temperature: 80, enabled: true }, { dayOfWeek, time: '07:00', temperature: 82, enabled: true }]
  render(
    <BothNightView
      temps={{ left: curve('monday'), right: curve('monday') }}
      power={{ left: [{ dayOfWeek: 'monday', endAction: 'maintain' }], right: [{ dayOfWeek: 'monday', endAction: 'turn_off' }] }}
      names={{ left: 'Alex', right: 'Sam' }}
    />,
  )
  expect(screen.getAllByText('Maintain temperature')).toHaveLength(1)
  expect(screen.getAllByText('Power off')).toHaveLength(1)
})

it('labels maintained curves in the per-person list and skips sides without curves', () => {
  const left = ['monday', 'tuesday'].flatMap(dayOfWeek => [{ dayOfWeek, time: '22:00', temperature: 80, enabled: true }, { dayOfWeek, time: '07:00', temperature: 82, enabled: true }])
  const onEdit = vi.fn()
  render(
    <PersonCurveList
      temps={{ left, right: undefined }}
      power={{ left: [{ dayOfWeek: 'monday', endAction: 'maintain' }, { dayOfWeek: 'tuesday', endAction: 'turn_off' }] }}
      names={{ left: 'Alex', right: 'Sam' }}
      onEdit={onEdit}
      onDelete={vi.fn()}
    />,
  )
  expect(screen.getAllByRole('button', { name: /^Edit Alex/ })).toHaveLength(2)
  expect(screen.queryByRole('button', { name: /^Edit Sam/ })).toBeNull()
  expect(screen.getAllByText(/Maintains final temperature/)).toHaveLength(1)
  fireEvent.click(screen.getAllByRole('button', { name: /^Edit Alex/ })[0])
  expect(onEdit).toHaveBeenCalledWith('left', expect.objectContaining({ days: ['monday'], endAction: 'maintain' }))
})

import { fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { TimeInput } from '../TimeInput'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import { TimeFormatProvider } from '@/src/providers/TimeFormatProvider'
import { hypnoTicks } from '@/src/components/Sleep/sleepData'
import { formatHourLabel } from '../CurveChart'

const m = vi.hoisted(() => ({ data: undefined as undefined | { device: { timeFormat: string } } }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: () => ({ data: m.data }) } } } }))

function Display() {
  const { formatTime, formatClock, timeFormat } = useTimeFormatter()
  return (
    <div>
      <output aria-label="Alarm">{formatTime('23:30')}</output>
      <output aria-label="Midnight">{formatClock(new Date(2026, 9, 6, 0, 0))}</output>
      <output aria-label="Chart">{formatHourLabel(24 * 60, timeFormat)}</output>
      <output aria-label="Sleep ticks">{hypnoTicks(new Date(2026, 9, 6, 23, 0).getTime(), new Date(2026, 9, 7, 7, 0).getTime(), 2, timeFormat).map(t => t.label).join(' / ')}</output>
    </div>
  )
}
const tree = <TimeFormatProvider><Display /></TimeFormatProvider>
beforeEach(() => {
  m.data = undefined
})

it('follows the device setting and updates labels and chart ticks when it changes', () => {
  const view = render(tree)
  expect(screen.getByLabelText('Alarm').textContent).toBe('11:30 PM')
  m.data = { device: { timeFormat: '24h' } }
  view.rerender(<TimeFormatProvider><Display /></TimeFormatProvider>)
  expect(screen.getByLabelText('Alarm').textContent).toBe('23:30')
  expect(screen.getByLabelText('Midnight').textContent).toBe('00:00')
  expect(screen.getByLabelText('Chart').textContent).toBe('00:00')
  expect(screen.getByLabelText('Sleep ticks').textContent).toContain('23:00 /')
  expect(screen.getByLabelText('Sleep ticks').textContent).toContain('07:00')
})
it('defaults to 12-hour while settings load, without a provider, and for unknown values', () => {
  m.data = { device: { timeFormat: '24h' } }
  expect(renderToString(<Display />)).toContain('11:30 PM')
  m.data = { device: { timeFormat: 'bogus' } }
  render(tree)
  expect(screen.getByLabelText('Alarm').textContent).toBe('11:30 PM')
})
it('edits 24-hour times without AM/PM and emits the existing HH:mm contract', () => {
  m.data = { device: { timeFormat: '24h' } }
  const onChange = vi.fn()
  const { rerender } = render(<TimeInput label="Wake" value="23:59" onChange={onChange} />, { wrapper: TimeFormatProvider })
  const hour = screen.getByRole('combobox', { name: 'Wake hours' }) as HTMLSelectElement
  const minute = screen.getByRole('combobox', { name: 'Wake minutes' }) as HTMLSelectElement
  expect(hour.value).toBe('23')
  expect(minute.value).toBe('59')
  expect(hour.options).toHaveLength(24)
  expect(minute.options).toHaveLength(60)
  fireEvent.change(hour, { target: { value: '00' } })
  expect(onChange).toHaveBeenLastCalledWith('00:59')
  rerender(<TimeInput label="Wake" value="00:59" onChange={onChange} />)
  fireEvent.change(minute, { target: { value: '00' } })
  expect(onChange).toHaveBeenLastCalledWith('00:00')
  rerender(<TimeInput label="Wake" value="00:00" onChange={onChange} disabled />)
  expect(hour.disabled).toBe(true)
  expect(minute.disabled).toBe(true)
})

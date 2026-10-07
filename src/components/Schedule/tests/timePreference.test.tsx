import { act, fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { TimeInput } from '../TimeInput'
import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'
import { PREFS_STORAGE_KEYS, PrefsProvider, usePrefs } from '@/src/providers/PrefsProvider'
import { hypnoTicks } from '@/src/components/Sleep/sleepData'
import { formatHourLabel } from '../CurveChart'

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
function Switch() {
  const { setTimeFormat } = usePrefs()
  return <button onClick={() => setTimeFormat('24h')}>Use 24-hour</button>
}
beforeEach(() => localStorage.clear())

it('updates labels and chart ticks immediately, then persists across remounts', () => {
  const tree = (
    <PrefsProvider>
      <Switch />
      <Display />
    </PrefsProvider>
  )
  const first = render(tree)
  expect(screen.getByLabelText('Alarm').textContent).toBe('11:30 PM')
  fireEvent.click(screen.getByRole('button', { name: 'Use 24-hour' }))
  expect(screen.getByLabelText('Alarm').textContent).toBe('23:30')
  expect(screen.getByLabelText('Midnight').textContent).toBe('00:00')
  expect(screen.getByLabelText('Chart').textContent).toBe('00:00')
  expect(screen.getByLabelText('Sleep ticks').textContent).toContain('23:00 /')
  expect(screen.getByLabelText('Sleep ticks').textContent).toContain('07:00')
  expect(localStorage.getItem(PREFS_STORAGE_KEYS.timeFormat)).toBe('24h')
  first.unmount()
  render(tree)
  expect(screen.getByLabelText('Alarm').textContent).toBe('23:30')
})
it('uses a stable server default, rejects invalid storage, and reacts to another tab', () => {
  localStorage.setItem(PREFS_STORAGE_KEYS.timeFormat, '24h')
  expect(renderToString(<Display />)).toContain('11:30 PM')
  localStorage.setItem(PREFS_STORAGE_KEYS.timeFormat, 'bogus')
  render(<Display />)
  expect(screen.getByLabelText('Alarm').textContent).toBe('11:30 PM')
  act(() => {
    localStorage.setItem(PREFS_STORAGE_KEYS.timeFormat, '24h')
    window.dispatchEvent(new StorageEvent('storage'))
  })
  expect(screen.getByLabelText('Alarm').textContent).toBe('23:30')
})
it('edits 24-hour times without AM/PM and emits the existing HH:mm contract', () => {
  localStorage.setItem(PREFS_STORAGE_KEYS.timeFormat, '24h')
  const onChange = vi.fn()
  const { rerender } = render(<TimeInput label="Wake" value="23:59" onChange={onChange} />)
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

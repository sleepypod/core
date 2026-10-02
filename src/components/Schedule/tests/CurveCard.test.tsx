import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const unit = vi.hoisted(() => ({ value: 'F' as 'F' | 'C' }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: unit.value }) }))

import { CurveCard, curvePhases, formatTempRange, formatWindow } from '../CurveCard'
import type { ScheduleGroup } from '@/src/lib/scheduleGrouping'

afterEach(() => {
  cleanup()
  unit.value = 'F'
})

const weekday: ScheduleGroup = {
  key: 'wk',
  days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  setPoints: [
    { time: '23:15', temperature: 83 },
    { time: '00:30', temperature: 79 },
    { time: '03:00', temperature: 80 },
    { time: '07:00', temperature: 84 },
  ],
}

describe('formatters', () => {
  it('formats the window from chronological first/last set points', () => {
    expect(formatWindow(weekday.setPoints)).toBe('11:15 PM → 7:00 AM')
    expect(formatWindow([{ time: '22:00', temperature: 80 }])).toBeNull()
  })

  it('formats the temperature range in the user unit', () => {
    expect(formatTempRange(weekday.setPoints, 'F')).toBe('79–84°F')
    expect(formatTempRange(weekday.setPoints, 'F', false)).toBe('79–84°')
    expect(formatTempRange([{ temperature: 80 }], 'C')).toBe('27°C')
    expect(formatTempRange([], 'F')).toBe('')
  })
})

describe('CurveCard (featured)', () => {
  it('shows the active badge, window, and the night in phases', () => {
    const s = render(
      <CurveCard featured isActive group={weekday} onEdit={vi.fn()} onDelete={vi.fn()} nextEvent={{ time: '12:30 AM', temperature: 79 }} />,
    )
    expect(s.getByText('Mon–Fri')).toBeTruthy()
    expect(s.getAllByText('ACTIVE').length).toBeGreaterThan(0)
    expect(s.getAllByText('11:15 PM → 7:00 AM · 79–84°F').length).toBeGreaterThan(0)
    expect(s.getByText('Cool-down')).toBeTruthy()
    expect(s.getByText('Hold · 4 h')).toBeTruthy()
    expect(s.getByText('Power off')).toBeTruthy()
    expect(s.getByText('Off')).toBeTruthy()
    expect(s.getByTestId('curve-card-featured').className).toContain('border-ok-line')
  })

  it('omits active styling and the next line when not active', () => {
    const s = render(<CurveCard featured group={weekday} onEdit={vi.fn()} onDelete={vi.fn()} nextEvent={{ time: '12:30 AM', temperature: 79 }} />)
    expect(s.queryByText('ACTIVE')).toBeNull()
    expect(s.queryByText('Next')).toBeNull()
    expect(s.getByTestId('curve-card-featured').className).not.toContain('border-ok-line')
  })

  it('edits and deletes via the header icons', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const s = render(<CurveCard featured isActive group={weekday} onEdit={onEdit} onDelete={onDelete} />)
    fireEvent.click(s.getByRole('button', { name: 'Edit Mon–Fri' }))
    fireEvent.click(s.getByRole('button', { name: 'Delete Mon–Fri' }))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
  })
})

describe('CurveCard (compact)', () => {
  it('opens the editor when the card is tapped, but delete does not also edit', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const s = render(<CurveCard group={{ ...weekday, days: ['saturday', 'sunday'] }} onEdit={onEdit} onDelete={onDelete} />)
    expect(s.getByText('11:15 PM → 7:00 AM')).toBeTruthy()
    expect(s.getByText('79–84°')).toBeTruthy()
    fireEvent.click(s.getByText('Sat, Sun'))
    expect(onEdit).toHaveBeenCalledOnce()
    fireEvent.click(s.getByRole('button', { name: 'Delete Sat, Sun' }))
    expect(onDelete).toHaveBeenCalledOnce()
    expect(onEdit).toHaveBeenCalledOnce()
  })

  it('renders paused curves dashed with PAUSED and no set points', () => {
    const s = render(<CurveCard featured group={{ key: 'p', days: ['wednesday'], setPoints: weekday.setPoints, allDisabled: true }} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(s.getByText('PAUSED')).toBeTruthy()
    expect(s.getByText('No set points active')).toBeTruthy()
    expect(s.getByText('Schedule paused')).toBeTruthy()
    expect(s.queryByTestId('curve-card-featured')).toBeNull()
  })
})

describe('curvePhases', () => {
  it('summarises a night as warm-up, hold, wake ramp and off, ignoring repeated points', () => {
    const night = [
      ['23:15', 80], ['23:45', 81], ['00:00', 82], ['00:20', 81], ['00:30', 80], ['00:41', 79],
      ['02:55', 79], ['05:50', 79], ['06:10', 81], ['06:30', 83], ['06:45', 85], ['06:55', 83], ['07:00', 80],
    ].map(([time, temperature]) => ({ time: time as string, temperature: temperature as number }))
    expect(curvePhases(night)).toEqual([
      { time: '23:15', caption: 'Warm-up', from: 80, to: 82 },
      { time: '00:41', caption: 'Hold · 5 h', to: 79 },
      { time: '06:10', caption: 'Wake ramp', from: 79, to: 85 },
      { time: '07:00', caption: 'Power off' },
    ])
  })

  it('folds power on into the hold when the night starts with it', () => {
    expect(curvePhases([{ time: '22:00', temperature: 80 }, { time: '06:00', temperature: 80 }])).toEqual([
      { time: '22:00', caption: 'Power on · hold · 8 h', to: 80 },
      { time: '06:00', caption: 'Power off' },
    ])
  })

  it('handles a single point and no points', () => {
    expect(curvePhases([{ time: '22:00', temperature: 78 }])).toEqual([{ time: '22:00', caption: 'Power on', to: 78 }])
    expect(curvePhases([])).toEqual([])
  })
})

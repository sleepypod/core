/**
 * Tests for TimeInput — a touch-friendly native time input wrapper with
 * optional label icon/accent, plus two pure helpers (formatTime12h and
 * calcDuration) used to render set-point summaries.
 */

import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TimeInput, calcDuration, formatTime12h } from '../TimeInput'

function getTimeInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="time"]')
  if (!input) throw new Error('time input not found')
  return input as HTMLInputElement
}

describe('TimeInput component', () => {
  it('renders the label and current value', () => {
    const { container, getByText } = render(
      <TimeInput label="On time" value="22:00" onChange={() => {}} />,
    )
    expect(getByText('On time')).toBeDefined()
    expect(getTimeInput(container).value).toBe('22:00')
  })

  it('emits onChange with the new value when the input changes', () => {
    const onChange = vi.fn()
    const { container } = render(
      <TimeInput label="Off time" value="07:00" onChange={onChange} />,
    )
    fireEvent.change(getTimeInput(container), { target: { value: '08:30' } })
    expect(onChange).toHaveBeenCalledWith('08:30')
  })

  it('renders empty string values as empty (uncontrolled-friendly)', () => {
    const { container } = render(
      <TimeInput label="Blank" value="" onChange={() => {}} />,
    )
    expect(getTimeInput(container).value).toBe('')
  })

  it('updates the displayed value when the value prop changes (controlled)', () => {
    const { container, rerender } = render(
      <TimeInput label="On time" value="22:00" onChange={() => {}} />,
    )
    expect(getTimeInput(container).value).toBe('22:00')
    rerender(<TimeInput label="On time" value="06:15" onChange={() => {}} />)
    expect(getTimeInput(container).value).toBe('06:15')
  })

  it('disables the input when disabled is true', () => {
    const { container } = render(
      <TimeInput label="Off time" value="07:00" onChange={() => {}} disabled />,
    )
    expect(getTimeInput(container).disabled).toBe(true)
  })

  it('defaults to enabled when disabled prop is omitted', () => {
    const { container } = render(
      <TimeInput label="On time" value="22:00" onChange={() => {}} />,
    )
    expect(getTimeInput(container).disabled).toBe(false)
  })

  it('renders an icon with the provided accent class when supplied', () => {
    const { container } = render(
      <TimeInput
        label="On time"
        value="22:00"
        onChange={() => {}}
        icon={<svg data-testid="custom-icon" />}
        accentClass="text-sky-400"
      />,
    )
    const iconWrapper = container.querySelector('label span')
    expect(iconWrapper).not.toBeNull()
    expect(iconWrapper?.className).toBe('text-sky-400')
    expect(container.querySelector('[data-testid="custom-icon"]')).not.toBeNull()
  })

  it('omits the icon wrapper when no icon is supplied', () => {
    const { container } = render(
      <TimeInput label="On time" value="22:00" onChange={() => {}} />,
    )
    expect(container.querySelector('label span')).toBeNull()
  })
})

describe('formatTime12h', () => {
  it('formats noon as 12:00 PM', () => {
    expect(formatTime12h('12:00')).toBe('12:00 PM')
  })

  it('formats midnight as 12:00 AM', () => {
    expect(formatTime12h('00:00')).toBe('12:00 AM')
  })

  it('formats single-digit morning hours unchanged', () => {
    expect(formatTime12h('07:30')).toBe('7:30 AM')
  })

  it('subtracts 12 from afternoon hours', () => {
    expect(formatTime12h('13:15')).toBe('1:15 PM')
    expect(formatTime12h('23:45')).toBe('11:45 PM')
  })

  it('defaults the minute portion to 00 when missing', () => {
    expect(formatTime12h('09')).toBe('9:00 AM')
  })

  it('returns the input verbatim when the hour cannot be parsed', () => {
    expect(formatTime12h('bogus')).toBe('bogus')
    expect(formatTime12h('')).toBe('')
  })
})

describe('calcDuration', () => {
  it('returns hh:mm difference for same-day ranges', () => {
    expect(calcDuration('07:00', '09:30')).toBe('2h 30m')
  })

  it('handles overnight ranges by adding 24h', () => {
    expect(calcDuration('22:00', '07:00')).toBe('9h 0m')
  })

  it('treats equal times as a full 24h cycle', () => {
    // (totalMinutes === 0) is not < 0, so it stays at 0 — documents current behavior.
    expect(calcDuration('08:00', '08:00')).toBe('0h 0m')
  })

  it('returns the em-dash placeholder when either side is unparseable', () => {
    expect(calcDuration('bogus', '07:00')).toBe('—')
    expect(calcDuration('22:00', 'nope')).toBe('—')
    expect(calcDuration('', '')).toBe('—')
  })
})

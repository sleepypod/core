import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatOffset, TempControl } from '../TempControl'

afterEach(() => vi.restoreAllMocks())

describe('formatOffset', () => {
  it.each([
    [80, '0'],
    [83, '+3'],
    [76, '−4'],
    [55, '−25'],
    [110, '+30'],
    [75.6, '−4'],
  ])('%s°F → %s', (f, out) => {
    expect(formatOffset(f)).toBe(out)
  })
})

describe('TempControl display', () => {
  it('shows degrees with the change from the bed by default', () => {
    render(<TempControl targetF={76} bedF={80} />)
    expect(screen.getByTestId('temp-numeral').textContent).toBe('76°')
    expect(screen.getByText('−4 · bed 80°F')).toBeTruthy()
  })

  it('shows the offset from 80°F with degrees underneath in offset mode', () => {
    render(<TempControl display="offset" targetF={76} bedF={82} />)
    expect(screen.getByTestId('temp-numeral').textContent).toBe('−4')
    expect(screen.getByText('76°F · bed 82°F')).toBeTruthy()
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('−4 (76°F), cooling')
  })

  it('labels the slider scale in offsets', () => {
    render(<TempControl variant="slider" display="offset" targetF={84} bedF={null} />)
    expect(screen.getByTestId('temp-numeral').textContent).toBe('+4')
    for (const mark of ['+30', '0', '−25']) expect(screen.getByText(mark)).toBeTruthy()
    expect(screen.getByText('84°F · bed —')).toBeTruthy()
  })

  it('shows Celsius underneath while the offset stays in °F steps', () => {
    render(<TempControl display="offset" targetF={76} bedF={null} unit="C" />)
    expect(screen.getByTestId('temp-numeral').textContent).toBe('−4')
    expect(screen.getByTestId('temp-numeral').nextElementSibling?.textContent).toMatch(/^2\d°C · bed —$/)
  })
})

it.each(['dial', 'slider'] as const)('adjusts %s by keyboard with bounds and ignores disabled interaction', (variant) => {
  const onChange = vi.fn(), onCommit = vi.fn()
  const { rerender } = render(<TempControl variant={variant} targetF={80} onChange={onChange} onCommit={onCommit} />)
  const control = screen.getByRole('slider')
  for (const key of ['ArrowUp', 'ArrowRight']) {
    fireEvent.keyDown(control, { key })
    expect(onCommit).toHaveBeenLastCalledWith(81)
  }
  for (const key of ['ArrowDown', 'ArrowLeft']) {
    fireEvent.keyDown(control, { key })
    expect(onChange).toHaveBeenLastCalledWith(79)
  }
  fireEvent.keyDown(control, { key: 'Enter' })
  expect(onCommit).toHaveBeenCalledTimes(4)
  rerender(<TempControl variant={variant} targetF={110} onCommit={onCommit} />)
  fireEvent.keyDown(control, { key: 'ArrowUp' })
  expect(onCommit).toHaveBeenLastCalledWith(110)
  rerender(<TempControl variant={variant} targetF={55} onCommit={onCommit} />)
  fireEvent.keyDown(control, { key: 'ArrowDown' })
  expect(onCommit).toHaveBeenLastCalledWith(55)
  rerender(<TempControl variant={variant} targetF={80} power={false} onCommit={onCommit} />)
  fireEvent.keyDown(control, { key: 'ArrowUp' })
  fireEvent.pointerDown(control)
  expect(onCommit).toHaveBeenCalledTimes(6)
})

it.each(['dial', 'slider'] as const)('drags and commits the %s, clamping at its ends', (variant) => {
  const onChange = vi.fn(), onCommit = vi.fn()
  render(<TempControl variant={variant} targetF={80} onChange={onChange} onCommit={onCommit} />)
  const control = screen.getByRole('slider')
  Object.defineProperty(control, 'setPointerCapture', { value: vi.fn() })
  vi.spyOn(control, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 280, height: 250, right: 280, bottom: 250, toJSON: () => ({}) })
  const pointer = (type: string, x: number, y: number) => fireEvent(control, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
  pointer('pointermove', 280, 0)
  expect(onChange).not.toHaveBeenCalled()
  pointer('pointerdown', 280, 0)
  pointer('pointermove', 140, 280)
  pointer('pointermove', 130, 280)
  pointer('pointerup', 130, 280)
  expect(onCommit).toHaveBeenCalledOnce()
  expect(onCommit).toHaveBeenLastCalledWith(55)
  pointer('pointerdown', 150, 280)
  pointer('pointercancel', 150, 280)
  expect(onCommit).toHaveBeenCalledTimes(2)
  expect(onCommit).toHaveBeenLastCalledWith(variant === 'dial' ? 110 : 55)
})

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TemperatureDial } from '../TemperatureDial'

// JSDOM has no layout or pointer capture. Keep React event handling real while
// supplying a scaled, offset SVG viewport, as a browser would.
function setup(props: Partial<React.ComponentProps<typeof TemperatureDial>> = {}) {
  const onTemperatureChange = vi.fn()
  const onTemperatureCommit = vi.fn()
  const view = render(<TemperatureDial currentTempF={75} targetTempF={75} isOn onTemperatureChange={onTemperatureChange} onTemperatureCommit={onTemperatureCommit} {...props} />)
  const dial = screen.getByRole('slider')
  const [, , width, height] = (dial.getAttribute('viewBox') ?? '').split(' ').map(Number)
  vi.spyOn(dial, 'getBoundingClientRect').mockReturnValue({
    left: 40, top: 20, width: width / 2, height: height / 2,
    right: 40 + width / 2, bottom: 20 + height / 2, x: 40, y: 20, toJSON: () => ({}),
  })
  Object.assign(dial, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() })
  const at = (x: number, y: number) => ({ clientX: 40 + x / 2, clientY: 20 + y / 2, pointerId: 1 })
  return { ...view, dial, at, onTemperatureChange, onTemperatureCommit }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TemperatureDial', () => {
  it.each([
    ['ArrowUp', 75, 'F', 76], ['ArrowRight', 75, 'F', 76],
    ['ArrowDown', 75, 'F', 74], ['ArrowLeft', 75, 'F', 74],
    ['ArrowUp', 110, 'F', 110], ['ArrowDown', 55, 'F', 55],
    ['ArrowUp', 68, 'C', 70], ['ArrowDown', 68, 'C', 66],
    ['ArrowUp', 110, 'C', 110], ['ArrowDown', 55, 'C', 55],
  ] as const)('%s at %i°F displayed in %s commits %i°F', (key, targetTempF, unit, expected) => {
    const { dial, onTemperatureChange, onTemperatureCommit } = setup({ targetTempF, unit })
    fireEvent.keyDown(dial, { key })
    expect(onTemperatureChange).toHaveBeenCalledExactlyOnceWith(expected)
    expect(onTemperatureCommit).toHaveBeenCalledExactlyOnceWith(expected)
  })

  it('exposes Fahrenheit bounds and a Celsius accessible value', () => {
    const { dial } = setup({ targetTempF: 68, unit: 'C' })
    expect(dial.getAttribute('aria-valuemin')).toBe('55')
    expect(dial.getAttribute('aria-valuemax')).toBe('110')
    expect(dial.getAttribute('aria-valuenow')).toBe('68')
    expect(dial.getAttribute('aria-valuetext')).toBe('20°C')
    expect(dial.getAttribute('tabindex')).toBe('0')
  })

  it('ignores unrelated keys, pointer moves, and releases before a drag', () => {
    const { dial, at, onTemperatureChange, onTemperatureCommit } = setup()
    fireEvent.keyDown(dial, { key: 'Enter' })
    fireEvent.pointerMove(dial, at(302, 162))
    fireEvent.pointerUp(dial, at(302, 162))
    expect(onTemperatureChange).not.toHaveBeenCalled()
    expect(onTemperatureCommit).not.toHaveBeenCalled()
  })

  it('previews drag changes once per temperature and commits only on release', () => {
    const { dial, at, onTemperatureChange, onTemperatureCommit } = setup()
    fireEvent.pointerDown(dial, at(162, 22)) // top of dial = midpoint, rounded to 83°F
    expect(onTemperatureChange).toHaveBeenLastCalledWith(83)
    expect(onTemperatureCommit).not.toHaveBeenCalled()
    fireEvent.pointerMove(dial, at(302, 162)) // right of dial = 101°F
    fireEvent.pointerMove(dial, at(302, 162))
    expect(onTemperatureChange.mock.calls).toEqual([[83], [101]])
    expect(onTemperatureCommit).not.toHaveBeenCalled()
    fireEvent.pointerUp(dial, at(302, 162))
    expect(onTemperatureCommit).toHaveBeenCalledExactlyOnceWith(101)
    fireEvent.pointerMove(dial, at(22, 162))
    fireEvent.pointerUp(dial, at(22, 162))
    expect(onTemperatureChange).toHaveBeenCalledTimes(2)
    expect(onTemperatureCommit).toHaveBeenCalledTimes(1)
  })

  it('ignores the bottom arc gap and commits the last valid preview on cancellation', () => {
    const { dial, at, onTemperatureChange, onTemperatureCommit } = setup()
    fireEvent.pointerDown(dial, at(162, 302))
    expect(onTemperatureChange).not.toHaveBeenCalled()
    fireEvent.pointerMove(dial, at(22, 162))
    expect(onTemperatureChange).toHaveBeenCalledExactlyOnceWith(64)
    fireEvent.pointerMove(dial, at(162, 302))
    fireEvent.pointerCancel(dial, at(162, 302))
    expect(onTemperatureCommit).toHaveBeenCalledExactlyOnceWith(64)
  })

  it('keeps all interactions inactive when power is off', () => {
    const { dial, at, onTemperatureChange, onTemperatureCommit } = setup({ isOn: false })
    expect(dial.getAttribute('tabindex')).toBe('-1')
    fireEvent.keyDown(dial, { key: 'ArrowUp' })
    fireEvent.pointerDown(dial, at(162, 22))
    fireEvent.pointerMove(dial, at(302, 162))
    fireEvent.pointerUp(dial, at(302, 162))
    expect(onTemperatureChange).not.toHaveBeenCalled()
    expect(onTemperatureCommit).not.toHaveBeenCalled()
    expect(screen.queryByText('NOW')).toBeNull()
  })

  it.each([[70, 'WARMING'], [80, 'COOLING']] as const)('shows the direction from %i°F', (currentTempF, label) => {
    setup({ currentTempF })
    expect(screen.getByText(label)).toBeTruthy()
  })

  it('shows no direction at the target and supports preview-only consumers', () => {
    const { dial, at, onTemperatureChange } = setup({ onTemperatureCommit: undefined })
    expect(screen.queryByText('WARMING')).toBeNull()
    expect(screen.queryByText('COOLING')).toBeNull()
    fireEvent.keyDown(dial, { key: 'ArrowUp' })
    fireEvent.pointerDown(dial, at(162, 22))
    fireEvent.pointerUp(dial, at(162, 22))
    expect(onTemperatureChange.mock.calls).toEqual([[76], [83]])
  })
})

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { assert, afterEach, describe, expect, it, vi } from 'vitest'
import { buildTimeline, chartDomain, CurveChart, dropHolds, formatHourLabel, gridTemps, MiniCurve, minutesToTime } from '../CurveChart'

vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F' }) }))

afterEach(cleanup)

const OVERNIGHT = [
  { time: '07:00', temperature: 84 },
  { time: '23:15', temperature: 83 },
  { time: '00:30', temperature: 79 },
  { time: '03:00', temperature: 80 },
]

describe('buildTimeline', () => {
  it('shifts after-midnight points by 24h for overnight schedules and sorts them', () => {
    const tl = buildTimeline(OVERNIGHT)
    expect(tl.map(p => p.item.time)).toEqual(['23:15', '00:30', '03:00', '07:00'])
    expect(tl.map(p => p.minutes)).toEqual([23 * 60 + 15, 24 * 60 + 30, 27 * 60, 31 * 60])
  })

  it('keeps daytime schedules on the clock', () => {
    const tl = buildTimeline([{ time: '14:00', temperature: 70 }, { time: '09:00', temperature: 72 }])
    expect(tl.map(p => p.minutes)).toEqual([9 * 60, 14 * 60])
  })
})

describe('chartDomain', () => {
  it('pads the window and aligns it to a 2h step for a normal night', () => {
    const d = chartDomain(buildTimeline(OVERNIGHT))
    expect(d.step).toBe(120)
    expect(d.start).toBe(22 * 60)
    expect(d.end).toBe(32 * 60)
  })

  it('uses wider steps for long spans', () => {
    expect(chartDomain([{ minutes: 0, temperature: 80 }, { minutes: 15 * 60, temperature: 80 }]).step).toBe(180)
    expect(chartDomain([{ minutes: 0, temperature: 80 }, { minutes: 20 * 60, temperature: 80 }]).step).toBe(240)
  })

  it('fits the curve to even degrees so the peak is always inside the top line', () => {
    expect(chartDomain([{ minutes: 0, temperature: 79 }, { minutes: 60, temperature: 85 }])).toMatchObject({ lo: 78, hi: 86 })
    expect(chartDomain([{ minutes: 0, temperature: 60 }, { minutes: 60, temperature: 100 }])).toMatchObject({ lo: 58, hi: 102 })
  })

  it('keeps at least 8° of height and a wider pad for the editor', () => {
    expect(chartDomain([{ minutes: 0, temperature: 80 }])).toMatchObject({ lo: 76, hi: 84 })
    expect(chartDomain([{ minutes: 0, temperature: 80 }, { minutes: 60, temperature: 84 }], 4)).toMatchObject({ lo: 76, hi: 88 })
  })
})

describe('gridTemps', () => {
  it('steps by 2° on normal curves and coarser on wide ones', () => {
    expect(gridTemps(78, 86)).toEqual([86, 84, 82, 80, 78])
    expect(gridTemps(58, 102)).toEqual([100, 90, 80, 70, 60])
  })
})

describe('dropHolds', () => {
  it('removes points that repeat the previous temperature but keeps power on/off', () => {
    const pts = [80, 79, 79, 79, 85, 80, 80].map(temperature => ({ temperature }))
    expect(dropHolds(pts).map(p => p.temperature)).toEqual([80, 79, 85, 80, 80])
  })

  it('keeps at least two steps for a single point', () => {
    const d = chartDomain([{ minutes: 22 * 60, temperature: 80 }])
    expect(d.end - d.start).toBeGreaterThanOrEqual(2 * d.step)
  })
})

describe('time labels', () => {
  it('formats hour ticks across midnight', () => {
    expect(formatHourLabel(22 * 60)).toBe('10 PM')
    expect(formatHourLabel(24 * 60)).toBe('12 AM')
    expect(formatHourLabel(12 * 60)).toBe('12 PM')
    expect(formatHourLabel(30 * 60)).toBe('6 AM')
    expect(formatHourLabel(-120)).toBe('10 PM')
  })

  it('wraps minutes back into HH:MM', () => {
    expect(minutesToTime(24 * 60 + 30)).toBe('00:30')
    expect(minutesToTime(-15)).toBe('23:45')
    expect(minutesToTime(7 * 60 + 5)).toBe('07:05')
  })
})

describe('CurveChart', () => {
  it('draws a dot per set point with the last one hollow (power off) and the axis labels', () => {
    const { container, getByText } = render(<CurveChart setPoints={OVERNIGHT} />)
    const circles = container.querySelectorAll('circle')
    expect(circles).toHaveLength(4)
    expect(circles[3].getAttribute('fill')).toBe('var(--surface-card)')
    expect(circles[0].getAttribute('fill')).toBe('var(--accent-warm)')
    expect(circles[1].getAttribute('fill')).toBe('var(--accent-cool)')
    expect(circles[2].getAttribute('fill')).toBe('var(--accent-neutral)')
    expect(getByText('10 PM')).toBeTruthy()
    expect(getByText('8 AM')).toBeTruthy()
    expect(getByText('84°')).toBeTruthy()
    // Not interactive without onChangePoint
    expect(container.querySelector('[role="slider"]')).toBeNull()
  })

  it('draws dots only where the temperature changes, but every point in the editor', () => {
    const pts = [
      { time: '23:00', temperature: 80 },
      { time: '00:30', temperature: 79 },
      { time: '02:55', temperature: 79 },
      { time: '05:50', temperature: 79 },
      { time: '07:00', temperature: 80 },
    ]
    const view = render(<CurveChart setPoints={pts} />)
    expect(view.container.querySelectorAll('circle')).toHaveLength(3)
    view.unmount()
    const edit = render(<CurveChart setPoints={pts} onChangePoint={vi.fn()} />)
    expect(edit.container.querySelectorAll('circle')).toHaveLength(5)
  })

  it('does not mark a lone point as off', () => {
    const { container } = render(<CurveChart setPoints={[{ time: '22:00', temperature: 70 }]} />)
    expect(container.querySelector('circle')?.getAttribute('fill')).toBe('var(--accent-cool)')
  })

  it('moves a point with the arrow keys, snapping time to 15 min and clamping temperature', () => {
    const onChange = vi.fn()
    const pts = [{ id: 1, time: '23:15', temperature: 110 }, { id: 2, time: '07:00', temperature: 80 }]
    const { getAllByRole } = render(<CurveChart setPoints={pts} onChangePoint={onChange} getKey={p => p.id} />)
    const [first] = getAllByRole('slider')
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith(pts[0], { time: '23:15', temperature: 110 })
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith(pts[0], { time: '23:15', temperature: 109 })
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith(pts[0], { time: '23:30', temperature: 110 })
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith(pts[0], { time: '23:00', temperature: 110 })
    fireEvent.keyDown(first, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('crosses midnight when moving an overnight point later', () => {
    const onChange = vi.fn()
    const pts = [{ id: 1, time: '23:50', temperature: 80 }, { id: 2, time: '07:00', temperature: 80 }]
    const { getAllByRole } = render(<CurveChart setPoints={pts} onChangePoint={onChange} getKey={p => p.id} />)
    fireEvent.keyDown(getAllByRole('slider')[0], { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith(pts[0], { time: '00:00', temperature: 80 })
  })
})

describe('MiniCurve', () => {
  it('renders nothing without set points and a stroked path otherwise', () => {
    const { container, rerender } = render(<MiniCurve setPoints={[]} />)
    expect(container.querySelector('svg')).toBeNull()
    rerender(<MiniCurve setPoints={OVERNIGHT} />)
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M0,/)
    expect(container.querySelectorAll('stop')).toHaveLength(4)
  })
})

describe('CurveChart axis on narrow widths', () => {
  it('drops every other hour label when they would collide', () => {
    const el = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 250 })
    try {
      const { queryByText } = render(<CurveChart setPoints={OVERNIGHT} />)
      expect(queryByText('10 PM')).toBeTruthy()
      expect(queryByText('12 AM')).toBeNull()
      expect(queryByText('2 AM')).toBeTruthy()
    }
    finally {
      if (el) Object.defineProperty(HTMLElement.prototype, 'clientWidth', el)
    }
  })
})

it('measures and drags a point within a frozen domain, then cancels and disconnects', () => {
  let resize: ResizeObserverCallback = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: ResizeObserverCallback) {
      resize = cb
    }

    observe() {}
    disconnect = disconnect
  })
  const onChange = vi.fn()
  const pts = [{ time: '22:00', temperature: 80 }, { time: '07:00', temperature: 78 }]
  const { container, getAllByRole, unmount } = render(<CurveChart setPoints={pts} onChangePoint={onChange} />)
  act(() => resize([{ contentRect: { width: 600 } }] as ResizeObserverEntry[], {} as ResizeObserver))
  const svg = container.querySelector('svg')
  assert(svg)
  Object.defineProperty(svg, 'setPointerCapture', { value: vi.fn() })
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 600, height: 120, right: 600, bottom: 120, toJSON: () => ({}) })
  fireEvent.pointerDown(getAllByRole('slider')[0], { pointerId: 1 })
  fireEvent(svg, new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 50 }))
  expect(onChange).toHaveBeenCalledWith(pts[0], { time: expect.stringMatching(/^\d\d:\d\d$/), temperature: expect.any(Number) })
  fireEvent.pointerUp(svg)
  fireEvent.pointerDown(getAllByRole('slider')[1], { pointerId: 2 })
  fireEvent.pointerCancel(svg)
  unmount()
  expect(disconnect).toHaveBeenCalledOnce()
  vi.unstubAllGlobals()
})

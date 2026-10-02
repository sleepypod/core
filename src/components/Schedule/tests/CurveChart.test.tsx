import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { assert, afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildTimeline, chartDomain, CurveChart, dropHolds, formatHourLabel, gridTemps, heldTemperature, measuredPath, MiniCurve, minutesToTime, nearestSample, stepPath,
} from '../CurveChart'

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

  it('grows the temperature range to cover measured bed temperatures', () => {
    const curve = [{ minutes: 0, temperature: 80 }, { minutes: 60, temperature: 84 }]
    expect(chartDomain(curve, 1, [77.4, 85.2])).toMatchObject({ lo: 76, hi: 88 })
    // The time window is the curve's alone.
    expect(chartDomain(curve, 1, [77.4]).start).toBe(chartDomain(curve).start)
  })
})

describe('stepPath', () => {
  it('holds each value until the next point, then jumps', () => {
    expect(stepPath([{ x: 0, y: 10 }, { x: 50, y: 10 }, { x: 100, y: 30 }])).toBe('M0,10 L50,10 L100,10 L100,30')
    expect(stepPath([])).toBe('')
  })
})

describe('measured samples', () => {
  const X = (m: number) => m
  const Y = (v: number) => 100 - v
  const samples = [
    { minutes: 0, temperature: 78 },
    { minutes: 5, temperature: 79 },
    { minutes: 60, temperature: 80 },
  ]

  it('breaks the measured line across gaps in the data', () => {
    expect(measuredPath(samples, X, Y)).toBe('M0.0,22.0L5.0,21.0M60.0,20.0')
  })

  it('reads the held set point inside the curve and nothing outside it', () => {
    const tl = buildTimeline(OVERNIGHT)
    expect(heldTemperature(tl, 23 * 60)).toBeNull()
    expect(heldTemperature(tl, 23 * 60 + 15)).toBe(83)
    expect(heldTemperature(tl, 26 * 60)).toBe(79)
    expect(heldTemperature(tl, 31 * 60)).toBe(84)
    expect(heldTemperature(tl, 31 * 60 + 1)).toBeNull()
  })

  it('finds the nearest sample only when one is close enough', () => {
    expect(nearestSample(samples, 7)).toEqual({ minutes: 5, temperature: 79 })
    expect(nearestSample(samples, 30)).toBeNull()
    expect(nearestSample([], 0)).toBeNull()
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
  it('draws the schedule as steps with on/off labels, hard colour stops and the axis, but no dots', () => {
    const { container, getByText, getByTestId } = render(<CurveChart setPoints={OVERNIGHT} />)
    expect(container.querySelectorAll('circle')).toHaveLength(0)
    expect(container.querySelector('[role="slider"]')).toBeNull()
    const line = container.querySelector('path[stroke^="url("]')
    assert(line)
    // Hold, then a vertical jump: every segment is axis-aligned.
    expect(line.getAttribute('d')?.split(' ').slice(1)).toHaveLength(6)
    const stops = [...container.querySelectorAll('stop')].map(s => [s.getAttribute('offset'), s.getAttribute('stop-color')])
    expect(stops).toHaveLength(7)
    expect(stops[0][1]).toBe('var(--accent-warm)')
    expect(stops[1][1]).toBe('var(--accent-warm)')
    expect(stops[2][1]).toBe('var(--accent-cool)')
    expect(stops[1][0]).toBe(stops[2][0])
    expect(within(getByTestId('curve-ends')).getByText('on')).toBeTruthy()
    expect(within(getByTestId('curve-ends')).getByText('off')).toBeTruthy()
    expect(getByText('10 PM')).toBeTruthy()
    expect(getByText('8 AM')).toBeTruthy()
    expect(getByText('84°')).toBeTruthy()
  })

  it('shows every point as a drag handle in the editor, the last one hollow, and no end labels', () => {
    const pts = [
      { time: '23:00', temperature: 80 },
      { time: '00:30', temperature: 79 },
      { time: '02:55', temperature: 79 },
      { time: '05:50', temperature: 79 },
      { time: '07:00', temperature: 80 },
    ]
    const { container, queryByTestId } = render(<CurveChart setPoints={pts} onChangePoint={vi.fn()} />)
    const circles = container.querySelectorAll('circle')
    expect(circles).toHaveLength(5)
    expect(circles[0].getAttribute('fill')).toBe('var(--accent-neutral)')
    expect(circles[4].getAttribute('fill')).toBe('var(--surface-card)')
    expect(container.querySelectorAll('[role="slider"]')).toHaveLength(5)
    expect(queryByTestId('curve-ends')).toBeNull()
  })

  it('does not mark a lone editor point as off', () => {
    const { container } = render(<CurveChart setPoints={[{ time: '22:00', temperature: 70 }]} onChangePoint={vi.fn()} />)
    expect(container.querySelector('circle')?.getAttribute('fill')).toBe('var(--accent-cool)')
  })

  it('draws the measured bed temperature under the steps and widens the range to fit it', () => {
    const bed = [
      { minutes: 23 * 60 + 15, temperature: 77 },
      { minutes: 23 * 60 + 20, temperature: 78.5 },
      // Outside the window: dropped, so it neither draws nor stretches the range.
      { minutes: 40 * 60, temperature: 60 },
    ]
    const { container, getByTestId, getByText } = render(<CurveChart setPoints={OVERNIGHT} bed={bed} />)
    const line = getByTestId('curve-bed')
    expect(line.getAttribute('d')).toMatch(/^M[\d.]+,[\d.]+L[\d.]+,[\d.]+$/)
    expect(getByText('76°')).toBeTruthy()
    // The bed line sits under the target line.
    const paths = [...container.querySelectorAll('path')] as Element[]
    expect(paths.indexOf(line)).toBeLessThan(paths.findIndex(p => p.getAttribute('stroke')?.startsWith('url(')))
  })

  it('reads out the target and bed under the pointer on read-only charts', () => {
    const bed = [{ minutes: 24 * 60 + 60, temperature: 78.9 }]
    const { container, getByTestId, queryByTestId } = render(<CurveChart setPoints={OVERNIGHT} bed={bed} />)
    const svg = container.querySelector('svg')
    assert(svg)
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 636, height: 220, right: 636, bottom: 220, toJSON: () => ({}) })
    // Window is 10 PM → 8 AM (600 min): 1 AM is 30% across.
    fireEvent(svg, new MouseEvent('pointermove', { bubbles: true, clientX: 636 * 0.3, clientY: 50 }))
    expect(getByTestId('curve-hover').textContent).toBe('1:00 AM · 79° / 78.9°')
    fireEvent.pointerLeave(svg)
    expect(queryByTestId('curve-hover')).toBeNull()
  })

  it('reads "—" outside the curve and omits the bed when there is none', () => {
    const { container, getByTestId } = render(<CurveChart setPoints={OVERNIGHT} />)
    const svg = container.querySelector('svg')
    assert(svg)
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 636, height: 220, right: 636, bottom: 220, toJSON: () => ({}) })
    fireEvent(svg, new MouseEvent('pointermove', { bubbles: true, clientX: 0, clientY: 50 }))
    expect(getByTestId('curve-hover').textContent).toBe('10:00 PM · —')
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

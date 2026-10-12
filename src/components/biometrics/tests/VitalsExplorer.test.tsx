import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VitalsChart } from '../VitalsChart'
import { VitalsExplorer } from '../VitalsExplorer'

vi.mock('../VitalsChart', () => ({ VitalsChart: vi.fn(() => <div data-testid="chart-content" />) }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const props = { sessions: [], stall: null, bands: { hr: null, hrv: null, br: null } }

describe('vitals navigation', () => {
  it('zooms with buttons and keyboard, bounds zoom, and resets', () => {
    render(<VitalsExplorer {...props} />)
    const region = screen.getByRole('region', { name: 'Scrollable vitals chart' })
    expect((screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByTestId('chart-content').parentElement?.style.width).toBe('200%')
    fireEvent.keyDown(region, { key: '+' })
    expect(screen.getByTestId('chart-content').parentElement?.style.width).toBe('400%')
    fireEvent.keyDown(region, { key: '-' })
    expect(screen.getByRole('status').textContent).toContain('2×')
    for (let i = 0; i < 8; i++) fireEvent.keyDown(region, { key: '+' })
    expect((screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(true)
    region.scrollLeft = 500
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }))
    expect(region.scrollLeft).toBe(0)
    expect(screen.getByTestId('chart-content').parentElement?.style.width).toBe('100%')
  })

  it('pans using navigation buttons and mouse drag', () => {
    render(<VitalsExplorer {...props} />)
    const region = screen.getByRole('region', { name: 'Scrollable vitals chart' })
    Object.defineProperty(region, 'clientWidth', { value: 600 })
    region.scrollBy = vi.fn()
    region.setPointerCapture = vi.fn()
    fireEvent.click(screen.getByRole('button', { name: 'Pan later' }))
    expect(region.scrollBy).toHaveBeenLastCalledWith({ left: 420, behavior: 'smooth' })
    fireEvent.click(screen.getByRole('button', { name: 'Pan earlier' }))
    expect(region.scrollBy).toHaveBeenLastCalledWith({ left: -420, behavior: 'smooth' })
    region.scrollLeft = 200
    fireEvent.pointerDown(region, { clientX: 200, pointerType: 'mouse', button: 0, pointerId: 1, shiftKey: true })
    fireEvent.pointerMove(region, { clientX: 100, pointerType: 'mouse', pointerId: 1 })
    expect(region.scrollLeft).toBe(300)
    fireEvent.pointerUp(region)
    fireEvent.pointerMove(region, { clientX: 50 })
    expect(region.scrollLeft).toBe(300)
  })
})

it('uses Ctrl+wheel for chart zoom without swallowing ordinary scrolling', () => {
  render(<VitalsExplorer {...props} />)
  const region = screen.getByRole('region', { name: 'Scrollable vitals chart' })
  const wheel = new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, cancelable: true, bubbles: true })
  fireEvent(region, wheel)
  expect(wheel.defaultPrevented).toBe(true)
  const width = screen.getByTestId('chart-content').parentElement?.style.width
  expect(Number.parseFloat(width ?? '0')).toBeGreaterThan(100)
  const ordinary = new WheelEvent('wheel', { deltaY: -100, cancelable: true, bubbles: true })
  fireEvent(region, ordinary)
  expect(ordinary.defaultPrevented).toBe(false)
  expect(screen.getByTestId('chart-content').parentElement?.style.width).toBe(width)
  expect(screen.getAllByRole('button').slice(0, 3).map(b => b.textContent)).toEqual(['Zoom out', 'Zoom in', 'Reset zoom'])
})

it.each(['pointerCancel', 'lostPointerCapture'] as const)('stops dragging on %s and ignores ordinary and touch drags', (event) => {
  render(<VitalsExplorer {...props} />)
  const region = screen.getByRole('region', { name: 'Scrollable vitals chart' })
  region.setPointerCapture = vi.fn()
  region.scrollLeft = 200
  for (const input of [{ pointerType: 'mouse', button: 0 }, { pointerType: 'touch', button: 0, shiftKey: true }, { pointerType: 'mouse', button: 2, shiftKey: true }]) {
    fireEvent.pointerDown(region, { ...input, clientX: 100 })
    fireEvent.pointerMove(region, { clientX: 50 })
    expect(region.scrollLeft).toBe(200)
  }
  fireEvent.pointerDown(region, { pointerType: 'mouse', button: 0, shiftKey: true, clientX: 100 })
  fireEvent[event](region)
  fireEvent.pointerMove(region, { clientX: 50 })
  expect(region.scrollLeft).toBe(200)
})

it('zooms out with its button and anchors the zoom after layout', () => {
  let frame: FrameRequestCallback | undefined
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frame = callback
    return 1
  })
  render(<VitalsExplorer {...props} />)
  const region = screen.getByRole('region', { name: 'Scrollable vitals chart' })
  Object.defineProperty(region, 'clientWidth', { value: 600 })
  Object.defineProperty(region, 'scrollWidth', { configurable: true, value: 600 })
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  Object.defineProperty(region, 'scrollWidth', { value: 1200 })
  frame?.(0)
  expect(region.scrollLeft).toBe(300)
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
  expect(screen.getByTestId('chart-content').parentElement?.style.width).toBe('100%')
})

it.each([1, 2])('normalizes wheel delta mode %i and ignores zero deltas', (deltaMode) => {
  render(<VitalsExplorer {...props} />)
  const region = screen.getByRole('region', { name: 'Scrollable vitals chart' })
  Object.defineProperty(region, 'clientHeight', { value: 300 })
  fireEvent.wheel(region, { ctrlKey: true, deltaY: -1, deltaMode })
  expect(Number.parseFloat(screen.getByTestId('chart-content').parentElement?.style.width ?? '0')).toBeGreaterThan(100)
  const idle = new WheelEvent('wheel', { ctrlKey: true, deltaY: 0, cancelable: true, bubbles: true })
  fireEvent(region, idle)
  expect(idle.defaultPrevented).toBe(false)
})

it('ignores empty brush windows, filters sessions, and resets zoom when selecting data', () => {
  const point = (t: number) => ({ t, hr: 60, hrv: 40, br: 15 })
  const sessions = [
    { start: 100, end: 300, points: [point(100), point(200), point(300)] },
    { start: 1000, end: 1100, points: [point(1000), point(1100)] },
  ]
  render(<VitalsExplorer {...props} sessions={sessions} />)
  const chart = () => {
    const call = vi.mocked(VitalsChart).mock.calls.at(-1)
    if (!call) throw new Error('Chart was not rendered')
    return call[0]
  }
  act(() => chart().onSelectWindow?.({ start: 400, end: 500 }))
  expect(chart().sessions).toEqual(sessions)
  expect(screen.queryByText(/Selected window/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  act(() => chart().onSelectWindow?.({ start: 150, end: 350 }))
  expect(chart().sessions).toEqual([{ start: 200, end: 300, points: [point(200), point(300)] }])
  expect(screen.getByTestId('chart-content').parentElement?.style.width).toBe('100%')
  fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }))
  expect(chart().sessions).toEqual(sessions)
})

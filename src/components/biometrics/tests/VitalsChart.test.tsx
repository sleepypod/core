/**
 * VitalsChart — the imported Apple Watch heart-rate overlay: drawn per session
 * as a dashed path in the heart-rate row, shown in the legend, and surfaced on
 * hover when a Watch sample sits within five minutes of the pod reading.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { VitalsExplorer } from '../VitalsExplorer'
import { splitSessions } from '../biometricsLogic'
import { nearestReference, referenceInSession, referenceRuns, VitalsChart, VitalsLegend } from '../VitalsChart'

vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => '12h' }))

const START = new Date(2026, 9, 10, 23, 0).getTime()
const MIN = 60_000

function podSession(start: number, minutes: number) {
  return Array.from({ length: minutes }, (_, i) => ({ t: start + i * MIN, hr: 60 + (i % 5), hrv: 40, br: 16 }))
}

const sessions = splitSessions([...podSession(START, 120), ...podSession(START + 6 * 60 * MIN, 60)])
const bands = { hr: null, hrv: null, br: null }

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => vi.restoreAllMocks())

function withWidth() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 300, right: 900, bottom: 300, toJSON: () => ({}) })
}

describe('VitalsChart reference overlay', () => {
  it('draws one dashed path per session that has Watch samples', () => {
    withWidth()
    const reference = [
      { t: START + 10 * MIN, hr: 58 },
      { t: START + 20 * MIN, hr: 57 },
      // Between sessions: belongs to neither, must not be drawn.
      { t: START + 4 * 60 * MIN, hr: 80 },
    ]
    render(<VitalsChart sessions={sessions} stall={null} bands={bands} reference={reference} />)
    const paths = screen.getAllByTestId('vitals-reference')
    expect(paths).toHaveLength(1)
    expect(paths[0].getAttribute('stroke-dasharray')).toBe('3 3')
    expect(paths[0].getAttribute('d')).toMatch(/^M.*L/)
  })

  it('lifts the pen across a sampling gap and dots an isolated sample', () => {
    withWidth()
    const reference = [
      { t: START + 10 * MIN, hr: 58 },
      { t: START + 12 * MIN, hr: 57 },
      // Watch off for an hour: the line must not bridge it.
      { t: START + 75 * MIN, hr: 61 },
    ]
    render(<VitalsChart sessions={sessions} stall={null} bands={bands} reference={reference} />)
    const d = screen.getByTestId('vitals-reference').getAttribute('d') ?? ''
    expect(d.match(/M/g)).toHaveLength(2)
    expect(d.match(/L/g)).toHaveLength(1)
    expect(screen.getAllByTestId('vitals-reference-dot')).toHaveLength(1)
  })

  it('draws nothing extra without reference samples', () => {
    withWidth()
    render(<VitalsChart sessions={sessions} stall={null} bands={bands} />)
    expect(screen.queryByTestId('vitals-reference')).toBeNull()
  })

  it('shows the nearest Watch value on hover when one is within five minutes', () => {
    withWidth()
    const reference = [{ t: START + 2 * MIN, hr: 58 }]
    const { container } = render(<VitalsChart sessions={sessions} stall={null} bands={bands} reference={reference} />)
    const overlay = container.querySelector('rect[style*="touch-action"]') as SVGRectElement
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 300, right: 900, bottom: 300, toJSON: () => ({}) })
    // Near the left edge of the first session, which starts at x≈0 within the plot.
    fireEvent.pointerMove(overlay, { clientX: 2, clientY: 50 })
    expect(screen.getByTestId('vitals-reference-hover').textContent).toBe('watch 58')
  })
})

describe('reference helpers', () => {
  it('referenceInSession keeps samples inside the session bounds inclusive', () => {
    const s = { start: 1000, end: 2000 }
    const pts = [{ t: 999, hr: 1 }, { t: 1000, hr: 2 }, { t: 1500, hr: 3 }, { t: 2000, hr: 4 }, { t: 2001, hr: 5 }]
    expect(referenceInSession(pts, s).map(p => p.hr)).toEqual([2, 3, 4])
  })

  it('referenceRuns splits only at gaps over the limit', () => {
    const pts = [{ t: 0, hr: 1 }, { t: 15 * MIN, hr: 2 }, { t: 15 * MIN + 1, hr: 3 }, { t: 40 * MIN, hr: 4 }]
    expect(referenceRuns(pts, 15 * MIN).map(run => run.map(p => p.hr))).toEqual([[1, 2, 3], [4]])
    expect(referenceRuns([], 15 * MIN)).toEqual([])
  })

  it('nearestReference picks the closest sample and respects the tolerance', () => {
    const pts = [{ t: 0, hr: 50 }, { t: 10 * MIN, hr: 60 }]
    expect(nearestReference(pts, 4 * MIN)?.hr).toBe(50)
    expect(nearestReference(pts, 7 * MIN)?.hr).toBe(60)
    expect(nearestReference(pts, 20 * MIN)).toBeNull()
    expect(nearestReference([], 0)).toBeNull()
  })
})

describe('VitalsLegend', () => {
  it('lists the Watch series only when present', () => {
    const { rerender } = render(<VitalsLegend bandLabel="middle 50%" stalled={false} />)
    expect(screen.queryByText('Apple Watch heart rate')).toBeNull()
    rerender(<VitalsLegend bandLabel="middle 50%" stalled={false} reference />)
    expect(screen.getByText('Apple Watch heart rate')).toBeTruthy()
  })
})

describe('movement alignment', () => {
  it('plots position changes in their own row, restricted to visible sessions', () => {
    withWidth()
    render(
      <VitalsChart
        sessions={sessions}
        bands={bands}
        stall={null}
        movement={[
          { bucketStart: new Date(START + 10 * MIN), eventCount: 3 },
          { bucketStart: new Date(START + 4 * 60 * MIN), eventCount: 8 },
        ]}
      />
    )
    expect(screen.getAllByTestId('movement-bar')).toHaveLength(1)
    expect(screen.getByTestId('movement-bar').textContent).toContain('3 position changes')
    expect(screen.getByText('changes / 5 min')).toBeTruthy()
  })
})

it('selects a time window by dragging in either direction and ignores a click', () => {
  withWidth()
  const selected = vi.fn()
  const { container } = render(<VitalsChart sessions={sessions} bands={bands} stall={null} onSelectWindow={selected} />)
  const overlay = container.querySelector('rect[style*="touch-action"]') as SVGRectElement
  overlay.setPointerCapture = vi.fn()
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({ left: 0 } as DOMRect)
  fireEvent.pointerDown(overlay, { clientX: 100, button: 0, pointerType: 'mouse' })
  fireEvent.pointerMove(overlay, { clientX: 300, pointerType: 'mouse' })
  expect(screen.getByTestId('vitals-selection').getAttribute('width')).toBe('200')
  fireEvent.pointerUp(overlay, { clientX: 300 })
  expect(selected).toHaveBeenCalledOnce()
  const window = selected.mock.calls[0][0]
  expect(window.start).toBeGreaterThan(START)
  expect(window.end).toBeGreaterThan(window.start)
  selected.mockClear()
  fireEvent.pointerDown(overlay, { clientX: 300, button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(overlay, { clientX: 100 })
  expect(selected).toHaveBeenCalledWith(window)
  selected.mockClear()
  fireEvent.pointerDown(overlay, { clientX: 100, button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(overlay, { clientX: 101 })
  expect(selected).not.toHaveBeenCalled()
  // Captured releases beyond either edge must use the visible, clamped brush width.
  const plotWidth = Number(overlay.getAttribute('width'))
  for (const [startX, endX] of [[4, -100], [plotWidth - 4, plotWidth + 100]]) {
    fireEvent.pointerDown(overlay, { clientX: startX, button: 0, pointerType: 'mouse' })
    fireEvent.pointerMove(overlay, { clientX: endX, pointerType: 'mouse' })
    expect(screen.getByTestId('vitals-selection').getAttribute('width')).toBe('4')
    fireEvent.pointerUp(overlay, { clientX: endX })
    expect(selected).not.toHaveBeenCalled()
  }
})

it('zooms all chart rows to the brush window and restores the full range on reset', () => {
  withWidth()
  const { container } = render(
    <VitalsExplorer
      sessions={sessions}
      bands={bands}
      stall={null}
      reference={[
        { t: START + 30 * MIN, hr: 58 }, { t: START + 6 * 60 * MIN + 10 * MIN, hr: 62 },
      ]}
    />
  )
  expect(screen.getAllByTestId('vitals-reference')).toHaveLength(2)
  const overlay = container.querySelector('rect[style*="touch-action"]') as SVGRectElement
  overlay.setPointerCapture = vi.fn()
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({ left: 0 } as DOMRect)
  fireEvent.pointerDown(overlay, { clientX: 100, button: 0, pointerType: 'mouse' })
  fireEvent.pointerUp(overlay, { clientX: 300 })
  expect(screen.getByText(/Selected window/)).toBeTruthy()
  expect(screen.getAllByTestId('vitals-reference')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }))
  expect(screen.queryByText(/Selected window/)).toBeNull()
  expect(screen.getAllByTestId('vitals-reference')).toHaveLength(2)
})

it('cancels selection and leaves touch, secondary-click, and Shift gestures unselected', () => {
  withWidth()
  const selected = vi.fn()
  const { container } = render(<VitalsChart sessions={sessions} bands={bands} stall={null} onSelectWindow={selected} />)
  const overlay = container.querySelector('rect[style*="touch-action"]') as SVGRectElement
  overlay.setPointerCapture = vi.fn()
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({ left: 0 } as DOMRect)
  for (const input of [{ pointerType: 'touch', button: 0 }, { pointerType: 'mouse', button: 2 }, { pointerType: 'mouse', button: 0, shiftKey: true }]) {
    fireEvent.pointerDown(overlay, { ...input, clientX: 100 })
    fireEvent.pointerUp(overlay, { clientX: 300 })
    expect(screen.queryByTestId('vitals-selection')).toBeNull()
    expect(selected).not.toHaveBeenCalled()
  }
  fireEvent.pointerDown(overlay, { pointerType: 'mouse', button: 0, clientX: 100 })
  fireEvent.pointerMove(overlay, { pointerType: 'mouse', clientX: 300 })
  expect(screen.getByTestId('vitals-selection')).toBeTruthy()
  fireEvent.pointerCancel(overlay)
  fireEvent.pointerUp(overlay, { clientX: 300 })
  expect(screen.queryByTestId('vitals-selection')).toBeNull()
  expect(selected).not.toHaveBeenCalled()
  fireEvent.pointerLeave(overlay, { pointerType: 'mouse' })
  expect(screen.queryByTestId('vitals-reference-hover')).toBeNull()
})

it('draws Watch HRV as distinct samples only within the visible sessions', () => {
  withWidth()
  render(
    <VitalsChart
      sessions={sessions}
      stall={null}
      bands={bands}
      referenceHrv={[
        { t: START + 10 * MIN, value: 35 },
        { t: START + 4 * 60 * MIN, value: 80 },
      ]}
    />
  )
  const dot = screen.getByTestId('vitals-watch-hrv')
  expect(dot.getAttribute('stroke')).toBe('var(--text-1)')
  expect(dot.textContent).toBe('Apple Watch SDNN · 35 ms')
})

it('uses small thin neutral circles for Watch breathing samples', () => {
  withWidth()
  render(<VitalsChart sessions={sessions} stall={null} bands={bands} referenceBr={[{ t: START + 10 * MIN, value: 14.5 }]} />)
  const dot = screen.getByTestId('vitals-watch-br')
  expect(dot.tagName).toBe('circle')
  expect(dot.getAttribute('r')).toBe('2')
  expect(dot.getAttribute('stroke-width')).toBe('1')
  expect(dot.getAttribute('stroke')).toBe('var(--text-1)')
  expect(dot.textContent).toBe('Apple Watch breathing · 14.5 br/min')
})

it.each(['referenceHrv', 'referenceBr'] as const)('joins nearby %s samples but leaves long gaps disconnected', (prop) => {
  withWidth()
  const points = [10, 15, 45, 50].map(m => ({ t: START + m * MIN, value: 30 }))
  render(<VitalsChart sessions={sessions} stall={null} bands={bands} {...{ [prop]: points }} />)
  const key = prop === 'referenceHrv' ? 'hrv' : 'br'
  const lines = screen.getAllByTestId(`vitals-watch-${key}-line`)
  expect(lines).toHaveLength(2)
  for (const line of lines) {
    expect(line.getAttribute('stroke-dasharray')).toBe('3 3')
    expect(line.getAttribute('d')?.match(/L/g)).toHaveLength(1)
  }
  expect(screen.getAllByTestId(`vitals-watch-${key}`)).toHaveLength(4)
})

it('exposes Watch SDNN and breathing through the interaction overlay, without bridging gaps', () => {
  withWidth()
  const { container, rerender } = render(
    <VitalsChart
      sessions={sessions}
      stall={null}
      bands={bands}
      referenceHrv={[{ t: START + 2 * MIN, value: 35 }]}
      referenceBr={[{ t: START + 2 * MIN, value: 14.5 }]}
    />
  )
  const overlay = container.querySelector('rect[style*="touch-action"]') as SVGRectElement
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({ left: 0 } as DOMRect)
  fireEvent.pointerMove(overlay, { clientX: 2, clientY: 50 })
  expect(screen.getByTestId('vitals-watch-hrv-hover').textContent).toBe('Watch SDNN 35 ms')
  expect(screen.getByTestId('vitals-watch-br-hover').textContent).toBe('Watch breathing 14.5 br/min')
  rerender(
    <VitalsChart
      sessions={sessions}
      stall={null}
      bands={bands}
      referenceHrv={[{ t: START + 30 * MIN, value: 35 }]}
      referenceBr={[{ t: START - MIN, value: 14.5 }]}
    />
  )
  expect(screen.queryByTestId('vitals-watch-hrv-hover')).toBeNull()
  expect(screen.queryByTestId('vitals-watch-br-hover')).toBeNull()
})

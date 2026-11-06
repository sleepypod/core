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
    expect(screen.queryByText('Apple Watch')).toBeNull()
    rerender(<VitalsLegend bandLabel="middle 50%" stalled={false} reference />)
    expect(screen.getByText('Apple Watch')).toBeTruthy()
  })

  it('keeps each series under the device that measured it', () => {
    render(<VitalsLegend bandLabel="middle 50%" stalled reference referenceHrv referenceRmssd referenceBr />)
    const pod = screen.getByText('Pod').nextElementSibling?.textContent
    const watch = screen.getByText('Apple Watch').nextElementSibling?.textContent
    for (const series of ['9-min average', 'per minute', 'middle 50%', 'in bed, no vitals']) {
      expect(pod).toContain(series)
      expect(watch).not.toContain(series)
    }
    for (const series of ['heart rate', 'HRV · SDNN', 'HRV · RMSSD', 'breathing']) {
      expect(watch).toContain(series)
      expect(pod).not.toContain(series)
    }
  })

  it('names RMSSD only when it is overlaid', () => {
    const { rerender } = render(<VitalsLegend bandLabel="middle 50%" stalled={false} referenceHrv />)
    expect(screen.queryByText('HRV · RMSSD')).toBeNull()
    rerender(<VitalsLegend bandLabel="middle 50%" stalled={false} referenceRmssd />)
    expect(screen.getByText('HRV · RMSSD')).toBeTruthy()
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

it('labels Watch RMSSD on the dot and on hover, apart from SDNN', () => {
  withWidth()
  const { container } = render(<VitalsChart sessions={sessions} stall={null} bands={bands} referenceRmssd={[{ t: START, value: 32 }]} referenceHrv={[{ t: START, value: 48 }]} />)
  expect(screen.getByTestId('vitals-watch-rmssd').textContent).toBe('Apple Watch RMSSD · 32 ms')
  const overlay = container.querySelector('rect[style*="touch-action"]') as SVGRectElement
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({ left: 0 } as DOMRect)
  fireEvent.pointerMove(overlay, { clientX: 2, clientY: 50 })
  expect(screen.getByTestId('vitals-watch-rmssd-hover').textContent).toBe('Watch RMSSD 32 ms')
  expect(screen.getByTestId('vitals-watch-hrv-hover').textContent).toBe('Watch SDNN 48 ms')
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

it('overlays RMSSD separately while retaining SDNN and breathing and breaking gaps', () => {
  withWidth()
  const referenceRmssd = [{ t: START, value: 32 }, { t: START + MIN, value: 34 }, { t: START + 60 * MIN, value: 30 }]
  render(<VitalsChart sessions={sessions} stall={null} bands={bands} referenceRmssd={referenceRmssd} referenceHrv={[{ t: START, value: 48 }]} referenceBr={[{ t: START, value: 14 }]} />)
  expect(screen.getAllByTestId('vitals-watch-rmssd')).toHaveLength(3)
  expect(screen.getAllByTestId('vitals-watch-rmssd-line')).toHaveLength(1)
  expect(screen.getByTestId('vitals-watch-rmssd-line').getAttribute('stroke-dasharray')).toBe('6 3')
  expect(screen.getByTestId('vitals-watch-hrv')).toBeTruthy()
  expect(screen.getByTestId('vitals-watch-br')).toBeTruthy()
})

describe('blood oxygen row', () => {
  const inSession = [{ t: START, value: 96 }, { t: START + MIN, value: 94 }, { t: START + 60 * MIN, value: 91 }]
  const between = [{ t: START + 4 * 60 * MIN, value: 97 }]
  const height = () => Number.parseInt(screen.getByTestId('vitals-chart').style.height)

  it('adds a row of its own, breaking the line across sampling gaps', () => {
    withWidth()
    render(<VitalsChart sessions={sessions} stall={null} bands={bands} referenceOxygen={inSession} />)
    expect(screen.getByText('Blood oxygen')).toBeTruthy()
    expect(screen.getAllByTestId('vitals-watch-oxygen')).toHaveLength(3)
    expect(screen.getAllByTestId('vitals-watch-oxygen-line')).toHaveLength(1)
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('blood oxygen')
    expect(screen.getAllByTestId('vitals-watch-oxygen')[0].textContent).toBe('Apple Watch blood oxygen · 96%')
  })

  it('leaves the chart as it was with no readings, or only readings between sessions', () => {
    withWidth()
    const { rerender } = render(<VitalsChart sessions={sessions} stall={null} bands={bands} />)
    const without = height()
    expect(screen.queryByText('Blood oxygen')).toBeNull()
    rerender(<VitalsChart sessions={sessions} stall={null} bands={bands} referenceOxygen={between} />)
    expect(screen.queryByText('Blood oxygen')).toBeNull()
    expect(screen.queryByTestId('vitals-watch-oxygen')).toBeNull()
    expect(height()).toBe(without)
    rerender(<VitalsChart sessions={sessions} stall={null} bands={bands} referenceOxygen={inSession} />)
    expect(height()).toBe(without + 96)
  })

  it('moves the movement row below it instead of drawing over it', () => {
    withWidth()
    const { rerender } = render(<VitalsChart sessions={sessions} stall={null} bands={bands} />)
    const top = () => Number.parseInt(screen.getByText('Movement').parentElement?.style.top ?? '')
    const before = top()
    rerender(<VitalsChart sessions={sessions} stall={null} bands={bands} referenceOxygen={inSession} />)
    expect(top()).toBe(before + 96)
  })

  it('pins a reading below the row to its bottom edge and keeps the real value on hover', () => {
    withWidth()
    render(<VitalsChart sessions={sessions} stall={null} bands={bands} referenceOxygen={[{ t: START + 2 * MIN, value: 72 }, { t: START + 3 * MIN, value: 80 }]} />)
    const [low, floor] = screen.getAllByTestId('vitals-watch-oxygen')
    expect(low.getAttribute('cy')).toBe(floor.getAttribute('cy'))
    fireEvent.pointerMove(screen.getByTestId('vitals-chart').querySelector('rect[fill="transparent"]') as Element, { clientX: 8 })
    expect(screen.getByTestId('vitals-watch-oxygen-hover').textContent).toBe('Watch blood oxygen 72%')
  })

  it('names blood oxygen under the Watch only when the row is drawn', () => {
    const { rerender } = render(<VitalsLegend bandLabel="middle 50%" stalled={false} />)
    expect(screen.queryByText('blood oxygen')).toBeNull()
    rerender(<VitalsLegend bandLabel="middle 50%" stalled={false} referenceOxygen />)
    expect(screen.getByText('Apple Watch').nextElementSibling?.textContent).toContain('blood oxygen')
  })
})

describe('VitalsChart Apple Watch movement overlay', () => {
  it('draws nothing extra without Watch movement', () => {
    withWidth()
    const { container: plain } = render(<VitalsChart sessions={sessions} stall={null} bands={bands} />)
    const { container: empty } = render(<VitalsChart sessions={sessions} stall={null} bands={bands} watchMovement={[]} />)
    // Same markup apart from the per-instance hatch pattern id.
    const strip = (html: string) => html.replace(/_r_\w+_|«\w+»|:r\w+:/g, '')
    expect(strip(empty.innerHTML)).toBe(strip(plain.innerHTML))
    expect(screen.queryAllByTestId('watch-movement-line')).toHaveLength(0)
  })

  it('sums into the pod\'s 5-minute buckets, breaks the line at missing buckets, dots isolated ones and ignores minutes outside sessions', () => {
    withWidth()
    const watchMovement = [
      // Before the first session: outside the night, never drawn or counted.
      { t: START - 30 * MIN, moving: 500 },
      { t: START, moving: 2 }, { t: START + MIN, moving: 4 }, { t: START + 6 * MIN, moving: 1 }, { t: START + 11 * MIN, moving: 20 },
      // A bucket without bins: a new run, and this one stands alone.
      { t: START + 20 * MIN, moving: 5 },
      { t: START + 30 * MIN, moving: 3 }, { t: START + 35 * MIN, moving: 2 },
      // Between sessions.
      { t: START + 4 * 60 * MIN, moving: 50 },
    ]
    render(<VitalsChart sessions={sessions} stall={null} bands={bands} watchMovement={watchMovement} />)
    const lines = screen.getAllByTestId('watch-movement-line')
    expect(lines).toHaveLength(2)
    expect(lines[0].getAttribute('d')?.match(/[ML]/g)).toEqual(['M', 'L', 'L'])
    expect(lines[0].getAttribute('stroke')).toBe('var(--accent-cool)')
    expect(screen.getAllByTestId('watch-movement-dot')).toHaveLength(1)
    // Scaled to the in-session peak, so the out-of-session 500 does not flatten the night.
    const ys = (lines[0].getAttribute('d') ?? '').split(/[ML]/).filter(Boolean).map(p => Number(p.split(' ')[1]))
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20)
  })

  it('lists Watch movement in the legend only when shown', () => {
    const { rerender } = render(<VitalsLegend bandLabel="band" stalled={false} />)
    expect(screen.queryByTestId('legend-watch-movement')).toBeNull()
    rerender(<VitalsLegend bandLabel="band" stalled={false} watchMovement />)
    expect(screen.getByTestId('legend-watch-movement').textContent).toBe('movement · scaled per night')
  })
})

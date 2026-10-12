/**
 * VitalsChart — the imported Apple Watch heart-rate overlay: drawn per session
 * as a dashed path in the heart-rate row, shown in the legend, and surfaced on
 * hover when a Watch sample sits within five minutes of the pod reading.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

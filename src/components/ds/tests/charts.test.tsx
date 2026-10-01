import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HoverMark, LineChart } from '../charts'

afterEach(cleanup)

const rect = (width: number) => ({ x: 0, y: 0, left: 0, top: 0, width, height: 80, right: width, bottom: 80, toJSON: () => ({}) })

describe('LineChart hover', () => {
  it('stays a bare svg without xLabel, and reads out the point under the pointer with it', () => {
    const plain = render(<LineChart series={[{ data: [1, 2, 3], color: 'red' }]} />)
    expect(plain.container.firstElementChild?.tagName).toBe('svg')
    plain.unmount()

    const { container, getByTestId, queryByTestId } = render(
      <LineChart
        series={[{ data: [10, 20, Number.NaN, 40], color: 'red' }, { data: [1, 2, 3, 4], color: 'blue' }]}
        xLabel={i => `p${i}`}
        format={(v, s) => (s === 0 ? `${v} bpm` : v.toFixed(1))}
      />,
    )
    const box = container.firstElementChild as HTMLElement
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(rect(300))
    // A third of the way across four points lands on index 1.
    fireEvent.pointerMove(box, { clientX: 100, clientY: 10 })
    expect(getByTestId('chart-hover').textContent).toBe('p1 · 20 bpm / 2.0')
    expect(getByTestId('chart-hover').style.left).toBe(`${(1 / 3) * 100}%`)
    // A gap in one series drops just that value.
    fireEvent.pointerMove(box, { clientX: 200, clientY: 10 })
    expect(getByTestId('chart-hover').textContent).toBe('p2 · 3.0')
    fireEvent.pointerLeave(box)
    expect(queryByTestId('chart-hover')).toBeNull()
  })
})

describe('HoverMark', () => {
  it('flips the label to the left past the middle', () => {
    const { getByTestId, rerender } = render(<HoverMark pct={20} label="a" />)
    expect(getByTestId('chart-hover').querySelector('span')?.className).toContain('left-1')
    rerender(<HoverMark pct={80} label="a" />)
    expect(getByTestId('chart-hover').querySelector('span')?.className).toContain('right-1')
  })
})

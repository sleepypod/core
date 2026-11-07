import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RecordedHeartRateChart } from '../RecordedHeartRateChart'

afterEach(cleanup)
const minute = 60000
const epoch = (at: number, heartRate: number | null) => ({ start: at * minute, duration: minute, heartRate })

it('draws separate unfilled paths with real elapsed-time spacing and no gap readout', () => {
  render(<RecordedHeartRateChart start={0} end={10 * minute} epochs={[epoch(0, 60), epoch(1, 62), epoch(6, 65), epoch(7, 64)]} />)
  const chart = screen.getByTestId('recorded-heart-rate')
  const paths = [...chart.querySelectorAll('path')]
  expect(paths).toHaveLength(2)
  expect(paths[0].getAttribute('d')).toMatch(/^M0\.0,.* L30\.0,/)
  expect(paths[1].getAttribute('d')).toMatch(/^M180\.0,.* L210\.0,/)
  expect(paths.every(path => path.getAttribute('fill') === 'none')).toBe(true)
  vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 300, height: 96, right: 300, bottom: 96, toJSON: () => ({}) })
  fireEvent.pointerMove(chart, { clientX: 90, clientY: 20 })
  expect(screen.getByTestId('chart-hover').textContent).toContain('No reading')
  expect(screen.getByTestId('chart-hover').textContent).not.toContain('bpm')
  fireEvent.pointerMove(chart, { clientX: 190, clientY: 20 })
  expect(screen.getByTestId('chart-hover').textContent).toContain('65 bpm')
})

it('breaks at missing heart-rate measurements and keeps isolated readings visible', () => {
  render(<RecordedHeartRateChart start={0} end={4 * minute} epochs={[epoch(0, 60), epoch(1, null), epoch(2, 70), epoch(3, 71)]} />)
  const chart = screen.getByTestId('recorded-heart-rate')
  expect(chart.querySelectorAll('circle')).toHaveLength(1)
  expect(chart.querySelectorAll('path')).toHaveLength(1)
  expect(chart.querySelector('path')?.getAttribute('d')).toMatch(/^M150\.0,.* L225\.0,/)
})

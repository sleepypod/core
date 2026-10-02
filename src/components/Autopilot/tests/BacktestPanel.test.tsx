import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { BacktestPanel } from '../BacktestPanel'
import type { BacktestResult } from '@/src/automation/backtest'
const result = {
  mode: 'edge', clockMin: [1320, 1380, 0, 60, 120, 420], primaryAxis: { min: 0, max: 300 }, tempAxis: { min: 60, max: 85 },
  primary: { label: 'Movement', values: [10, null, 200, 250, 100, 50] }, avg: { label: 'Average', values: [10, 20, 200, 250, 100, 50] },
  setpoint: [80, null, 78, 76, 76, 80], suppressed: [1, 2, 4], fires: [0, 3], threshold: 150,
  timeWindow: { startMin: 1380, endMin: 120 }, clamp: { min: 65, max: 80 },
  summary: { wouldFire: 2, suppressed: 3, netEffect: '-4°F', clampHits: 1, setpointRange: [65, 80] },
} as BacktestResult
it('selects recorded nights and renders loading, message and insufficient data states', () => {
  const props = { nights: [{ sleepRecordId: 1, label: 'Last night', date: 'Sep 28' }], nightId: 1, onNight: vi.fn() }
  const { rerender } = render(<BacktestPanel {...props} result={null} loading />)
  fireEvent.click(screen.getByRole('button', { name: /Last night/ }))
  expect(props.onNight).toHaveBeenCalledWith(1)
  expect(screen.getByText('Replaying…')).toBeTruthy()
  rerender(<BacktestPanel {...props} result={null} loading={false} message="No nights available" />)
  expect(screen.getByText('No nights available')).toBeTruthy()
  rerender(<BacktestPanel {...props} result={{ ...result, clockMin: [0] }} loading={false} />)
  expect(screen.getByText('Not enough data in this window to replay.')).toBeTruthy()
})
it.each(['edge', 'policy'] as const)('renders %s traces with gaps, windows and clamp summaries', (mode) => {
  const r = { ...result, mode, setpointRaw: [80, null, 85, 90, 85, 75] }
  const { container, rerender } = render(<BacktestPanel result={r} loading={false} nights={[]} nightId={null} onNight={vi.fn()} />)
  expect(screen.getByText(mode === 'edge' ? '-4°F' : 'Continuous')).toBeTruthy()
  expect(container.querySelectorAll('path').length).toBeGreaterThan(2)
  for (const path of container.querySelectorAll('path')) expect(path.getAttribute('d')).not.toContain('NaN')
  rerender(<BacktestPanel result={{ ...r, primary: null, avg: null, primaryAxis: null, tempAxis: null, threshold: null, timeWindow: { startMin: 0, endMin: 120 }, summary: { ...r.summary, clampHits: 0, setpointRange: null, netEffect: null } }} loading={false} nights={[]} nightId={null} onNight={vi.fn()} />)
  expect(screen.getByText('—')).toBeTruthy()
})

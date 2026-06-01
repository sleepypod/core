import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { ThermalTrendChart } from '../ThermalTrendChart'
import type { ThermalTrendPoint } from '../diagnosticsLogic'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

describe('ThermalTrendChart', () => {
  it('shows a collecting hint with fewer than two points', () => {
    render(<ThermalTrendChart side="left" points={[{ t: 1, target: 80, bed: 75, water: 70 }]} />)
    expect(screen.getByText(/Collecting samples/i)).toBeTruthy()
  })

  it('renders a chart once enough points exist', () => {
    const points: ThermalTrendPoint[] = [
      { t: 1, target: 80, bed: 75, water: 70 },
      { t: 2, target: 80, bed: 76, water: 71 },
      { t: 3, target: null, bed: null, water: null },
    ]
    const { container } = render(<ThermalTrendChart side="right" points={points} />)
    expect(screen.queryByText(/Collecting samples/i)).toBeNull()
    expect(container.querySelector('.recharts-responsive-container')).toBeTruthy()
  })
})

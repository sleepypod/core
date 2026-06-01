import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { BiometricsTrendChart, type VitalSample } from '../BiometricsTrendChart'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

describe('BiometricsTrendChart', () => {
  it('shows a fallback with fewer than two rows', () => {
    render(<BiometricsTrendChart rows={[{ timestamp: '2026-05-31T01:00:00Z', heartRate: 60, hrv: 40, breathingRate: 14 }]} />)
    expect(screen.getByText(/Not enough vitals/i)).toBeTruthy()
  })

  it('renders a chart from multiple rows (and sorts ascending)', () => {
    const rows: VitalSample[] = [
      { timestamp: '2026-05-31T03:00:00Z', heartRate: 62, hrv: 45, breathingRate: 13 },
      { timestamp: '2026-05-31T01:00:00Z', heartRate: 58, hrv: 50, breathingRate: 12 },
      { timestamp: '2026-05-31T02:00:00Z', heartRate: null, hrv: null, breathingRate: null },
    ]
    const { container } = render(<BiometricsTrendChart rows={rows} />)
    expect(screen.queryByText(/Not enough vitals/i)).toBeNull()
    expect(container.querySelector('.recharts-responsive-container')).toBeTruthy()
  })
})

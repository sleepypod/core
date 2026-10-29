import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WaterTankGauge } from '../WaterTankGauge'

describe('WaterTankGauge', () => {
  it('renders a 5-bar gauge when capValid is true', () => {
    const { rerender } = render(<WaterTankGauge capLevel={4} capValid={true} />)
    const gauge = screen.getByTestId('water-tank-gauge')
    expect(gauge).toBeTruthy()
    expect(gauge.getAttribute('aria-label')).toBe('Tank level 4 of 5 bars')
    expect(screen.getByText('4/5')).toBeTruthy()

    const filledBars = gauge.querySelectorAll('.bg-cool')
    expect(filledBars).toHaveLength(4)
    const emptyBars = gauge.querySelectorAll('.bg-active')
    expect(emptyBars).toHaveLength(1)

    // Warn tone when level is low (0 or 1)
    rerender(<WaterTankGauge capLevel={1} capValid={true} />)
    expect(screen.getByTestId('water-tank-gauge').querySelectorAll('.bg-warn')).toHaveLength(1)
    expect(screen.getByText('1/5')).toBeTruthy()
  })

  it('shows priming and needs priming status when capacitive level is valid', () => {
    const { rerender } = render(<WaterTankGauge capLevel={3} capValid={true} isPriming={true} />)
    expect(screen.getByText('priming')).toBeTruthy()

    rerender(<WaterTankGauge capLevel={3} capValid={true} needsPriming={true} />)
    expect(screen.getByText('needs prime')).toBeTruthy()
  })

  it('falls back to binary ok/low state when capValid is false or frzWater is missing', () => {
    const { rerender } = render(<WaterTankGauge capLevel={4} capValid={false} waterLevel="ok" />)
    expect(screen.queryByTestId('water-tank-gauge')).toBeNull()
    expect(screen.getByTestId('water-tank-gauge-fallback')).toBeTruthy()
    expect(screen.getByText('OK')).toBeTruthy()

    rerender(<WaterTankGauge waterLevel="low" />)
    expect(screen.getByText('Low')).toBeTruthy()
  })

  it('returns nothing when neither capLevel nor waterLevel is available', () => {
    const { container } = render(<WaterTankGauge />)
    expect(container.firstChild).toBeNull()
  })
})

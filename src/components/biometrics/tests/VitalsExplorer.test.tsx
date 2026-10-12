import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VitalsExplorer } from '../VitalsExplorer'

vi.mock('../VitalsChart', () => ({ VitalsChart: () => <div data-testid="chart-content" /> }))
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
    fireEvent.pointerDown(region, { clientX: 200, pointerType: 'mouse', button: 0, pointerId: 1 })
    fireEvent.pointerMove(region, { clientX: 100, pointerType: 'mouse', pointerId: 1 })
    expect(region.scrollLeft).toBe(300)
    fireEvent.pointerUp(region)
    fireEvent.pointerMove(region, { clientX: 50 })
    expect(region.scrollLeft).toBe(300)
  })
})

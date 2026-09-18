import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LiveReadout } from '../LiveReadout'
import type { LiveReading } from '@/src/automation/live'

afterEach(cleanup)
const reading: LiveReading = { signal: 'left.movement', aggregation: 'avg', windowMin: 10, value: 168, op: '>', threshold: 200, matched: false }

describe('LiveReadout', () => {
  it('renders the numeric reading and threshold with an accessible meter', () => {
    render(<LiveReadout live={reading} />)
    const meter = screen.getByRole('meter')
    expect(meter.getAttribute('aria-valuenow')).toBe('168')
    expect(meter.getAttribute('aria-valuetext')).toContain('168 / > 200; comparison not met')
    expect(screen.getByText('Movement avg (10m)')).toBeTruthy()
  })
  it('keeps a negative below-threshold comparison on a signed meter domain', () => {
    render(<LiveReadout live={{ ...reading, signal: 'custom.zscore', aggregation: null, windowMin: null, value: -0.8, op: '<', threshold: -2 }} />)
    const meter = screen.getByRole('meter')
    expect(Number(meter.getAttribute('aria-valuemin'))).toBeLessThan(-2)
    expect(Number(meter.getAttribute('aria-valuemax'))).toBeGreaterThan(-0.8)
    expect(meter.getAttribute('aria-valuetext')).toContain('comparison not met')
  })
  it('marks a satisfied comparison and handles zero without dividing by zero', () => {
    render(<LiveReadout live={{ ...reading, value: 0, threshold: 0, op: '==', matched: true }} />)
    expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toContain('comparison met')
    expect(screen.getByRole('meter').getAttribute('aria-valuemin')).toBe('-0.2')
  })
  it('does not invent a meter for unavailable values or unthresholded readings', () => {
    const { rerender } = render(<LiveReadout live={{ ...reading, value: null, matched: null }} />)
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.queryByRole('meter')).toBeNull()
    rerender(<LiveReadout live={{ ...reading, signal: 'ambient.temperature', value: 69, aggregation: null, windowMin: null, op: null, threshold: null }} />)
    expect(screen.getByText('69°F')).toBeTruthy()
    expect(screen.queryByRole('meter')).toBeNull()
    rerender(<LiveReadout />)
    expect(screen.getByText('Live data unavailable')).toBeTruthy()
  })
})

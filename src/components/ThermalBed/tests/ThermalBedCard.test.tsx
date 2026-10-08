import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BedTempFrame } from '@/src/hooks/useSensorStream'
const m = vi.hoisted(() => ({ frame: undefined as BedTempFrame | undefined, stored: null as unknown, query: vi.fn(), canvas: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/en' }))
vi.mock('next/dynamic', () => ({ default: () => (props: unknown) => {
  m.canvas(props)
  return null
} }))
vi.mock('@/src/hooks/useSensorStream', () => ({ useSensorStream: vi.fn(), useSensorFrame: (type: string) => type === 'bedTemp' ? m.frame : undefined }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { environment: { getLatestBedTemp: { useQuery: (...args: unknown[]) => {
  m.query(...args)
  return { data: m.stored }
} } } } }))
import ThermalBedCard from '../ThermalBedCard'
const props = {
  unit: 'F' as const, names: { left: 'Left', right: 'Right' }, blocked: { left: false, right: false },
  controls: { left: { currentTemperature: 80, targetTemperature: 70, targetLevel: -5 }, right: { currentTemperature: null, targetTemperature: null, targetLevel: 0 } },
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  m.frame = { type: 'bedTemp', ts: 1000, ambientTemp: null, mcuTemp: null, humidity: null, leftOuterTemp: 20, leftCenterTemp: 22, leftInnerTemp: 24, rightOuterTemp: 30, rightCenterTemp: 28, rightInnerTemp: 26 }
  m.stored = null
  m.query.mockClear()
  m.canvas.mockClear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
describe('ThermalBedCard', () => {
  it('shows measured sensors separately from targets and lets either side be inspected', () => {
    const screen = render(<ThermalBedCard {...props} />)
    expect(screen.queryByText('68.0°')).toBeNull()
    expect(m.canvas.mock.lastCall?.[0].view).toBe('overview')
    expect(screen.getByRole('link').getAttribute('href')).toBe('/en/system?tab=sensors')
    expect(screen.getByText('Cooling')).toBeTruthy()
    expect(screen.getByText('Off')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Right temperatures' }))
    expect(m.canvas.mock.lastCall?.[0].focus).toBe('right')
    expect(m.query.mock.lastCall?.[1].enabled).toBe(false)
  })
  it('ages out a stalled stream, stops motion and re-enables the HTTP fallback', () => {
    const screen = render(<ThermalBedCard {...props} />)
    act(() => vi.advanceTimersByTime(95_000))
    expect(screen.getByText('Stale readings')).toBeTruthy()
    expect(m.query.mock.lastCall?.[1].enabled).toBe(true)
    // The field goes blank, but the pod's own status stays on the pill.
    expect(m.canvas.mock.lastCall?.[0].states.left).toEqual({ zones: [null, null, null], direction: 0, strength: 0, mode: 'cooling', targetF: 70, currentF: 80 })
  })
  it('renders Celsius and missing readings without fabricating temperatures', () => {
    m.frame = undefined
    const screen = render(<ThermalBedCard {...props} unit="C" />)
    expect(screen.getByText('Waiting for sensors', { selector: 'span.ml-2' })).toBeTruthy()
    expect(screen.getAllByText('--').length).toBeGreaterThan(0)
    expect(screen.getByText('27°C')).toBeTruthy()
  })
  it('derives control off from the power level, not a missing setpoint', () => {
    const controls = { ...props.controls, left: { currentTemperature: 80, targetTemperature: null, targetLevel: -5 } }
    const screen = render(<ThermalBedCard {...props} controls={controls} />)
    expect(screen.getByText('→ -- target')).toBeTruthy()
    expect(screen.getAllByText('control off')).toHaveLength(1)
  })
  it('labels a stored surface, shows a heating side and toggles the inspected side off again', () => {
    m.frame = { ...(m.frame as BedTempFrame), ts: 900 }
    m.stored = { leftOuterTemp: 20, leftCenterTemp: 22, leftInnerTemp: 24, rightOuterTemp: 20, rightCenterTemp: 20, rightInnerTemp: 20, timestamp: new Date(990_000) }
    const controls = { ...props.controls, right: { currentTemperature: 70, targetTemperature: 90, targetLevel: 5 } }
    const screen = render(<ThermalBedCard {...props} controls={controls} />)
    expect(screen.getByText('Stored surface')).toBeTruthy()
    expect(screen.getByText('Warming').className).toBe('text-warm')
    const right = screen.getByRole('button', { name: 'Inspect Right temperatures' })
    fireEvent.click(right)
    expect(right.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(right)
    expect(right.getAttribute('aria-pressed')).toBe('false')
    expect(m.canvas.mock.lastCall?.[0].focus).toBeNull()
  })
})

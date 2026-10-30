import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bedroomConfigSchema, bedroomSourceSchema, type BedroomObservation } from '@/src/bedroom/contract'
import { bedroomComfortGuidance, combineBedroomSensors } from '@/src/bedroom/fusion'
import { BedroomSensors } from '../BedroomSensors'
import { BedroomSummary } from '../BedroomSummary'

const now = 1793067000000
function snapshot() {
  const source = bedroomSourceSchema.parse({ id: 'bedside_temperature', deviceId: 'bedside', deviceName: 'Bedside sensor', label: 'Temperature',
    provider: 'apple_home', externalId: 'test-temperature', location: 'left', metric: 'temperature', unit: '°F', maxAgeSeconds: 120,
    enabled: true, useForControl: true })
  const observation: BedroomObservation = { source, status: 'fresh', value: 76, lastValue: 76, unit: '°F', observedAt: now,
    measuredAt: null, receivedAt: now, expiresAt: now + 10000, timeBasis: 'device_read', controlEligible: true }
  return { apiVersion: 1 as const, generatedAt: now, revision: 1, config: bedroomConfigSchema.parse({ enabled: true, roomName: 'Bedroom', sources: [source] }),
    observations: [observation], aggregates: combineBedroomSensors([observation], now), guidance: bedroomComfortGuidance([], now) }
}
const fixture = vi.hoisted(() => ({ data: undefined as unknown as ReturnType<typeof snapshot>, isError: false, dataUpdatedAt: 0,
  refetch: vi.fn(), save: vi.fn() }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { bedroom: {
  status: { useQuery: () => ({ data: fixture.data, isError: fixture.isError, dataUpdatedAt: fixture.dataUpdatedAt, refetch: fixture.refetch }) },
  configure: { useMutation: () => ({ mutateAsync: fixture.save, isPending: false }) },
} } }))
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  fixture.data = snapshot()
  fixture.dataUpdatedAt = now
  fixture.isError = false
  fixture.save.mockReset()
  fixture.refetch.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('bedroom device view', () => {
  it.each([BedroomSensors, BedroomSummary])('uses the current render clock for between-tick receipts without hiding rollback', (Component) => {
    const view = render(<Component />)
    vi.setSystemTime(now + 100)
    fixture.dataUpdatedAt = now + 100
    view.rerender(<Component />)
    expect(screen.queryByText(/Connection needs refresh|Temperature unavailable/)).toBeNull()
    vi.setSystemTime(now + 99)
    view.rerender(<Component />)
    expect(screen.queryByText(/^76°F$/)).toBeNull()
    expect(screen.queryByText(/Current 76°F/)).toBeNull()
  })
  it('names each device and distinguishes a device query from a measurement timestamp', () => {
    render(<BedroomSensors />)
    const device = screen.getByRole('article')
    expect(within(device).getByRole('heading', { name: 'Bedside sensor' })).toBeTruthy()
    expect(device.textContent).toContain('Apple Home · Left bedside')
    expect(device.textContent).toContain('76°F')
    expect(device.textContent).toContain('Reported')
    expect(device.textContent).not.toContain('Measured')
  })
  it('expires a visible reading without relying on another server response', () => {
    render(<BedroomSensors />)
    expect(screen.getAllByText('76°F')).toHaveLength(2)
    act(() => {
      vi.advanceTimersByTime(10000)
    })
    expect(screen.queryByText('76°F')).toBeNull()
    expect(screen.getByText(/Reading expired/)).toBeTruthy()
  })
  it('withdraws current labels on transport failure and never promotes a cached value', () => {
    fixture.isError = true
    const view = render(<BedroomSensors />)
    expect(screen.queryByText('76°F')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('could not be refreshed')
    fixture.isError = false
    fixture.data.observations[0] = { ...fixture.data.observations[0], status: 'cached', timeBasis: 'cached', value: null, controlEligible: false }
    fixture.data.aggregates = combineBedroomSensors(fixture.data.observations, now)
    view.rerender(<BedroomSensors />)
    expect(screen.queryByText('76°F')).toBeNull()
    expect(screen.getByText(/Last reported: 76°F · cached, freshness unknown/)).toBeTruthy()
    expect(screen.queryByText(/qualified source/)).toBeNull()
  })
  it('retains a cached power value of zero without presenting it as current', () => {
    fixture.data.observations[0] = { ...fixture.data.observations[0],
      source: { ...fixture.data.observations[0].source, metric: 'power', label: 'Power', unit: 'on/off' },
      unit: 'on/off', status: 'cached', timeBasis: 'cached', value: null, lastValue: 0, controlEligible: false }
    fixture.data.aggregates = []
    render(<BedroomSensors />)
    expect(screen.getByText(/Last reported: Off · cached, freshness unknown/)).toBeTruthy()
    expect(screen.queryByText('Off')).toBeNull()
  })
  it('explains why a discovered Apple Home device still has no readings', () => {
    fixture.data.observations[0] = { ...fixture.data.observations[0], status: 'waiting', value: null, lastValue: null,
      observedAt: null, receivedAt: null, measuredAt: null, expiresAt: null, controlEligible: false }
    fixture.data.aggregates = []
    render(<BedroomSensors />)
    expect(screen.getByText(/Waiting for an Apple Home sensor export/)).toBeTruthy()
    expect(screen.queryByText(/Last reported:/)).toBeNull()
  })
  it('shows individual display-only readings in the routine context without making them control aggregates', () => {
    fixture.data.observations[0].source.useForControl = false
    fixture.data.observations[0].controlEligible = false
    fixture.data.aggregates = combineBedroomSensors(fixture.data.observations, now)
    const view = render(<BedroomSummary />)
    expect(screen.getByText(/Temperature unavailable/)).toBeTruthy()
    expect(screen.getByText(/Bedside sensor · Temperature: Current 76°F · Display only/)).toBeTruthy()
    fixture.data.observations[0] = { ...fixture.data.observations[0], status: 'cached', timeBasis: 'cached', value: null }
    view.rerender(<BedroomSummary />)
    expect(screen.queryByText(/Current 76°F/)).toBeNull()
    expect(screen.getByText(/Last reported 76°F · cached, freshness unknown/)).toBeTruthy()
  })
  it('preserves a settings draft and requires a reload when the saved source revision changes', () => {
    const view = render(<BedroomSensors />)
    const checkbox = screen.getByRole('checkbox', { name: 'Use Bedside sensor Temperature for room rules', hidden: true })
    fireEvent.click(checkbox)
    fixture.data = { ...fixture.data, revision: 2 }
    view.rerender(<BedroomSensors />)
    expect((checkbox as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: 'Save bedroom inputs', hidden: true }) as HTMLButtonElement).disabled).toBe(true)
    expect(fixture.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft and reload', hidden: true }))
    expect((checkbox as HTMLInputElement).checked).toBe(true)
  })
})

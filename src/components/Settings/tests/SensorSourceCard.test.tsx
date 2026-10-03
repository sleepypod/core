import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SensorSourceCard } from '../SensorSourceCard'

const mock = vi.hoisted(() => ({ data: undefined as unknown, loading: false, error: null as Error | null }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  system: { getSensorSource: { useQuery: () => ({ data: mock.data, isLoading: mock.loading, error: mock.error }) } },
} }))

const natsPod = {
  firmware: {
    generation: 'nats',
    label: 'NATS JetStream',
    detail: 'New firmware publishes frames to NATS.',
    expectedTransport: 'nats',
    probed: true,
    signals: { natsUnitInstalled: true, natsServerActive: true, jetstreamDirPresent: true, biometricsTmpfsMounted: false, frankShimRoutesTmpfs: false, frankServiceRoutesTmpfs: false },
  },
  stream: { source: 'nats', override: null, legacyNatsDisabled: false, lastFrameAtMs: 1_000, lastFrameAgeMs: 3_000, lastFrameType: 'capSense', firstFrameMs: 1200, uptimeSeconds: 900 },
}

beforeEach(() => {
  mock.data = natsPod
  mock.loading = false
  mock.error = null
})

it('shows the firmware generation, the selected source and frame freshness', () => {
  render(<SensorSourceCard />)
  expect(screen.getByText('Sensor data source')).toBeTruthy()
  expect(screen.getByTestId('firmware-generation').textContent).toBe('NATS JetStream')
  expect(screen.getByTestId('stream-source').textContent).toBe('NATS stream')
  expect(screen.getByTestId('last-frame').textContent).toBe('3s ago')
  expect(screen.getByText('capSense frame')).toBeTruthy()
  expect(screen.getByText('Live')).toBeTruthy()
  expect(screen.queryByTestId('source-note')).toBeNull()
})

it('explains a fallback to .RAW on NATS firmware and marks a stall', () => {
  mock.data = {
    ...natsPod,
    stream: { ...natsPod.stream, source: 'raw', lastFrameAgeMs: 5 * 60_000 },
  }
  render(<SensorSourceCard />)
  expect(screen.getByTestId('stream-source').textContent).toBe('.RAW files')
  expect(screen.getByText('Stalled')).toBeTruthy()
  expect(screen.getByTestId('source-note').textContent).toContain('fell back to .RAW files')
})

it('reads as a dev box when no firmware probe ran, and shows a pending pick', () => {
  mock.data = {
    firmware: { ...natsPod.firmware, generation: 'raw-filesystem', label: '.RAW on /persistent', probed: false, expectedTransport: 'raw' },
    stream: { ...natsPod.stream, source: 'pending', lastFrameAtMs: null, lastFrameAgeMs: null, lastFrameType: null, uptimeSeconds: 5 },
  }
  render(<SensorSourceCard />)
  expect(screen.getByTestId('firmware-generation').textContent).toBe('—')
  expect(screen.getByText('Not running on a pod — no firmware detected.')).toBeTruthy()
  expect(screen.getByTestId('stream-source').textContent).toBe('choosing…')
  expect(screen.getByTestId('last-frame').textContent).toBe('none yet')
  expect(screen.getByText('Choosing')).toBeTruthy()
})

it('warns when a settled source has delivered nothing past the startup grace', () => {
  mock.data = {
    ...natsPod,
    stream: { ...natsPod.stream, lastFrameAtMs: null, lastFrameAgeMs: null, lastFrameType: null, uptimeSeconds: 600 },
  }
  render(<SensorSourceCard />)
  expect(screen.getByText('No frames')).toBeTruthy()
  expect(screen.getByTestId('last-frame').textContent).toBe('none yet')
  expect(screen.queryByText('capSense frame')).toBeNull()
})

it('renders a skeleton while loading, nothing without data, and the error inline', () => {
  mock.loading = true
  mock.data = undefined
  const { rerender, container } = render(<SensorSourceCard />)
  expect(screen.queryByText('Sensor data source')).toBeNull()
  expect(container.firstChild).not.toBeNull()
  mock.loading = false
  rerender(<SensorSourceCard />)
  expect(container.firstChild).toBeNull()
  mock.error = new Error('offline')
  rerender(<SensorSourceCard />)
  expect(screen.getByText('offline')).toBeTruthy()
})

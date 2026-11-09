import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { SensorSourceCard } from '../SensorSourceCard'

const mock = vi.hoisted(() => ({
  data: undefined as unknown,
  loading: false,
  error: null as Error | null,
  prefix: null as string | null,
  update: vi.fn(),
  updateOptions: null as { onSuccess?: () => void } | null,
  restart: vi.fn(async ({ unit }: { unit: string }) => ({ ok: true, message: `Restarted ${unit}` })),
}))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ settings: { getAll: { invalidate: vi.fn() } }, system: { getSensorSource: { invalidate: vi.fn() } } }),
  system: { getSensorSource: { useQuery: () => ({ data: mock.data, isLoading: mock.loading, error: mock.error }) } },
  settings: {
    getAll: { useQuery: () => ({ data: { device: { natsSubjectPrefix: mock.prefix } } }) },
    updateDevice: {
      useMutation: (options: { onSuccess?: () => void }) => {
        mock.updateOptions = options
        return { mutate: mock.update, isPending: false, error: null }
      },
    },
  },
  health: { restartService: { useMutation: () => ({ mutateAsync: mock.restart }) } },
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
  nats: {
    mode: 'auto',
    configuredPrefix: null,
    subscribedSubjects: ['raw.sens.>', 'raw.frz.>', 'rawmem.sens.>', 'rawmem.frz.>'],
    sources: { 'sens.piezo': 'raw', 'frz.temp': 'rawmem', 'sens.capsense': 'raw' },
    messages: 40,
    decodeFailures: 0,
    ignoredMessages: 3,
    observedPrefixes: [{ prefix: 'raw', subscribed: true, messages: 30, lastSeenAtMs: 1_000, lastSeenAgeMs: 2_000 }],
  },
}

beforeEach(() => {
  mock.data = natsPod
  mock.loading = false
  mock.error = null
  mock.prefix = null
  mock.update.mockReset()
  mock.restart.mockClear()
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

it('shows which prefix feeds each subject and every prefix seen publishing', () => {
  render(<SensorSourceCard />)
  expect(screen.getByTestId('nats-mode').textContent).toBe('auto')
  expect(screen.getByText('raw: sens.capsense, sens.piezo · rawmem: frz.temp')).toBeTruthy()
  expect(screen.getByText('raw 2s ago')).toBeTruthy()
})

it('points at a publishing prefix the pod does not read when no frames arrive', () => {
  mock.data = {
    ...natsPod,
    stream: { ...natsPod.stream, lastFrameAtMs: null, lastFrameAgeMs: null, lastFrameType: null },
    nats: { ...natsPod.nats, sources: {}, observedPrefixes: [{ prefix: 'rawv2', subscribed: false, messages: 9, lastSeenAtMs: 1_000, lastSeenAgeMs: 1_000 }] },
  }
  render(<SensorSourceCard />)
  expect(screen.getByText('No subject has delivered a frame yet.')).toBeTruthy()
  expect(screen.getByText('rawv2 (not read) 1s ago')).toBeTruthy()
  expect(screen.getByTestId('source-note').textContent).toBe('Firmware publishes under rawv2, which this pod doesn\'t read. Set the subject prefix to rawv2.')
})

it('hides the prefix control and NATS readout on a RAW pod', () => {
  mock.data = {
    firmware: { ...natsPod.firmware, generation: 'raw-filesystem', label: '.RAW on /persistent', expectedTransport: 'raw' },
    stream: { ...natsPod.stream, source: 'raw' },
    nats: null,
  }
  render(<SensorSourceCard />)
  expect(screen.queryByText('Subject prefix')).toBeNull()
  expect(screen.queryByText('Publishing prefixes')).toBeNull()
})

it('pins a listed prefix, returns to auto, and offers to restart the biometrics modules', async () => {
  render(<SensorSourceCard />)
  expect(screen.getByRole('tab', { name: 'Auto' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getByRole('tab', { name: 'rawmem' }))
  expect(mock.update).toHaveBeenCalledWith({ natsSubjectPrefix: 'rawmem' })
  expect(screen.queryByTestId('prefix-restart')).toBeNull()

  act(() => mock.updateOptions?.onSuccess?.())
  expect(screen.getByText('The live stream switched already. Biometrics modules pick this up on their next restart.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Restart biometrics modules' }))
  await waitFor(() => expect(screen.getByTestId('prefix-restart-result').textContent).toBe('Restarted 3 biometrics modules.'))
  expect(mock.restart.mock.calls.map(([input]) => input.unit)).toEqual([
    'sleepypod-piezo-processor.service',
    'sleepypod-sleep-detector.service',
    'sleepypod-environment-monitor.service',
  ])
})

it('reports a module that could not be restarted from the app', async () => {
  mock.restart.mockResolvedValueOnce({ ok: false, message: 'Run on the pod: sudo systemctl restart sleepypod-piezo-processor.service' })
  render(<SensorSourceCard />)
  fireEvent.click(screen.getByRole('tab', { name: 'raw' }))
  act(() => mock.updateOptions?.onSuccess?.())
  fireEvent.click(screen.getByRole('button', { name: 'Restart biometrics modules' }))
  await waitFor(() => expect(screen.getByTestId('prefix-restart-result').textContent).toContain('sudo systemctl restart'))
})

it('does not save the prefix it already has', () => {
  mock.prefix = 'rawmem'
  render(<SensorSourceCard />)
  expect(screen.getByRole('tab', { name: 'rawmem' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getByRole('tab', { name: 'rawmem' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Auto' }))
  expect(mock.update.mock.calls).toEqual([[{ natsSubjectPrefix: null }]])
})

it('saves a valid custom prefix and holds back an invalid one', () => {
  render(<SensorSourceCard />)
  fireEvent.click(screen.getByRole('tab', { name: 'Custom…' }))
  const input = screen.getByLabelText('Custom prefix')
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement

  fireEvent.change(input, { target: { value: 'raw.sens' } })
  expect(save.disabled).toBe(true)
  expect(screen.getByText('Letters, digits, _ or -, up to 32 characters. No dots or wildcards.')).toBeTruthy()

  fireEvent.change(input, { target: { value: 'rawv2' } })
  expect(save.disabled).toBe(false)
  fireEvent.click(save)
  expect(mock.update).toHaveBeenCalledWith({ natsSubjectPrefix: 'rawv2' })
})

it('shows a stored custom prefix under Custom', () => {
  mock.prefix = 'rawv2'
  render(<SensorSourceCard />)
  expect(screen.getByRole('tab', { name: 'Custom…' }).getAttribute('aria-selected')).toBe('true')
})

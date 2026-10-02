import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { evaluateDataPath, type DataPathInputs } from '@/src/lib/dataPath'

const NOW = new Date(2026, 8, 28, 6, 10).getTime()
const MIN = 60_000

const mocks = vi.hoisted(() => ({
  dataPath: undefined as unknown,
  history: undefined as unknown,
  restart: vi.fn(),
  recalibrate: vi.fn(),
  restartAsync: vi.fn(async () => ({ ok: true, message: 'ok' })),
  push: vi.fn(),
  replace: vi.fn(),
  params: new URLSearchParams('tab=health'),
  width: 900,
}))

vi.mock('next/navigation', () => ({ usePathname: () => '/en/system', useRouter: () => ({ push: mocks.push, replace: mocks.replace }), useSearchParams: () => mocks.params }))
vi.mock('@/src/hooks/useSide', () => ({ useSide: () => ({ side: 'left' }) }))
vi.mock('@/src/hooks/useSideNames', () => ({ useSideNames: () => ({ leftName: 'Left', rightName: 'Right', sideName: (s: string) => (s === 'left' ? 'Left' : 'Right') }) }))
vi.mock('@/src/utils/trpc', () => {
  const query = (key: string) => ({
    useQuery: () => {
      if (key === 'health.dataPath') return { data: mocks.dataPath, error: null }
      if (key === 'health.history') return { data: mocks.history, error: null, isLoading: false }
      return { data: undefined, error: null, isLoading: false }
    },
    useMutation: () => ({ mutate: key === 'health.restartService' ? mocks.restart : vi.fn(), mutateAsync: key === 'calibration.triggerCalibration' ? mocks.recalibrate : key === 'health.restartService' ? mocks.restartAsync : vi.fn(), isPending: false, error: null, data: undefined }),
  })
  const router = (prefix: string): unknown => new Proxy({}, {
    get: (_t, k: string) => (k === 'useQuery' || k === 'useMutation' ? query(prefix)[k] : router(prefix ? `${prefix}.${k}` : k)),
  })
  return { trpc: new Proxy({}, { get: (_t, k: string) => (k === 'useUtils' ? () => ({ health: { dataPath: { invalidate: vi.fn() } } }) : router(k)) }) }
})

import { HealthPanel } from '../HealthPanel'

function inputs(over: Partial<DataPathInputs> = {}): DataPathInputs {
  return {
    now: NOW,
    units: { 'sleepypod-piezo-processor.service': true, 'sleepypod-sleep-detector.service': true, 'sleepypod-environment-monitor.service': true },
    frameTimes: { 'piezo-dual': NOW - 1000, 'capSense2': NOW - 1000, 'bedTemp2': NOW - 1000 },
    sensorSource: 'raw',
    coreUptimeMs: 3_600_000,
    dacSocket: { ok: true, latencyMs: 2 },
    dacMonitor: { status: 'running', lastPollAt: NOW - 1000 },
    database: { ok: true, latencyMs: 1 },
    scheduler: { enabled: true, jobs: 8, healthy: true },
    occupied: { left: true, right: false },
    stillness: { left: { rows: 120, maxScore: 120 }, right: { rows: 0, maxScore: 0 } },
    lastVitalAt: { left: NOW - (3 * 60 + 56) * MIN, right: null },
    lastMovementAt: { left: NOW - MIN, right: null },
    lastEnvAt: NOW - MIN,
    thermal: [{ side: 'left', verdict: 'holding' }, { side: 'right', verdict: 'off' }],
    streamClients: 1,
    streamPort: 3001,
    ...over,
  }
}

beforeEach(() => {
  globalThis.ResizeObserver = class {
    cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb
    }

    observe() {
      this.cb([{ contentRect: { width: mocks.width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }

    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia
  mocks.width = 900
  mocks.params = new URLSearchParams('tab=health')
  mocks.dataPath = evaluateDataPath(inputs())
  mocks.history = {
    from: NOW - 24 * 60 * MIN,
    to: NOW,
    recordedSince: NOW - 24 * 60 * MIN,
    checks: [
      { id: 'piezo-processor', label: 'Piezo processor', runs: [{ status: 'ok', start: NOW - 24 * 60 * MIN, end: NOW - 236 * MIN }, { status: 'stale', start: NOW - 236 * MIN, end: NOW }], healthyShare: 0.84, incidents: 1 },
      { id: 'dac', label: 'DAC socket', runs: [{ status: 'ok', start: NOW - 24 * 60 * MIN, end: NOW }], healthyShare: 1, incidents: 0 },
    ],
    incidents: [
      { checkId: 'piezo-processor', label: 'Piezo processor', status: 'stale', start: NOW - 236 * MIN, end: null, detail: 'Left side in bed · running, but last vitals 3h 56m ago' },
    ],
    gaps: [{ start: NOW - 10 * 60 * MIN, end: NOW - 9 * 60 * MIN }],
  }
})

afterEach(() => vi.clearAllMocks())

describe('HealthPanel', () => {
  it('leads with where the chain breaks and a restart fix', () => {
    render(<HealthPanel onJump={vi.fn()} />)
    const verdict = screen.getByTestId('health-verdict')
    expect(verdict.textContent).toContain('Vitals stopped 3h 56m ago')
    fireEvent.click(within(verdict).getByRole('button', { name: /Restart piezo processor/ }))
    expect(mocks.restart).toHaveBeenCalledWith({ unit: 'sleepypod-piezo-processor.service' })
    fireEvent.click(within(verdict).getByRole('button', { name: 'Logs' }))
    expect(mocks.push).toHaveBeenCalledWith('/en/system?tab=logs&unit=sleepypod-piezo-processor.service')
  })

  it('draws the map with the stalled edge still and the upstream edge moving', () => {
    const { container } = render(<HealthPanel onJump={vi.fn()} />)
    const map = screen.getByTestId('data-path-map')
    expect(map.querySelector('[data-node="piezo-processor"]')?.getAttribute('data-status')).toBe('stale')
    const stalled = container.querySelector('[data-edge="piezo-processor-database"]')
    expect(stalled?.getAttribute('data-state')).toBe('stalled')
    expect(stalled?.querySelector('animateMotion')).toBeNull()
    expect(container.querySelector('[data-edge="frames-piezo-processor"] animateMotion')).toBeTruthy()
    expect(map.textContent).toContain('last with data')
    // The broken stage is described under the map by default.
    expect(screen.getByTestId('node-detail').textContent).toContain('where the chain breaks')
  })

  it('puts a picked stage in the URL, and picking it again clears it', () => {
    const { unmount } = render(<HealthPanel onJump={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^DAC socket:/ }))
    expect(mocks.replace).toHaveBeenLastCalledWith('/en/system?tab=health&node=dac-socket', { scroll: false })
    unmount()

    mocks.params = new URLSearchParams('tab=health&node=dac-socket')
    render(<HealthPanel onJump={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^DAC socket:/ }))
    expect(mocks.replace).toHaveBeenLastCalledWith('/en/system?tab=health', { scroll: false })
  })

  it('inspects the stage named in the URL in place of the chain-break line', () => {
    mocks.params = new URLSearchParams('tab=health&node=dac-socket')
    const { container } = render(<HealthPanel onJump={vi.fn()} />)
    expect(screen.queryByTestId('node-detail')).toBeNull()
    const inspector = screen.getByTestId('node-inspector')
    expect(inspector.textContent).toContain('DAC socket')
    expect(inspector.textContent).toContain('flowing · dac.sock · 2 ms')
    expect(inspector.textContent).not.toContain('2 ms · dac.sock')
    expect(inspector.textContent).toContain('Firmware control socket answers')
    expect(within(inspector).queryByRole('button', { name: /Raw frames/ })).toBeNull()
    fireEvent.click(within(inspector).getByRole('button', { name: 'Logs' }))
    expect(mocks.push).toHaveBeenCalledWith('/en/system?tab=logs&unit=sleepypod.service')
    // Links into the selected stage stand out; the rest recede.
    expect(container.querySelector('[data-edge="dac-dac-monitor"]')?.getAttribute('opacity')).toBe('0.6')
    expect(container.querySelector('[data-edge="sensor-piezo-frames"]')?.getAttribute('opacity')).toBe('0.6')
    expect(container.querySelector('[data-node="dac"] rect')?.getAttribute('stroke')).toBe('var(--text-1)')
    fireEvent.click(within(inspector).getByRole('button', { name: 'Close' }))
    expect(mocks.replace).toHaveBeenLastCalledWith('/en/system?tab=health', { scroll: false })
  })

  it('shows what the Live stream sends to this page, with raw frames', () => {
    mocks.params = new URLSearchParams('tab=health&node=live-stream')
    const { container } = render(<HealthPanel onJump={vi.fn()} />)
    const inspector = screen.getByTestId('node-inspector')
    expect(inspector.textContent).toContain('broadcastFrame() → WebSocket :3001 → 1 browser')
    expect(inspector.textContent).toContain('Changes made on a page go back through tRPC :3000 to the DAC socket.')
    expect(within(inspector).getByRole('button', { name: /Raw frames/ })).toBeTruthy()
    expect(within(inspector).getByTestId('stream-bedTemp').textContent).toContain('nothing in the last 60 s')
    expect(container.querySelector('[data-edge="frames-out-live"]')?.getAttribute('data-into-selected')).toBe('true')
    expect(container.querySelector('[data-edge="frames-out-live"] path')?.getAttribute('stroke-width')).toBe('2.2')
    expect(screen.getByTestId('data-path-map').textContent).toContain('WS :3001 · 1 viewer')
  })

  it('lists stages top to bottom on narrow screens', () => {
    mocks.width = 380
    render(<HealthPanel onJump={vi.fn()} />)
    expect(screen.queryByTestId('data-path-map')).toBeNull()
    expect(within(screen.getByTestId('data-path-list')).getByText('Piezo processor')).toBeTruthy()
  })

  it('asks whether anyone is there and runs the fix for the answer', async () => {
    mocks.dataPath = evaluateDataPath(inputs({ stillness: { left: { rows: 120, maxScore: 0 }, right: { rows: 0, maxScore: 0 } } }))
    render(<HealthPanel onJump={vi.fn()} />)
    const verdict = screen.getByTestId('health-verdict')
    expect(verdict.textContent).toContain('Is anyone there?')
    expect(verdict.textContent).toContain('Is anyone on Left’s side right now?')
    fireEvent.click(within(verdict).getByRole('button', { name: 'No — recalibrate empty bed' }))
    await waitFor(() => expect(mocks.recalibrate).toHaveBeenCalledWith({ side: 'left', sensorType: 'capacitance' }))
    fireEvent.click(within(verdict).getByRole('button', { name: 'Yes — restart piezo processor' }))
    await waitFor(() => expect(mocks.restartAsync).toHaveBeenCalledWith({ unit: 'sleepypod-piezo-processor.service' }))
  })

  it('says everything is flowing when it is', () => {
    mocks.dataPath = evaluateDataPath(inputs({ lastVitalAt: { left: NOW - MIN, right: null } }))
    render(<HealthPanel onJump={vi.fn()} />)
    expect(screen.getByTestId('health-verdict').textContent).toContain('Data is flowing from the sensors to every output')
  })

  it('lists incidents and unrecorded time in words', () => {
    render(<HealthPanel onJump={vi.fn()} />)
    const list = screen.getByTestId('incidents')
    expect(list.textContent).toContain('Piezo processor stalled')
    expect(list.textContent).toContain('ongoing')
    expect(list.textContent).toContain('Not recorded')
    expect(screen.getByTestId('history-piezo-processor').textContent).toContain('1×')
    expect(screen.getByTestId('health-history').textContent).toContain('Each check sampled once a minute. Recording started')
  })

  it('condenses the day: identical checks share a row, quiet ones fold away, incidents merge', () => {
    const day = NOW - 24 * 60 * MIN
    const stalled = [{ status: 'ok', start: day, end: NOW - 60 * MIN }, { status: 'stale', start: NOW - 60 * MIN, end: NOW - 30 * MIN }, { status: 'ok', start: NOW - 30 * MIN, end: NOW }]
    const clean = [{ status: 'ok', start: day, end: NOW }]
    const incident = (checkId: string, label: string, start: number, detail: string | null) => ({ checkId, label, status: 'stale', start, end: start + 10 * MIN, detail })
    mocks.history = {
      from: day,
      to: NOW,
      recordedSince: day,
      checks: [
        { id: 'sleep-detector', label: 'Sleep detector', runs: stalled, healthyShare: 0.9, incidents: 4 },
        { id: 'out-sleep', label: 'Sessions', runs: stalled, healthyShare: 0.9, incidents: 4 },
        { id: 'dac', label: 'DAC socket', runs: clean, healthyShare: 1, incidents: 0 },
        { id: 'database', label: 'Database', runs: clean, healthyShare: 1, incidents: 0 },
        { id: 'scheduler', label: 'Scheduler', runs: [{ status: 'idle', start: day, end: NOW }], healthyShare: 1, incidents: 0 },
      ],
      incidents: [
        incident('sleep-detector', 'Sleep detector', NOW - 60 * MIN, 'Left side reads occupied'),
        incident('out-sleep', 'Sleep sessions', NOW - 60 * MIN, 'Holding a session open'),
        incident('sleep-detector', 'Sleep detector', NOW - 120 * MIN, null),
        incident('sleep-detector', 'Sleep detector', NOW - 180 * MIN, null),
        incident('sleep-detector', 'Sleep detector', NOW - 240 * MIN, null),
        incident('sleep-detector', 'Sleep detector', NOW - 300 * MIN, null),
      ],
      gaps: [],
    }
    render(<HealthPanel onJump={vi.fn()} />)
    expect(screen.getByTestId('history-sleep-detector+out-sleep').textContent).toContain('Sleep detector · Sessions')
    const rest = screen.getByTestId('history-rest')
    expect(rest.textContent).toContain('3 other checks')
    expect(screen.queryByTestId('history-dac')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show all 5 checks' }))
    expect(screen.getByTestId('history-dac')).toBeTruthy()
    expect(screen.queryByTestId('history-rest')).toBeNull()

    const list = screen.getByTestId('incidents')
    expect(list.textContent).toContain('Sleep detector and Sleep sessions stalled')
    expect(list.textContent).toContain('Left side reads occupied')
    expect(list.textContent).not.toContain('Holding a session open')
    expect(within(list).getAllByText(/stalled$/)).toHaveLength(3)
    fireEvent.click(within(list).getByRole('button', { name: 'Show 2 earlier' }))
    expect(within(list).getAllByText(/stalled$/)).toHaveLength(5)
  })

  it('leaves the vibration test to System → Hardware', () => {
    render(<HealthPanel onJump={vi.fn()} />)
    expect(screen.queryByText('Test vibration')).toBeNull()
  })
})

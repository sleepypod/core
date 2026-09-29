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
  width: 900,
}))

vi.mock('next/navigation', () => ({ usePathname: () => '/en/system', useRouter: () => ({ push: mocks.push }) }))
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

  it('shows a node’s detail when it is picked on the map', () => {
    render(<HealthPanel onJump={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^DAC socket:/ }))
    expect(screen.getByTestId('node-detail').textContent).toContain('Firmware control socket answers')
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
  })

  it('leaves the vibration test to System → Hardware', () => {
    render(<HealthPanel onJump={vi.fn()} />)
    expect(screen.queryByText('Test vibration')).toBeNull()
  })
})

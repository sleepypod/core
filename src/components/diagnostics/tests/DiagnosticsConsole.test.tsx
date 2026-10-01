import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CurveChartModule from '@/src/components/Schedule/CurveChart'

const mocks = vi.hoisted(() => ({
  thermal: undefined as unknown,
  scheduler: undefined as unknown,
  thermalHistory: undefined as unknown,
  maintenance: undefined as unknown,
  water: undefined as unknown,
  schedules: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  summary: undefined as unknown,
  // 8 PM local on a Monday: inside tonight's 5 PM → 9 AM window.
  nowMinute: Math.floor(new Date(2026, 8, 28, 20, 0).getTime() / 60_000),
}))

vi.mock('@/src/components/status/StatusScreen', () => ({
  useStatusSummary: () => mocks.summary,
  formatUptime: (s: number) => `${Math.floor(s / 3600)}h`,
}))
vi.mock('@/src/components/status/PumpAlertsCard', () => ({ PumpAlertsCard: () => null }))
vi.mock('@/src/components/Schedule/CurveChart', async (importOriginal) => {
  const actual = await importOriginal<typeof CurveChartModule>()
  return {
    ...actual,
    useNowMinute: () => mocks.nowMinute,
    CurveChart: ({ setPoints, bed }: { setPoints: unknown[], bed?: unknown[] }) => <div data-testid="curve" data-points={setPoints.length} data-bed={bed?.length ?? 0} />,
  }
})

vi.mock('next/navigation', () => ({ usePathname: () => '/en/system', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/src/hooks/useTemperatureUnit', () => ({ useTemperatureUnit: () => ({ unit: 'F', convert: (c: number) => c, formatTemp: String, suffix: '°F' }) }))

vi.mock('next/dynamic', () => ({
  default: () => function DynamicStub() {
    return <div data-testid="chart" />
  },
}))
vi.mock('@/src/hooks/useSide', () => ({ useSide: () => ({ side: 'left' }) }))
vi.mock('@/src/hooks/useSideNames', () => ({
  useSideNames: () => ({ leftName: 'Jon', rightName: 'Right', sideName: (s: 'left' | 'right') => (s === 'left' ? 'Jon' : 'Right') }),
}))
vi.mock('@/src/hooks/useWeekNavigator', () => ({ useWeekNavigator: () => ({ weekStart: new Date(0), weekEnd: new Date(1) }) }))
vi.mock('@/src/hooks/useTrendBuffer', () => ({ useTrendBuffer: () => [] }))
vi.mock('@/src/components/status/SystemInfoCard', () => ({ SystemInfoCard: () => null }))
vi.mock('@/src/components/status/InternetToggleCard', () => ({ InternetToggleCard: () => null }))
vi.mock('@/src/components/status/UpdateCard', () => ({ UpdateCard: () => null }))
vi.mock('@/src/utils/trpc', () => {
  const query = (key: string) => ({
    useQuery: (input?: { side?: string }) => {
      if (key === 'health.maintenance') return { data: mocks.maintenance }
      if (key === 'health.system') return { data: { scheduler: { drift: { drifted: false } } } }
      if (key === 'waterLevel.getLatest') return { data: mocks.water }
      if (key === 'schedules.getAll') return { data: mocks.schedules[input?.side ?? ''] }
      if (key === 'health.thermal') return { data: mocks.thermal, isLoading: false, isFetching: false, error: null, dataUpdatedAt: 1 }
      if (key === 'health.scheduler') return { data: mocks.scheduler, isLoading: false }
      if (key === 'health.thermalHistory') return { data: mocks.thermalHistory, isLoading: false, error: null }
      return { data: undefined, isLoading: false, isFetching: false, error: null }
    },
    useMutation: () => {
      mocks.mutations[key] ??= vi.fn()
      return { mutate: mocks.mutations[key], isPending: false, error: null }
    },
  })
  const router = (prefix: string): unknown => new Proxy({}, {
    get: (_t, k: string) => (k === 'useQuery' || k === 'useMutation' ? query(prefix)[k] : router(prefix ? `${prefix}.${k}` : k)),
  })
  return { trpc: new Proxy({}, { get: (_t, k: string) => (k === 'useUtils' ? () => new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) }) : router(k)) }) }
})

import { DiagnosticsConsole } from '../DiagnosticsConsole'

const side = (s: 'left' | 'right', over: Record<string, unknown> = {}) => ({
  side: s,
  verdict: 'delivering',
  isPowered: true,
  targetTempF: 76,
  currentTempF: 80.1,
  pumpRpm: 2410,
  readingAgeSec: 2,
  waterTempF: 78.1,
  bedSurfaceTempF: 79.6,
  guardBlocked: false,
  isAlarmVibrating: false,
  poweredOnAt: null,
  note: null,
  ...over,
})

beforeEach(() => {
  mocks.thermal = {
    pumpStallProtectionEnabled: true,
    heatsinkTempF: 94.2,
    ambientTempF: 76,
    sides: [side('left'), side('right', { targetTempF: 82, currentTempF: 81 })],
  }
  mocks.scheduler = {
    enabled: true,
    healthy: true,
    jobCounts: { total: 42 },
    upcomingJobs: [
      { id: 'a', type: 'temperature', side: 'left', nextRun: new Date(Date.now() + 3_600_000).toISOString(), targetTempF: 79 },
      { id: 'b', type: 'power_off', side: 'both', nextRun: new Date(Date.now() + 7_200_000).toISOString() },
    ],
  }
})

const summary = (over: Record<string, unknown> = {}) => ({
  healthy: 12,
  total: 12,
  groups: {
    core: [{ name: 'Database', value: '2 ms', status: 'ok' }],
    network: [{ name: 'Wi-Fi', value: 'home · 80%', status: 'ok' }],
  },
  podName: 'Pod 5',
  version: { branch: 'dev', commitHash: 'da5b3c1aaaa' },
  wifi: { connected: true, ssid: 'home', signal: 80 },
  internetBlocked: true,
  firewall: { ok: true, missing: [] },
  diskPercent: 80.4,
  uptimeSeconds: 7200,
  ...over,
})

describe('DiagnosticsConsole dashboard', () => {
  const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 8, 28 + dayOffset, h, m).toISOString()

  beforeEach(() => {
    mocks.summary = summary()
    mocks.maintenance = { pumpStallProtectionEnabled: true, primePodDaily: true, primePodTime: '14:00', lastPrimeAt: null, firstPrimeRecordedAt: null }
    mocks.water = { level: 'ok' }
    mocks.mutations = {}
    mocks.schedules = {
      left: { temperature: [
        { dayOfWeek: 'monday', time: '23:15', temperature: 80, enabled: true },
        { dayOfWeek: 'monday', time: '07:00', temperature: 85, enabled: true },
      ] },
      right: { temperature: [] },
    }
    mocks.scheduler = {
      enabled: true,
      healthy: true,
      jobCounts: { total: 42 },
      upcomingJobs: [
        { id: 't1', type: 'temperature', side: 'left', nextRun: at(23, 15), targetTempF: 80, brightness: null },
        { id: 'l1', type: 'led_brightness', side: undefined, nextRun: at(22, 0), targetTempF: null, brightness: 2 },
        { id: 'r1', type: 'reboot', side: undefined, nextRun: at(3, 0, 1), targetTempF: null, brightness: null },
        { id: 'p1', type: 'prime', side: undefined, nextRun: at(14, 0, 1), targetTempF: null, brightness: null },
      ],
    }
  })

  it('shows a one-line status with the named facts', () => {
    render(<DiagnosticsConsole section="dashboard" onJump={vi.fn()} />)
    const line = screen.getByTestId('status-line')
    expect(within(line).getByText('Pod 5 is healthy')).toBeTruthy()
    expect(within(line).getByText('dev')).toBeTruthy()
    expect(within(line).getByText('da5b3c1')).toBeTruthy()
    expect(within(line).getByText('Blocked')).toBeTruthy()
    expect(within(line).getByText('80% used')).toBeTruthy()
  })

  it('shows the firewall status, naming a missing rule', () => {
    const { unmount } = render(<DiagnosticsConsole section="dashboard" onJump={vi.fn()} />)
    expect(within(screen.getByTestId('status-line')).getByText('In place')).toBeTruthy()
    unmount()
    mocks.summary = summary({ firewall: { ok: false, missing: ['block-wan'] } })
    render(<DiagnosticsConsole section="dashboard" onJump={vi.fn()} />)
    const fact = within(screen.getByTestId('status-line')).getByText('Missing block-wan')
    expect(fact.closest('[title]')?.getAttribute('title')).toBe('Missing firewall rules: block-wan')
  })

  it('counts failing checks and names them', () => {
    mocks.summary = summary({ healthy: 11, groups: { core: [{ name: 'Database', value: '2 ms', status: 'ok' }], network: [{ name: 'Wi-Fi', value: 'offline', status: 'degraded' }] } })
    render(<DiagnosticsConsole section="dashboard" onJump={vi.fn()} />)
    expect(screen.getByText('11 of 12 checks passing')).toBeTruthy()
    // Once as the Wi-Fi fact label, once in the list of failing checks.
    expect(within(screen.getByTestId('status-line')).getAllByText('Wi-Fi')).toHaveLength(2)
  })

  it('hides the attention card when nothing needs action', () => {
    render(<DiagnosticsConsole section="dashboard" onJump={vi.fn()} />)
    expect(screen.queryByTestId('attention')).toBeNull()
  })

  it('offers to turn on pump-stall protection and start a prime', () => {
    mocks.maintenance = { pumpStallProtectionEnabled: false, primePodDaily: false, primePodTime: null, lastPrimeAt: new Date(2026, 8, 10).getTime(), firstPrimeRecordedAt: null }
    render(<DiagnosticsConsole section="dashboard" onJump={vi.fn()} />)
    const card = screen.getByTestId('attention')
    expect(within(card).getByText('Pump-stall protection is off')).toBeTruthy()
    expect(within(card).getByText('No prime in the last 7 days')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Turn on' }))
    expect(mocks.mutations['settings.updateDevice']).toHaveBeenCalledWith({ pumpStallProtectionEnabled: true })
    fireEvent.click(within(card).getByRole('button', { name: 'Start prime' }))
    expect(mocks.mutations['device.startPriming']).toHaveBeenCalledWith({})
  })

  it('plans tonight with curves per side, the bed so far, pod job markers and a now line', () => {
    const now = mocks.nowMinute * 60_000
    mocks.thermalHistory = {
      range: '24h',
      from: now - 86_400_000,
      to: now,
      bucketSec: 240,
      // One sample inside tonight's window, one from yesterday afternoon that is not.
      points: [
        { t: now - 20 * 3_600_000, leftBed: 79, rightBed: null, leftTarget: 80, rightTarget: null, leftWater: null, rightWater: null, leftSurface: null, rightSurface: null, leftRpm: null, rightRpm: null, heatsink: null, ambient: null },
        { t: now - 60_000, leftBed: 78.9, rightBed: null, leftTarget: 80, rightTarget: null, leftWater: null, rightWater: null, leftSurface: null, rightSurface: null, leftRpm: null, rightRpm: null, heatsink: null, ambient: null },
      ],
      powerOn: [],
      available: { bedTarget: true, water: false, surface: false, pump: false, hub: false },
      bedTargetSince: now - 86_400_000,
    }
    const onJump = vi.fn()
    render(<DiagnosticsConsole section="dashboard" onJump={onJump} />)
    const tonight = screen.getByTestId('tonight')
    expect(within(tonight).getByText(/next: Jon → 80°F at/)).toBeTruthy()
    expect(within(tonight).getByText(/in 3h 15m/)).toBeTruthy()
    expect(within(tonight).getByText('in sync · 42 jobs')).toBeTruthy()
    expect(within(tonight).getByTestId('curve-legend')).toBeTruthy()
    const leftCurve = within(screen.getByTestId('tonight-left')).getByTestId('curve')
    expect(leftCurve.getAttribute('data-points')).toBe('2')
    // Both samples are handed over; the chart clips to its window.
    expect(leftCurve.getAttribute('data-bed')).toBe('2')
    expect(within(screen.getByTestId('tonight-right')).queryByTestId('curve')).toBeNull()
    const pod = screen.getByTestId('tonight-pod')
    expect(within(pod).getByText('LED 2%')).toBeTruthy()
    expect(within(pod).getByText('Reboot')).toBeTruthy()
    // Tomorrow's 2 PM prime is outside the 5 PM → 9 AM window.
    expect(within(pod).queryByText('Prime')).toBeNull()
    expect(screen.getByTestId('tonight-now')).toBeTruthy()
    fireEvent.click(within(tonight).getByRole('button', { name: /Scheduler/ }))
    expect(onJump).toHaveBeenCalledWith('scheduler')
  })

  it('shares one hover across the Tonight lanes with each side\u2019s target and bed', () => {
    render(<DiagnosticsConsole section="dashboard" onJump={vi.fn()} />)
    const lanes = screen.getByTestId('tonight-lanes')
    vi.spyOn(lanes, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 1096, height: 200, right: 1096, bottom: 200, toJSON: () => ({}) })
    // Window is 5 PM \u2192 9 AM (16 h); 2 AM is 9 h in, past the 96px label column.
    fireEvent.pointerMove(lanes, { clientX: 96 + 1000 * 9 / 16, clientY: 40 })
    const hover = screen.getByTestId('tonight-hover')
    expect(hover.textContent).toMatch(/^2:00\sAM \u00b7 target \/ bedJon80\u00b0 \/ \u2014Right\u2014 \/ \u2014$/)
    fireEvent.pointerLeave(lanes)
    expect(screen.queryByTestId('tonight-hover')).toBeNull()
  })

  it('shows compact side cards with the holding status', () => {
    mocks.thermal = { ...(mocks.thermal as object), sides: [side('left', { verdict: 'holding', targetTempF: 80, currentTempF: 80 }), side('right', { verdict: 'stalled', note: 'pump stalled' })] }
    const onJump = vi.fn()
    render(<DiagnosticsConsole section="dashboard" onJump={onJump} />)
    const left = screen.getByTestId('side-left')
    expect(within(left).getByText('Jon · left')).toBeTruthy()
    expect(within(left).getByText('HOLDING')).toBeTruthy()
    expect(within(screen.getByTestId('side-right')).getByText('pump stalled')).toBeTruthy()
    fireEvent.click(left)
    expect(onJump).toHaveBeenCalledWith('thermal')
  })

  it('reads out the bed temperature under the pointer on a side card sparkline', () => {
    const now = mocks.nowMinute * 60_000
    const point = (t: number, leftBed: number | null) => ({
      t, leftBed, rightBed: null, leftTarget: 80, rightTarget: null, leftWater: null, rightWater: null,
      leftSurface: null, rightSurface: null, leftRpm: null, rightRpm: null, heatsink: null, ambient: null,
    })
    mocks.thermalHistory = {
      range: '12h', from: now - 12 * 3_600_000, to: now, bucketSec: 120,
      points: [point(now - 6 * 3_600_000, 78.4), point(now - 60_000, 80.1)],
      powerOn: [], available: { bedTarget: true, water: false, surface: false, pump: false, hub: false }, bedTargetSince: null,
    }
    render(<DiagnosticsConsole section="dashboard" onJump={vi.fn()} />)
    const box = within(screen.getByTestId('side-left')).getByLabelText('Jon last 12 hours').parentElement as HTMLElement
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 600, height: 40, right: 600, bottom: 40, toJSON: () => ({}) })
    // Halfway across 12 h is 6 h ago, where a sample sits; the far left has none within reach.
    fireEvent.pointerMove(box, { clientX: 300, clientY: 10 })
    expect(screen.getByTestId('chart-hover').textContent).toMatch(/· 78\.4/)
    fireEvent.pointerMove(box, { clientX: 30, clientY: 10 })
    expect(screen.getByTestId('chart-hover').textContent).toMatch(/· —$/)
    fireEvent.pointerLeave(box)
    expect(screen.queryByTestId('chart-hover')).toBeNull()
  })
})

describe('DiagnosticsConsole calibration', () => {
  it('shows a row per sensor with Recalibrate as a secondary action', () => {
    render(<DiagnosticsConsole section="calibration" onJump={vi.fn()} />)
    for (const t of ['piezo', 'capacitance', 'temperature']) {
      const row = screen.getByTestId(`cal-${t}`)
      expect(within(row).getByRole('meter', { name: 'Calibration validity left' })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: /Calibrate all/ })).toBeTruthy()
    expect(screen.getByText('waiting for left piezo…')).toBeTruthy()
  })

  it('leaves the vibration test off Health (it lives on System → Hardware)', () => {
    render(<DiagnosticsConsole section="health" onJump={vi.fn()} />)
    expect(screen.queryByText('Test vibration')).toBeNull()
  })
})

describe('DiagnosticsConsole thermal history', () => {
  const now = Date.now()
  const point = (t: number, over: Record<string, number | null> = {}) => ({
    t, leftBed: 80, rightBed: 78, leftTarget: 80, rightTarget: 80, leftWater: 78.7, rightWater: 78.1,
    leftSurface: 78.9, rightSurface: 77.1, leftRpm: 1947, rightRpm: 2207, heatsink: 75.6, ambient: 76.6, ...over,
  })

  beforeEach(() => {
    mocks.thermalHistory = {
      range: '12h',
      from: now - 12 * 3_600_000,
      to: now,
      bucketSec: 120,
      points: [point(now - 3_600_000, { rightRpm: 0 }), point(now - 60_000)],
      powerOn: [{ side: 'right', at: now - 1_800_000 }],
      available: { bedTarget: true, water: true, surface: true, pump: true, hub: true },
      bedTargetSince: now - 86_400_000,
    }
  })

  it('shows the 12 h chart with a power-on marker and latest values by default', () => {
    mocks.thermal = { ...(mocks.thermal as object), pumpStallProtectionEnabled: false }
    render(<DiagnosticsConsole section="thermal" onJump={vi.fn()} />)
    expect(screen.getByText('Last 12 hours')).toBeTruthy()
    expect(screen.getByText('Right on')).toBeTruthy()
    expect(screen.getByText('2,207')).toBeTruthy()
    const warn = screen.getByRole('link', { name: /Pump-stall protection off/ })
    expect(warn.getAttribute('href')).toBe('/en/settings?section=device')
  })

  it('hides the warning when protection is on', () => {
    render(<DiagnosticsConsole section="thermal" onJump={vi.fn()} />)
    expect(screen.queryByText('Pump-stall protection off')).toBeNull()
  })

  it('reads out the hovered moment through a crosshair', () => {
    render(<DiagnosticsConsole section="thermal" onJump={vi.fn()} />)
    const plot = screen.getByTestId('thermal-plot')
    plot.getBoundingClientRect = () => ({ left: 0, width: 1200, top: 0, height: 100, right: 1200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerMove(plot, { clientX: 1100 })
    expect(screen.getByTestId('thermal-crosshair')).toBeTruthy()
    expect(screen.getAllByText('0').length).toBeGreaterThan(0)
  })

  it('says why a panel is empty instead of drawing it', () => {
    mocks.thermalHistory = { ...(mocks.thermalHistory as object), available: { bedTarget: false, water: true, surface: true, pump: true, hub: true }, bedTargetSince: null }
    render(<DiagnosticsConsole section="thermal" onJump={vi.fn()} />)
    expect(screen.getByText('bed and target history starts recording with this update')).toBeTruthy()
  })
})

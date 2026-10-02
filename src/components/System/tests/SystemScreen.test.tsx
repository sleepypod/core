import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
  streamEnabled: [] as boolean[],
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => mocks.params,
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => '/en/system',
}))
vi.mock('next/dynamic', () => ({
  default: () => function DynamicStub() {
    return <div data-testid="dynamic-tab" />
  },
}))
vi.mock('@/src/hooks/useSensorStream', () => ({
  useSensorStream: ({ enabled }: { enabled: boolean }) => {
    mocks.streamEnabled.push(enabled)
    return {
      status: 'connected',
      fps: 30,
      lastError: null,
      latestFrames: { capSense2: {}, bedTemp2: {}, frzHealth: {} },
      lastFrameTime: null,
      lastSensorTime: Date.now(),
    }
  },
}))
vi.mock('@/src/components/Sensors/SensorsScreen', () => ({
  SensorsScreen: ({ streamEnabled }: { streamEnabled: boolean }) => <div data-testid="sensors-tab">{String(streamEnabled)}</div>,
}))
vi.mock('@/src/components/PullToRefresh/PullToRefresh', () => ({
  PullToRefresh: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { SystemScreen, resolveSystemTab } from '../SystemScreen'

beforeEach(() => {
  mocks.params = new URLSearchParams()
  mocks.replace.mockClear()
  mocks.streamEnabled = []
})

describe('resolveSystemTab', () => {
  it('defaults to the Dashboard for missing or unknown tabs', () => {
    expect(resolveSystemTab(null)).toBe('dashboard')
    expect(resolveSystemTab('nope')).toBe('dashboard')
  })

  it('resolves every tab', () => {
    for (const t of ['calibration', 'health', 'logs', 'scheduler', 'sensors', 'storage', 'thermal']) {
      expect(resolveSystemTab(t)).toBe(t)
    }
  })

  it('opens Health for old Pipeline links', () => {
    expect(resolveSystemTab('pipeline')).toBe('health')
  })

  it('maps legacy ?tab=diagnostics&section= links onto the flat tabs', () => {
    expect(resolveSystemTab('diagnostics', 'thermal')).toBe('thermal')
    expect(resolveSystemTab('diagnostics', 'sensors')).toBe('sensors')
    expect(resolveSystemTab('diagnostics', 'overview')).toBe('dashboard')
    expect(resolveSystemTab('diagnostics', null)).toBe('dashboard')
  })
})

describe('SystemScreen', () => {
  it('lists Dashboard first then the rest A–Z, with Dashboard selected by default', () => {
    render(<SystemScreen />)
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Dashboard', 'Calibration', 'Databases', 'Hardware', 'Health', 'Logs', 'Scheduler', 'Sensors', 'Storage', 'Thermal'])
    expect(screen.getByRole('tab', { name: 'Dashboard' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('dynamic-tab')).toBeTruthy()
    expect(document.title).toBe('Dashboard · System · sleepypod')
  })

  it('gives Hardware and Databases their own pages and titles', () => {
    mocks.params = new URLSearchParams('tab=hardware')
    const { unmount } = render(<SystemScreen />)
    expect(screen.getByRole('tab', { name: 'Hardware' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('dynamic-tab')).toBeTruthy()
    expect(document.title).toBe('Hardware · System · sleepypod')
    unmount()
    mocks.params = new URLSearchParams('tab=databases')
    render(<SystemScreen />)
    expect(document.title).toBe('Databases · System · sleepypod')
  })

  it('sends old biometrics links to Sleep → Biometrics', () => {
    mocks.params = new URLSearchParams('tab=diagnostics&section=biometrics')
    render(<SystemScreen />)
    expect(mocks.replace).toHaveBeenCalledWith('/en/sleep?view=biometrics')
  })

  it('sends old Pipeline links to Health with the Live stream stage open', () => {
    mocks.params = new URLSearchParams('tab=pipeline')
    render(<SystemScreen />)
    expect(screen.queryByRole('tab', { name: 'Pipeline' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Health' }).getAttribute('aria-selected')).toBe('true')
    expect(mocks.replace).toHaveBeenCalledWith('/en/system?tab=health&node=live-stream', { scroll: false })
  })

  it('reads legacy diagnostics links and writes flat tab changes to the URL', () => {
    mocks.params = new URLSearchParams('foo=1&tab=diagnostics&section=thermal')
    render(<SystemScreen />)
    expect(screen.getByRole('tab', { name: 'Thermal' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('tab', { name: 'Sensors' }))
    expect(mocks.replace).toHaveBeenLastCalledWith('/en/system?foo=1&tab=sensors', { scroll: false })
    fireEvent.click(screen.getByRole('tab', { name: 'Dashboard' }))
    expect(mocks.replace).toHaveBeenLastCalledWith('/en/system?foo=1', { scroll: false })
  })

  it('shows live stream stats and Stop pauses the stream', () => {
    mocks.params = new URLSearchParams('tab=sensors')
    render(<SystemScreen />)
    expect(screen.getByTestId('stream-status').textContent).toContain('LIVE')
    expect(screen.getByText('30 fps')).toBeTruthy()
    expect(screen.getByText('3 sensors')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(mocks.streamEnabled.at(-1)).toBe(false)
    expect(screen.getByTestId('stream-status').textContent).toBe('PAUSED')
    expect(screen.getByTestId('sensors-tab').textContent).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(mocks.streamEnabled.at(-1)).toBe(true)
  })
})

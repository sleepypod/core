import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../AppShell'
import { Sidebar } from '../Sidebar'
import { TabBar } from '../TabBar'
import { activeNavId, langFromPath, pathWithoutLang } from '../navItems'

const state = vi.hoisted(() => ({
  path: '/en', query: '', active: true,
  status: undefined as unknown, health: undefined as unknown,
  version: undefined as unknown, water: undefined as unknown,
  start: vi.fn(), end: vi.fn(),
}))
vi.mock('next/navigation', () => ({ usePathname: () => state.path, useSearchParams: () => new URLSearchParams(state.query) }))
vi.mock('@/src/hooks/useScheduleActive', () => ({ useScheduleActive: () => ({ isActive: state.active }) }))
vi.mock('@/src/hooks/useSwipeNavigation', () => ({ useSwipeNavigation: () => ({ onTouchStart: state.start, onTouchEnd: state.end }) }))
vi.mock('@/src/components/Schedule/CurveChart', () => ({ useNowMinute: () => 29000000 }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  device: { getStatus: { useQuery: () => ({ data: state.status }) } },
  health: { system: { useQuery: () => ({ data: state.health }) }, maintenance: { useQuery: () => ({}) } },
  system: { getVersion: { useQuery: () => ({ data: state.version }) } },
  waterLevel: { getLatest: { useQuery: () => ({ data: state.water }) } },
} }))

beforeEach(() => {
  Object.assign(state, { path: '/en', query: '', active: true, status: undefined, health: undefined, version: undefined, water: undefined })
  vi.clearAllMocks()
})

describe('responsive navigation', () => {
  it.each([
    ['/de/autopilot/7', 'autopilot'], ['/en/data', 'sleep'], ['/en/status', 'system'],
    ['/en/debug', 'system'], ['/en/sensors', 'system'], ['/en/schedule', 'schedule'],
    ['/en/settings', 'settings'], ['/en/schedule-other', 'temp'], [null, 'temp'],
  ])('resolves %s without matching unrelated prefixes', (path, expected) => {
    expect(activeNavId(path)).toBe(expected)
    expect(langFromPath(null)).toBe('en')
    expect(pathWithoutLang('/de')).toBe('/')
  })
  it.each([
    ['/de/settings', 'section=appearance', 'Appearance', '/de/settings?section=appearance'],
    ['/de/system', 'tab=health', 'Health', '/de/system?tab=health'],
    ['/de/sleep', 'view=biometrics', 'Biometrics', '/de/sleep?view=biometrics'],
    ['/de/autopilot', 'view=diagnostics', 'Diagnostics', '/de/autopilot?view=diagnostics'],
  ])('expands and selects the current subtree for %s', (path, query, label, href) => {
    Object.assign(state, { path, query })
    render(<Sidebar />)
    const link = screen.getByRole('link', { name: label })
    expect(link.getAttribute('href')).toBe(href)
    expect(link.getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('rel')).toBe('noopener noreferrer')
  })
  it('shows pod model, development branch and actionable water warning', () => {
    Object.assign(state, { path: '/en/system', status: { podVersion: 'J00' }, water: { level: 'low' }, version: { commitHash: 'abcdef1234', branch: 'feat/ui-redesign' } })
    state.health = { status: 'ok', database: { status: 'ok' }, scheduler: {}, iptables: { ok: true } }
    render(<Sidebar />)
    expect(screen.getByText('Water level is low')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open System dashboard/ }).getAttribute('title')).toBe('Water level is low')
    expect(screen.getByText('DEV')).toBeTruthy()
    expect(screen.getByTestId('footer-branch').textContent).toBe('feat/ui-redesign')
    expect(screen.getByRole('link', { name: /Open System dashboard/ }).textContent).toContain('Pod 5')
  })
  it('shows release versions and preserves an unknown model name', () => {
    state.status = { podVersion: 'Future pod' }
    state.version = { version: 'v1.2.3', commitHash: 'unknown' }
    render(<Sidebar />)
    expect(screen.getByText('v1.2.3')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open System dashboard/ }).textContent).toContain('Future pod')
    expect(screen.queryByText('DEV')).toBeNull()
  })
  it('links phone tabs in the current language and highlights legacy routes', () => {
    state.path = '/fr/data'
    const { rerender } = render(<TabBar />)
    expect(screen.getByRole('link', { name: 'SLEEP' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'TEMP' }).getAttribute('href')).toBe('/fr')
    state.active = false
    rerender(<TabBar />)
    expect(screen.getAllByRole('link')).toHaveLength(6)
  })
  it('renders page content and forwards swipe gestures', () => {
    render(<AppShell><h1>Temperature</h1></AppShell>)
    fireEvent.touchStart(screen.getByRole('main'))
    fireEvent.touchEnd(screen.getByRole('main'))
    expect(state.start).toHaveBeenCalledOnce()
    expect(state.end).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'Temperature' })).toBeTruthy()
  })
})

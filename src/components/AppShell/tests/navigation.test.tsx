import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../AppShell'
import { Sidebar } from '../Sidebar'
import { TabBar } from '../TabBar'
import { MobileToolbar } from '../MobileToolbar'
import { activeNavId, langFromPath, pathWithoutLang } from '../navItems'

const state = vi.hoisted(() => ({
  path: '/en', query: '', active: true, base: undefined as { configured: boolean } | undefined,
  status: undefined as unknown, health: undefined as unknown,
  version: undefined as unknown, water: undefined as unknown,
  start: vi.fn(), end: vi.fn(),
}))
vi.mock('next/navigation', () => ({ usePathname: () => state.path, useSearchParams: () => new URLSearchParams(state.query) }))
vi.mock('@/src/hooks/useScheduleActive', () => ({ useScheduleActive: () => ({ isActive: state.active }) }))
vi.mock('@/src/hooks/useSwipeNavigation', () => ({ useSwipeNavigation: () => ({ onTouchStart: state.start, onTouchEnd: state.end }) }))
vi.mock('@/src/components/Schedule/CurveChart', () => ({ useNowMinute: () => 29000000 }))
vi.mock('../NotificationInbox', () => ({ NotificationInbox: () => <button>Alerts</button> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  base: { getAvailability: { useQuery: () => ({ data: state.base }) } },
  device: { getStatus: { useQuery: () => ({ data: state.status }) } },
  health: { system: { useQuery: () => ({ data: state.health }) }, maintenance: { useQuery: () => ({}) } },
  system: { getVersion: { useQuery: () => ({ data: state.version }) } },
  waterLevel: { getLatest: { useQuery: () => ({ data: state.water }) } },
} }))

beforeEach(() => {
  Object.assign(state, { path: '/en', query: '', active: true, status: undefined, health: undefined, version: undefined, water: undefined, base: undefined })
  vi.clearAllMocks()
})

describe('responsive navigation', () => {
  it.each([
    ['/fr/base', 'base'], ['/de/autopilot/7', 'autopilot'], ['/en/data', 'sleep'], ['/en/status', 'system'],
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
  it('keeps the three phone destinations stable as base availability changes', () => {
    state.path = '/fr/schedule'
    const { rerender } = render(<TabBar />)
    for (const name of ['Temp', 'Schedule', 'Sleep']) expect(screen.getByRole('link', { name })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Schedule' }).getAttribute('aria-current')).toBe('page')
    state.base = { configured: true }
    rerender(<TabBar />)
    expect(screen.getAllByRole('link')).toHaveLength(3)
  })
  it('makes desktop secondary routes direct and only shows a configured base', () => {
    state.path = '/en/base'
    const { rerender } = render(<Sidebar />)
    expect(screen.queryByRole('link', { name: 'Base' })).toBeNull()
    state.base = { configured: true }
    rerender(<Sidebar />)
    expect(screen.getByRole('link', { name: 'Base' }).getAttribute('aria-current')).toBe('page')
    for (const name of ['Schedule', 'Autopilot', 'Home', 'System', 'Settings']) expect(screen.getByRole('link', { name })).toBeTruthy()
  })
  it('shows pod model and every issue in full, with build info behind the DEV chip', () => {
    Object.assign(state, { path: '/en/system', status: { podVersion: 'J00' }, water: { level: 'low' }, version: { commitHash: 'abcdef1234', branch: 'feat/ui-redesign' } })
    state.health = { status: 'ok', database: { status: 'ok' }, scheduler: { drift: { drifted: true } }, iptables: { ok: true } }
    render(<Sidebar />)
    const footer = screen.getByRole('link', { name: /Open System dashboard/ })
    expect(footer.textContent).toContain('Pod 5')
    expect(footer.textContent).toContain('2 issues')
    expect(within(screen.getByTestId('footer-issues')).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Scheduler drifted', 'Water level is low'])
    expect(footer.textContent).not.toContain('feat/ui-redesign')

    const chip = screen.getByRole('button', { name: 'Build details' })
    expect(chip.textContent).toBe('DEV')
    expect(screen.queryByTestId('build-details')).toBeNull()
    fireEvent.click(chip)
    const details = screen.getByTestId('build-details').textContent
    expect(details).toContain('feat/ui-redesign')
    expect(details).toContain('abcdef1')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('build-details')).toBeNull()
    fireEvent.click(chip)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('build-details')).toBeNull()
  })
  it('shows release versions and preserves an unknown model name', () => {
    state.status = { podVersion: 'Future pod' }
    state.version = { version: 'v1.2.3', commitHash: 'unknown' }
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Build details' }))
    expect(screen.getByTestId('build-details').textContent).toContain('v1.2.3')
    expect(screen.queryByTestId('footer-issues')).toBeNull()
    expect(screen.getByRole('link', { name: /Open System dashboard/ }).textContent).toContain('Future pod')
    expect(screen.queryByText('DEV')).toBeNull()
  })
  it('links phone tabs in the current language and highlights legacy routes', () => {
    state.path = '/fr/data'
    const { rerender } = render(<TabBar />)
    expect(screen.getByRole('link', { name: 'Sleep' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Temp' }).getAttribute('href')).toBe('/fr')
    state.active = false
    rerender(<TabBar />)
    expect(screen.getAllByRole('link')).toHaveLength(3)
  })
  it('keeps phone settings reachable and announces a health warning', () => {
    state.path = '/fr/schedule'
    const { rerender } = render(<MobileToolbar />)
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/fr/settings')
    expect(screen.queryByTestId('system-health-dot')).toBeNull()
    state.health = { status: 'ok', database: { status: 'ok' }, scheduler: {}, iptables: { ok: true } }
    state.water = { level: 'low' }
    rerender(<MobileToolbar />)
    expect(screen.getByTestId('system-health-dot')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Settings, 1 issue' })).toBeTruthy()
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

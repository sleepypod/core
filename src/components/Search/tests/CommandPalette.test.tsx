import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '@/src/components/ds'
import { SidebarSearch } from '../CommandPalette'
import { DOCS_BASE, DOCS_INDEX_URL, resetLiveDocsIndex } from '../docsIndex'

const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

const i18n = setupI18n({ locale: 'en', messages: { en: {} } })
i18n.activate('en')
const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>

function view(props: { lang?: string, hasBase?: boolean } = {}) {
  return render(<SidebarSearch lang={props.lang ?? 'en'} hasBase={props.hasBase ?? false} />, { wrapper })
}

const input = () => screen.getByRole('combobox', { name: 'Search pages and settings' })
const selected = () => screen.getAllByRole('option').find(o => o.getAttribute('aria-selected') === 'true')

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  router.push.mockClear()
  resetLiveDocsIndex()
  fetchMock.mockReset().mockRejectedValue(new TypeError('offline'))
  vi.stubGlobal('fetch', fetchMock)
  return () => vi.unstubAllGlobals()
})

const docsPage = (title: string) => ({ path: '/live/', title, section: 'Core', description: '', headings: [], keywords: '' })
const respond = (body: unknown) => fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))

function openPalette(query?: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  if (query !== undefined) fireEvent.change(input(), { target: { value: query } })
}

describe('SidebarSearch', () => {
  it('shows the search box with a Ctrl K hint off Apple platforms', () => {
    view()
    const button = screen.getByRole('button', { name: 'Search' })
    expect(button.textContent).toContain('Ctrl K')
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+K')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows ⌘K on a Mac', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    view()
    expect(screen.getByRole('button', { name: 'Search' }).textContent).toContain('⌘K')
    platform.mockRestore()
  })

  it.each([{ metaKey: true }, { ctrlKey: true }])('opens from anywhere with %o + K and toggles closed again', (mod) => {
    view()
    fireEvent.keyDown(document.body, { key: 'k', ...mod })
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeTruthy()
    expect(document.activeElement).toBe(input())
    fireEvent.keyDown(document.body, { key: 'K', ...mod })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not open over another open modal, so one Escape closes only that modal', () => {
    const onClose = vi.fn()
    render(
      <>
        <SidebarSearch lang="en" hasBase={false} />
        <Modal open onClose={onClose} title="Edit rule"><p>body</p></Modal>
      </>,
      { wrapper },
    )
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true })
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('ignores K without a modifier or with Shift', () => {
    view()
    fireEvent.keyDown(document.body, { key: 'k' })
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true, shiftKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists top-level pages before typing, respecting the Base filter', () => {
    const { unmount } = view()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const pages = within(screen.getByRole('listbox', { name: 'Pages' })).getAllByRole('option').map(o => o.textContent)
    expect(pages.some(p => p?.startsWith('Temp'))).toBe(true)
    expect(pages.some(p => p?.startsWith('Base'))).toBe(false)
    unmount()
    view({ hasBase: true })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(screen.getAllByRole('option').some(o => o.textContent?.startsWith('Base'))).toBe(true)
  })

  it('shows each result with its icon and breadcrumb', () => {
    view()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(input(), { target: { value: 'internet access' } })
    const first = screen.getAllByRole('option')[0]
    expect(first.textContent).toBe('Internet accessSettings › Network')
    expect(first.querySelector('svg')).not.toBeNull()
  })

  it('moves through results with the arrow keys, wrapping at both ends', () => {
    view()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(input(), { target: { value: 'led' } })
    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThan(1)
    expect(selected()).toBe(options[0])
    expect(input().getAttribute('aria-activedescendant')).toBe(options[0].id)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(selected()).toBe(options[1])
    expect(input().getAttribute('aria-activedescendant')).toBe(options[1].id)
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(selected()).toBe(options[options.length - 1])
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(selected()).toBe(options[0])
  })

  it('navigates to the selected result under the current language with Enter, then closes', () => {
    view({ lang: 'es' })
    const opener = screen.getByRole('button', { name: 'Search' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.change(input(), { target: { value: 'firewall' } })
    const first = screen.getAllByRole('option')[0]
    expect(within(first).getByText('Network')).toBeTruthy()
    expect(within(first).getByText('Settings')).toBeTruthy()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(router.push).toHaveBeenCalledWith('/es/settings?section=network')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('navigates top-level pages without a trailing slash and on click', () => {
    view({ lang: 'de' })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(router.push).toHaveBeenLastCalledWith('/de')
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(input(), { target: { value: 'biometrics' } })
    fireEvent.click(screen.getAllByRole('option')[0])
    expect(router.push).toHaveBeenLastCalledWith('/de/sleep?view=biometrics')
  })

  it('closes with Escape, resets the query and returns focus to the opener', () => {
    view()
    const opener = screen.getByRole('button', { name: 'Search' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.change(input(), { target: { value: 'zzzz' } })
    expect(screen.getByRole('status').textContent).toContain('No matches')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(router.push).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    fireEvent.click(opener)
    expect((input() as HTMLInputElement).value).toBe('')
  })

  it('keeps Tab focus inside the dialog', () => {
    view()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const close = screen.getByRole('button', { name: 'Close' })
    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(input())
    fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(input())
  })

  it('searches the bundled docs snapshot offline, with an external-link indicator', async () => {
    view()
    openPalette('troubleshooting')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const docs = screen.getAllByRole('option').filter(o => o.textContent?.includes('Docs › Troubleshooting'))
    expect(docs.length).toBeGreaterThan(0)
    expect(within(docs[0]).getByText('Opens the docs in a new tab')).toBeTruthy()
    expect(docs[0].querySelectorAll('svg')).toHaveLength(2)
  })

  it('fetches the live index without credentials and only once per page load', async () => {
    view()
    openPalette()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(fetchMock.mock.calls[0][0]).toBe(DOCS_INDEX_URL)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'omit' })
    fireEvent.keyDown(input(), { key: 'Escape' })
    openPalette()
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('leaves docs out of the empty-query page list', () => {
    view()
    openPalette()
    expect(screen.getAllByRole('option').some(o => o.textContent?.includes('Docs'))).toBe(false)
  })

  it('ranks an exact setting name above its docs page', () => {
    view()
    openPalette('Away mode')
    expect(screen.getAllByRole('option')[0].textContent).toBe('Away modeSettings › Sides')
  })

  it('uses a valid live index for the session', async () => {
    respond({ version: 1, generatedAt: '2026-10-31T00:00:00Z', base: DOCS_BASE, pages: [docsPage('Zeppelin mooring')] })
    view()
    openPalette('zeppelin')
    expect(await screen.findByRole('option', { name: /Zeppelin mooring/ })).toBeTruthy()
  })

  it('keeps the snapshot when the live payload breaks the contract', async () => {
    respond({ version: 2, generatedAt: '2026-10-31T00:00:00Z', base: DOCS_BASE, pages: [docsPage('Zeppelin mooring')] })
    view()
    openPalette('zeppelin')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByRole('option')).toBeNull()
    fireEvent.change(input(), { target: { value: 'troubleshooting' } })
    expect(screen.getAllByRole('option').some(o => o.textContent?.includes('Docs › Troubleshooting'))).toBe(true)
  })

  it.each(['Enter', 'click'])('opens a docs result in a new tab on %s without navigating the app', (how) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    view()
    openPalette('troubleshooting')
    const option = screen.getAllByRole('option')[0]
    expect(option.textContent).toContain('Docs')
    if (how === 'Enter') fireEvent.keyDown(input(), { key: 'Enter' })
    else fireEvent.click(option)
    expect(open).toHaveBeenCalledWith(`${DOCS_BASE}/troubleshooting/`, '_blank', 'noopener,noreferrer')
    expect(router.push).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    open.mockRestore()
  })
})

import { fireEvent, render, screen, within } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '@/src/components/ds'
import { SidebarSearch } from '../CommandPalette'

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

beforeEach(() => {
  router.push.mockClear()
})

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
})

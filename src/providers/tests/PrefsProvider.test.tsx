import { act, fireEvent, render, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyTheme, PrefsProvider, PREFS_STORAGE_KEYS, usePrefs } from '../PrefsProvider'

function Probe() {
  const prefs = usePrefs()
  return (
    <button onClick={() => prefs.setTheme('dark')}>
      {prefs.control}
      /
      {prefs.tempDisplay}
      /
      {prefs.theme}
      /
      {prefs.resolvedTheme}
    </button>
  )
}
beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('uses defaults for invalid preferences and server rendering', () => {
  localStorage.setItem(PREFS_STORAGE_KEYS.control, 'invalid')
  expect(renderToString(<PrefsProvider><Probe /></PrefsProvider>)).toContain('dial<!-- -->/<!-- -->degrees')
  render(<PrefsProvider><Probe /></PrefsProvider>)
  expect(screen.getByRole('button').textContent).toBe('dial/degrees/auto/dark')
})

it('follows system theme and storage events, and removes subscriptions', () => {
  const mq = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', () => mq)
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  document.head.append(meta)
  const { unmount } = render(<PrefsProvider><Probe /></PrefsProvider>)
  expect(meta.content).toBe('#f6f6f5')
  act(() => {
    mq.matches = false
    mq.addEventListener.mock.calls[0][1]()
  })
  expect(screen.getByRole('button').textContent).toBe('dial/degrees/auto/dark')
  act(() => {
    localStorage.setItem(PREFS_STORAGE_KEYS.theme, 'light')
    window.dispatchEvent(new StorageEvent('storage'))
  })
  expect(screen.getByRole('button').textContent).toBe('dial/degrees/light/light')
  applyTheme('dark')
  expect(meta.content).toBe('#0b0b0c')
  unmount()
  expect(mq.removeEventListener).toHaveBeenCalledWith('change', mq.addEventListener.mock.calls[0][1])
  meta.remove()
})

it('survives unavailable local storage', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('disabled')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('disabled')
  })
  render(<PrefsProvider><Probe /></PrefsProvider>)
  fireEvent.click(screen.getByRole('button'))
  expect(screen.getByRole('button').textContent).toBe('dial/degrees/auto/dark')
})

it('requires a provider', () => {
  expect(() => renderToString(<Probe />)).toThrow('usePrefs must be used within PrefsProvider')
})

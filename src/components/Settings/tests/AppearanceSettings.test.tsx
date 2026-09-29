import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppearanceSettings } from '../AppearanceSettings'
import { PrefsProvider, PREFS_STORAGE_KEYS } from '@/src/providers/PrefsProvider'

const mock = vi.hoisted(() => ({ mutate: vi.fn(), invalidate: vi.fn(), pending: false, error: null as null | Error, success: () => {} }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ settings: { getAll: { invalidate: mock.invalidate } } }),
  settings: { updateDevice: { useMutation: (opts: { onSuccess: () => void }) => {
    mock.success = opts.onSuccess
    return { mutate: mock.mutate, isPending: mock.pending, variables: { temperatureUnit: 'C' }, error: mock.error }
  } } },
} }))

beforeEach(() => {
  localStorage.clear()
  Object.assign(mock, { pending: false, error: null })
  vi.clearAllMocks()
})
afterEach(() => vi.restoreAllMocks())

it('persists control, display and theme choices through accessible controls', () => {
  render(<PrefsProvider><AppearanceSettings temperatureUnit="F" /></PrefsProvider>)
  const slider = screen.getByRole('radio', { name: 'Slider' })
  fireEvent.keyDown(slider, { key: 'x' })
  expect(slider.getAttribute('aria-checked')).toBe('false')
  fireEvent.keyDown(slider, { key: 'Enter' })
  expect(slider.getAttribute('aria-checked')).toBe('true')
  fireEvent.keyDown(screen.getByRole('radio', { name: 'Dial' }), { key: ' ' })
  expect(localStorage.getItem(PREFS_STORAGE_KEYS.control)).toBe('dial')
  fireEvent.click(slider)
  expect(localStorage.getItem(PREFS_STORAGE_KEYS.control)).toBe('slider')
  fireEvent.click(screen.getByRole('tab', { name: 'Offset ±' }))
  expect(localStorage.getItem(PREFS_STORAGE_KEYS.tempDisplay)).toBe('offset')
  fireEvent.click(screen.getByRole('tab', { name: 'Light' }))
  expect(document.documentElement.dataset.theme).toBe('light')
  fireEvent.click(screen.getByRole('tab', { name: 'Dark' }))
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  fireEvent.click(screen.getByRole('tab', { name: '°C' }))
  expect(mock.mutate).toHaveBeenCalledWith({ temperatureUnit: 'C' })
  act(() => mock.success())
  expect(mock.invalidate).toHaveBeenCalledOnce()
})

it('shows optimistic units and mutation errors', () => {
  mock.pending = true
  mock.error = new Error('Pod unavailable')
  const { rerender } = render(<PrefsProvider><AppearanceSettings temperatureUnit="F" /></PrefsProvider>)
  expect(within(screen.getByRole('tablist', { name: 'Units' })).getByRole('tab', { selected: true }).textContent).toBe('°C')
  expect(screen.getByText('Pod unavailable')).toBeTruthy()
  mock.pending = false
  rerender(<PrefsProvider><AppearanceSettings temperatureUnit="C" /></PrefsProvider>)
  expect(screen.getByRole('tab', { name: '°C' }).getAttribute('aria-selected')).toBe('true')
})

/**
 * Tests for useI18n — wraps Lingui's useLingui hook to expose a simple
 * { i18n, t, locale } interface where t() handles both raw strings and
 * MessageDescriptor objects.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const linguiMock = vi.hoisted(() => {
  const i18n = {
    locale: 'en',
    _: vi.fn((m: { id: string }) => `translated:${m.id}`),
  }
  return { i18n, useLingui: vi.fn(() => ({ i18n })) }
})

vi.mock('@lingui/react', () => ({ useLingui: linguiMock.useLingui }))

import { useI18n } from '../useI18n'

describe('useI18n', () => {
  it('returns the i18n instance and locale', () => {
    const { result } = renderHook(() => useI18n())
    expect(result.current.i18n).toBe(linguiMock.i18n)
    expect(result.current.locale).toBe('en')
  })

  it('t passes raw strings through unchanged', () => {
    const { result } = renderHook(() => useI18n())
    expect(result.current.t('hello world')).toBe('hello world')
    expect(linguiMock.i18n._).not.toHaveBeenCalled()
  })

  it('t resolves MessageDescriptor via i18n._()', () => {
    const { result } = renderHook(() => useI18n())
    const descriptor = { id: 'greeting' }
    expect(result.current.t(descriptor)).toBe('translated:greeting')
    expect(linguiMock.i18n._).toHaveBeenCalledWith(descriptor)
  })
})

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePreference } from '../controls'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('base preferences', () => {
  it('keeps a session preference in memory when storage is denied', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const { result } = renderHook(() => usePreference('privateMode', 'a', ['a', 'b']))
    expect(result.current[0]).toBe('a')
    act(() => result.current[1]('b'))
    expect(result.current[0]).toBe('b')
  })

  it('falls back when storage holds a value that is no longer an option', () => {
    localStorage.setItem('sleepypod.base.retired', 'gone')
    const { result } = renderHook(() => usePreference('retired', 'a', ['a', 'b']))
    expect(result.current[0]).toBe('a')
  })
})

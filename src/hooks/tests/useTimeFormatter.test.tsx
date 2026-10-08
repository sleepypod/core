import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useTimeFormatter } from '../useTimeFormatter'

const preference = vi.hoisted(() => ({ value: '12h' as '12h' | '24h' }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => preference.value }))

it('keeps formatter identities stable until the preference changes, then updates every formatter', () => {
  const timestamp = new Date(2026, 9, 6, 23, 0).getTime()
  const { result, rerender } = renderHook(() => useTimeFormatter())
  const twelve = result.current
  expect(twelve.formatTime('23:00')).toBe('11:00 PM')
  expect(twelve.formatClock(timestamp)).toBe('11:00 PM')
  expect(twelve.formatTick(timestamp)).toBe('11 PM')
  rerender()
  expect(result.current).toBe(twelve)

  preference.value = '24h'
  rerender()
  expect(result.current).not.toBe(twelve)
  expect(result.current.timeFormat).toBe('24h')
  expect(result.current.formatTime('23:00')).toBe('23:00')
  expect(result.current.formatClock(timestamp)).toBe('23:00')
  expect(result.current.formatTick(timestamp)).toBe('23:00')
  expect(result.current.formatClock('2026-10-07T00:05:09Z', { timeZone: 'UTC', second: '2-digit' })).toBe('00:05:09')
  expect(result.current.formatClock(null)).toBe('—')

  preference.value = '12h'
  rerender()
  expect(result.current.formatTick(timestamp)).toBe('11 PM')
})

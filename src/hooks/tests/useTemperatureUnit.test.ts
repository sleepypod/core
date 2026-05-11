/**
 * Tests for useTemperatureUnit — reads the user's preferred unit from
 * settings.getAll and exposes Celsius→display conversion helpers. Internal
 * data is always Celsius; the hook converts at display time.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const trpcMock = vi.hoisted(() => {
  const state: { data: any } = { data: undefined }
  return {
    state,
    trpc: {
      settings: {
        getAll: { useQuery: vi.fn(() => ({ data: state.data })) },
      },
    },
  }
})

vi.mock('@/src/utils/trpc', () => ({ trpc: trpcMock.trpc }))

import { useTemperatureUnit } from '../useTemperatureUnit'

afterEach(() => {
  trpcMock.state.data = undefined
})

describe('useTemperatureUnit', () => {
  it('defaults to Fahrenheit when settings are unavailable', () => {
    const { result } = renderHook(() => useTemperatureUnit())
    expect(result.current.unit).toBe('F')
    expect(result.current.suffix).toBe('°F')
  })

  it('uses Celsius when settings prefer C', () => {
    trpcMock.state.data = { device: { temperatureUnit: 'C' } }
    const { result } = renderHook(() => useTemperatureUnit())
    expect(result.current.unit).toBe('C')
    expect(result.current.suffix).toBe('°C')
  })

  describe('convert (Celsius → preferred unit)', () => {
    it('converts Celsius to Fahrenheit', () => {
      const { result } = renderHook(() => useTemperatureUnit())
      expect(result.current.convert(0)).toBe(32)
      expect(result.current.convert(100)).toBe(212)
      expect(result.current.convert(20)).toBe(68)
    })

    it('returns Celsius unchanged when unit is C', () => {
      trpcMock.state.data = { device: { temperatureUnit: 'C' } }
      const { result } = renderHook(() => useTemperatureUnit())
      expect(result.current.convert(20)).toBe(20)
    })

    it('returns null for null/undefined input', () => {
      const { result } = renderHook(() => useTemperatureUnit())
      expect(result.current.convert(null)).toBeNull()
      expect(result.current.convert(undefined)).toBeNull()
    })
  })

  describe('formatTemp', () => {
    it('formats with one decimal and unit suffix', () => {
      const { result } = renderHook(() => useTemperatureUnit())
      expect(result.current.formatTemp(20)).toBe('68.0°F')
    })

    it('returns -- for null/undefined', () => {
      const { result } = renderHook(() => useTemperatureUnit())
      expect(result.current.formatTemp(null)).toBe('--')
      expect(result.current.formatTemp(undefined)).toBe('--')
    })
  })

  describe('formatTempShort', () => {
    it('rounds to integer with degree suffix only', () => {
      const { result } = renderHook(() => useTemperatureUnit())
      expect(result.current.formatTempShort(20)).toBe('68°')
      expect(result.current.formatTempShort(0)).toBe('32°')
    })

    it('returns -- for null/undefined', () => {
      const { result } = renderHook(() => useTemperatureUnit())
      expect(result.current.formatTempShort(null)).toBe('--')
    })
  })

  describe('formatConverted', () => {
    it('formats an already-converted value with the preferred unit suffix', () => {
      const { result } = renderHook(() => useTemperatureUnit())
      expect(result.current.formatConverted(72.345)).toBe('72.3°F')
    })

    it('returns -- for null/undefined', () => {
      const { result } = renderHook(() => useTemperatureUnit())
      expect(result.current.formatConverted(null)).toBe('--')
      expect(result.current.formatConverted(undefined)).toBe('--')
    })
  })
})

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getBaseUrl } from './url'

describe('getBaseUrl', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
    vi.unstubAllGlobals()
  })

  describe('in the browser (window defined)', () => {
    test('returns an empty string so requests stay relative', () => {
      // jsdom provides `window`; ignore env vars on this branch
      delete process.env.VERCEL_URL
      delete process.env.PORT
      expect(getBaseUrl()).toBe('')
    })
  })

  describe('on the server (no window)', () => {
    beforeEach(() => {
      // Hide window so the function takes the server-side branch.
      vi.stubGlobal('window', undefined)
    })

    test('uses VERCEL_URL with https when present', () => {
      process.env.VERCEL_URL = 'preview-abc.vercel.app'
      delete process.env.PORT
      expect(getBaseUrl()).toBe('https://preview-abc.vercel.app')
    })

    test('falls back to localhost on the configured PORT', () => {
      delete process.env.VERCEL_URL
      process.env.PORT = '4000'
      expect(getBaseUrl()).toBe('http://localhost:4000')
    })

    test('defaults to localhost:3000 when neither env var is set', () => {
      delete process.env.VERCEL_URL
      delete process.env.PORT
      expect(getBaseUrl()).toBe('http://localhost:3000')
    })

    test('prefers VERCEL_URL over PORT when both are set', () => {
      process.env.VERCEL_URL = 'app.example.com'
      process.env.PORT = '4000'
      expect(getBaseUrl()).toBe('https://app.example.com')
    })
  })
})

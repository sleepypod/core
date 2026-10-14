// @vitest-environment node
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, proxy } from '../proxy'

const request = (path: string, host?: string) => {
  const headers = new Headers({ 'accept-language': 'en' })
  if (host !== undefined) headers.set('host', host)
  return new NextRequest(`http://192.168.1.88:3000${path}`, { headers })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('proxy host check', () => {
  it.each([
    '/api/trpc/device.getStatus',
    '/api/mcp',
    '/en/settings',
    '/',
  ])('rejects a rebinding Host on %s with 403', async (path) => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const response = proxy(request(path, 'attacker.example.com:3000'))
    expect(response?.status).toBe(403)
    expect(response?.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await response?.text()).toContain('SLEEPYPOD_ALLOWED_HOSTS')
  })

  it.each([
    '192.168.1.88:3000',
    'localhost:3000',
    '127.0.0.1:3000',
    'eight-pod.local:3000',
  ])('passes API requests through for %s', (host) => {
    expect(proxy(request('/api/trpc/device.getStatus', host))).toBeUndefined()
  })

  it('still redirects allowed page requests to a locale', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const response = proxy(request('/settings', '192.168.1.88:3000'))
    expect(response?.status).toBe(307)
    expect(response?.headers.get('location')).toBe('http://192.168.1.88:3000/en/settings')
  })

  it('allows hosts listed in SLEEPYPOD_ALLOWED_HOSTS', () => {
    vi.stubEnv('SLEEPYPOD_ALLOWED_HOSTS', '*.tail1234.ts.net')
    expect(proxy(request('/api/mcp', 'pod.tail1234.ts.net'))).toBeUndefined()
    expect(proxy(request('/api/mcp', 'attacker.example.com'))?.status).toBe(403)
  })

  it('skips the check in the demo build', () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO', '1')
    expect(proxy(request('/api/trpc/device.getStatus', 'sleepypod-demo.vercel.app'))).toBeUndefined()
  })

  it('passes requests without a Host header', () => {
    const req = request('/api/mcp')
    req.headers.delete('host')
    expect(proxy(req)).toBeUndefined()
  })
})

describe('proxy matcher', () => {
  const matches = (path: string) => config.matcher.some((pattern) => {
    if (pattern === '/api/:path*') return path === '/api' || path.startsWith('/api/')
    return new RegExp(`^${pattern}$`).test(path)
  })

  it.each([
    '/api/trpc/device.getStatus',
    '/api/mcp',
    '/api/biometrics/watch-upload',
    '/api/raw/SEQNO.RAW',
    '/api/export/archive',
    '/api/db-backup',
    '/api/openapi.json',
    '/api/raw/frame.png',
    '/panel',
    '/vendor/three.module.js',
    '/en/settings',
    '/',
  ])('covers %s', (path) => {
    expect(matches(path)).toBe(true)
  })

  it.each([
    '/_next/static/chunks/main.js',
    '/_next/image',
    '/favicon.ico',
    '/images/bed.png',
  ])('skips %s', (path) => {
    expect(matches(path)).toBe(false)
  })
})

/**
 * Tests for the tRPC panel route. The panel exposes every procedure
 * unauthenticated, so it must never be served from production pods.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@ajayche/trpc-panel', () => ({
  renderTrpcPanel: vi.fn(() => '<html>panel</html>'),
}))
vi.mock('@/src/server/routers/app', () => ({ appRouter: {} }))

import { GET } from './route'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /panel', () => {
  it('returns 404 in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const res = GET(new Request('http://pod.local/panel'))
    expect(res.status).toBe(404)
  })

  it('serves the panel outside production', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const res = GET(new Request('http://pod.local/panel'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
  })
})

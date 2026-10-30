import { beforeEach, describe, expect, it, vi } from 'vitest'

const openapi = vi.hoisted(() => ({
  generate: vi.fn(),
  appRouter: { marker: 'app-router' },
}))

vi.mock('trpc-to-openapi', () => ({ generateOpenApiDocument: openapi.generate }))
vi.mock('@/src/server/routers/app', () => ({ appRouter: openapi.appRouter }))

const { getOpenApiDocument } = await import('@/src/server/openapi')

beforeEach(() => {
  openapi.generate.mockReset().mockReturnValue({ openapi: '3.1.0' })
})

describe('getOpenApiDocument', () => {
  it('passes the complete public API description to the generator', () => {
    expect(getOpenApiDocument('http://pod.local/api')).toEqual({ openapi: '3.1.0', security: [{ bearerAuth: [] }] })
    expect(openapi.generate).toHaveBeenCalledWith(openapi.appRouter, {
      title: 'Sleepypod Core API',
      version: process.env.npm_package_version ?? '0.0.0-dev',
      baseUrl: 'http://pod.local/api',
      description:
        'REST-style API for the Sleepypod Pod controller. '
        + 'All endpoints are also available via tRPC at /api/trpc. '
        + 'Owner authentication is required: a Bearer connection key or an expiring browser session. '
        + 'Use LAN or private Tailscale access; do not expose the controller publicly.',
      tags: ['Health', 'Device', 'Settings', 'Schedules', 'Biometrics', 'Biometric tuning', 'System', 'Environment', 'Raw', 'Calibration', 'Water Level'],
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    })
  })

  it('forwards each caller-provided base URL verbatim', () => {
    getOpenApiDocument('https://192.168.1.7:3000/custom/')
    expect(openapi.generate.mock.calls[0]?.[1]).toMatchObject({
      baseUrl: 'https://192.168.1.7:3000/custom/',
    })
  })
})

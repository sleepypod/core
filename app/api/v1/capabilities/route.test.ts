import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateOpenApiDocument } from 'trpc-to-openapi'
import { router } from '@/src/server/trpc'
import { ownerRequest, TEST_OWNER_TOKEN } from '@/src/auth/tests/support'
import { buildCapabilities } from '@/src/capabilities/contract'

const runtime = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/src/capabilities/read', () => ({ readCapabilities: runtime.read }))
const { GET } = await import('./route')
const { capabilitiesRouter } = await import('@/src/server/routers/capabilities')
const address = 'http://pod.local/api/v1/capabilities'

beforeEach(() => {
  runtime.read.mockReset().mockReturnValue(buildCapabilities({
    now: Date.parse('2026-10-25T20:00:00Z'), revision: null, mqttConnected: false,
    device: { status: null, current: false, observedAt: null }, base: null,
  }))
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
})
afterEach(() => vi.unstubAllEnvs())

describe('authenticated versioned capability discovery', () => {
  it('does not read runtime state without an owner credential', async () => {
    expect((await GET(new Request(address))).status).toBe(401)
    expect((await GET(new Request(address, { headers: { Authorization: 'Bearer invalid' } }))).status).toBe(401)
    expect(runtime.read).not.toHaveBeenCalled()
  })

  it('fails closed before owner provisioning', async () => {
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', '')
    expect((await GET(new Request(address))).status).toBe(503)
    expect(runtime.read).not.toHaveBeenCalled()
  })

  it('returns the same validated contract through REST and tRPC, without caching', async () => {
    const response = await GET(ownerRequest(address))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toBe('Authorization, Cookie')
    const expected = await capabilitiesRouter.createCaller({}).get({})
    expect(await response.json()).toEqual(expected)
    expect(expected.features.personalComfort).toMatchObject({ implemented: true, runtime: 'not_ready', physicalVerification: 'unverified' })
  })

  it('rejects browser origins from another site even with a valid bearer', async () => {
    const response = await GET(ownerRequest(address, { headers: { Host: 'pod.local', Origin: 'https://different.example' } }))
    expect(response.status).toBe(401)
    expect(runtime.read).not.toHaveBeenCalled()
  })

  it('publishes the v1 path and response in generated OpenAPI', () => {
    const document = generateOpenApiDocument(router({ capabilities: capabilitiesRouter }), { title: 'Test', version: '1', baseUrl: 'http://pod.local/api' })
    expect(document.paths?.['/v1/capabilities']?.get?.responses?.['200']).toBeDefined()
  })
})

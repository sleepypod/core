// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST_OWNER_TOKEN } from '@/src/auth/tests/support'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { createOpenApiFetchHandler } from 'trpc-to-openapi'

vi.mock('@/src/server/routers/app', () => ({ appRouter: {} }))
vi.mock('@trpc/server/adapters/fetch', () => ({ fetchRequestHandler: vi.fn(() => new Response('trpc')) }))
vi.mock('trpc-to-openapi', () => ({ createOpenApiFetchHandler: vi.fn(() => new Response('rest')) }))

import { GET as trpc } from '@/app/api/trpc/[trpc]/route'
import { GET as rootTrpc } from '@/app/api/trpc/route'
import { GET as rest } from '@/app/api/[...rest]/route'

beforeEach(() => {
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(fetchRequestHandler).mockImplementation(() => Promise.resolve(new Response('trpc')))
  vi.mocked(createOpenApiFetchHandler).mockImplementation(() => Promise.resolve(new Response('rest')))
})

describe('API route access without relying on the Next proxy', () => {
  it.each([trpc, rootTrpc, rest])('rejects unauthenticated dispatch', async (handler) => {
    expect((await handler(new Request('http://pod.local/api/device/status'))).status).toBe(401)
  })

  it.each([trpc, rootTrpc, rest])('allows native owner dispatch', async (handler) => {
    expect((await handler(new Request('http://pod.local/api/device/status', {
      headers: { Authorization: `Bearer ${TEST_OWNER_TOKEN}` },
    }))).status).toBe(200)
  })

  it.each([trpc, rootTrpc, rest])('withholds a delayed adapter response after revocation', async (handler) => {
    const adapter = handler === rest ? vi.mocked(createOpenApiFetchHandler) : vi.mocked(fetchRequestHandler)
    let resolve!: (response: Response) => void
    adapter.mockImplementationOnce(() => new Promise<Response>((finish) => {
      resolve = finish
    }))
    const pending = handler(new Request('http://pod.local/api/history', {
      headers: { Authorization: `Bearer ${TEST_OWNER_TOKEN}` },
    }))
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN + '-rotated')
    resolve(new Response('private history'))
    const response = await pending
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('private history')
  })
})

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { bindBrowserScope, browserScopeRevision } from './browserScope'
import { issueSession, SESSION_COOKIE } from './access'
import { ownerRequest, TEST_OWNER_TOKEN } from './tests/support'
import { privateApiResponse } from './privateResponse'

afterEach(() => vi.unstubAllEnvs())
const bytes = (value: string) => new TextEncoder().encode(value)
function responseBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error('Expected response body')
  return response.body
}

describe('private API responses', () => {
  it('keeps a streaming error body and adapter headers without caching either identity', async () => {
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('private fixture'))
      controller.close()
    } }), { status: 409, headers: { 'Vary': 'Accept, cookie', 'Cache-Control': 'public, max-age=3600', 'Retry-After': '30' } })
    const result = privateApiResponse(ownerRequest('http://pod/api/status'), response)
    expect(result.status).toBe(409)
    expect(result.headers.get('Cache-Control')).toBe('private, no-store')
    expect(result.headers.get('Vary')).toBe('Accept, cookie, Authorization')
    expect(result.headers.get('Retry-After')).toBe('30')
    expect(response.bodyUsed).toBe(false)
    expect(await result.text()).toBe('private fixture')
  })

  it('rejects a response prepared after owner key rotation and cancels its source', async () => {
    const request = ownerRequest('http://pod/api/history')
    const cancel = vi.fn()
    const stopProducer = vi.fn()
    const source = new Response(new ReadableStream({ cancel }))
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN + '-new')
    const response = privateApiResponse(request, source, { onCancel: stopProducer })
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('history')
    expect(cancel).toHaveBeenCalledOnce()
    expect(stopProducer).toHaveBeenCalledOnce()
  })

  it('does not prefetch output, and stops between chunks after access changes', async () => {
    const request = ownerRequest('http://pod/api/history')
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(bytes('private')))
    const cancel = vi.fn()
    const source = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }))
    const response = privateApiResponse(request, source)
    await Promise.resolve()
    expect(pull).not.toHaveBeenCalled()
    const reader = responseBody(response).getReader()
    expect((await reader.read()).value).toEqual(bytes('private'))
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN + '-new')
    await expect(reader.read()).rejects.toThrow('access changed')
    expect(pull).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rechecks after an awaited source read before releasing a private chunk', async () => {
    const request = ownerRequest('http://pod/api/history')
    let sourceController!: ReadableStreamDefaultController<Uint8Array>
    const cancel = vi.fn()
    const response = privateApiResponse(request, new Response(new ReadableStream({
      start(controller) { sourceController = controller }, cancel,
    }, { highWaterMark: 0 })))
    const pending = responseBody(response).getReader().read()
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN + '-new')
    sourceController.enqueue(bytes('must not escape'))
    await expect(pending).rejects.toThrow('access changed')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('honors a persisted browser switch without waiting for cookie expiry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'response-scope-'))
    try {
      const databasePath = join(directory, 'configuration.db')
      migratedComfortDatabase(databasePath).close()
      vi.stubEnv('DATABASE_URL', databasePath)
      vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
      const session = issueSession(Date.now(), true)
      const scope = bindBrowserScope(new Request('http://pod/api/auth/session'), 'owner', session).split(';')[0]
      const headers = new Headers({ host: 'pod', origin: 'http://pod', cookie: `${scope}; ${SESSION_COOKIE}=${session}` })
      const response = privateApiResponse(new Request('http://pod/api/history', { headers }), Response.json({ private: true }))
      const revision = browserScopeRevision(headers)
      if (!revision) throw new Error('Expected browser scope')
      headers.set('x-sleepypod-browser-revision', revision)
      bindBrowserScope(new Request('http://pod/api/household/session', { headers }), 'personal', 'a-different-person-session')
      await expect(response.text()).rejects.toThrow('access changed')
    }
    finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('rechecks download-specific restrictions even when the credential stays valid', async () => {
    const request = ownerRequest('http://pod/api/db-backup')
    let restricted = false
    const cancel = vi.fn()
    const response = privateApiResponse(request, new Response(new ReadableStream({ cancel })), {
      additionalAccess: () => restricted ? Response.json({ error: 'Personal household' }, { status: 403 }) : null,
    })
    restricted = true
    await expect(response.text()).rejects.toThrow('access changed')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(['abort', 'cancel'] as const)('cancels a blocked producer on %s without waiting for another chunk', async (reason) => {
    const controller = new AbortController()
    const request = ownerRequest('http://pod/api/history', { signal: controller.signal })
    const cancel = vi.fn()
    const stopProducer = vi.fn()
    const response = privateApiResponse(request, new Response(new ReadableStream({ cancel })), { onCancel: stopProducer })
    const reader = responseBody(response).getReader()
    const pending = reader.read()
    if (reason === 'abort') {
      controller.abort()
      await expect(pending).rejects.toThrow('interrupted')
    }
    else {
      await reader.cancel()
      expect((await pending).done).toBe(true)
    }
    expect(cancel).toHaveBeenCalledOnce()
    expect(stopProducer).toHaveBeenCalledOnce()
  })

  it('preserves a valid empty response', () => {
    const response = privateApiResponse(ownerRequest('http://pod/api/control'), new Response(null, { status: 204 }))
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})

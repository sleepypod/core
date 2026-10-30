// @vitest-environment node
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST_OWNER_TOKEN } from '@/src/auth/tests/support'
import { issueSession, requireAccess, SESSION_COOKIE } from '@/src/auth/access'
import { buildMaintenanceStatus } from '@/src/maintenance/statusContract'
import { proxy } from '@/proxy'

const runtime = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/src/maintenance/readStatus', () => ({ readMaintenanceStatus: runtime.read }))
const { GET } = await import('./route')
const address = 'http://127.0.0.1:3000/api/v1/maintenance/status'
function request(init?: RequestInit) {
  return new Request(address, { ...init, headers: { Authorization: `Bearer ${TEST_OWNER_TOKEN}`, ...init?.headers } })
}

beforeEach(() => {
  runtime.read.mockReset().mockResolvedValue(buildMaintenanceStatus({
    now: Date.now(), revision: 'abcdef123', status: null, observedAt: null, current: false, privacyBoundary: 'personal_required',
  }))
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
  const path = process.env.DATABASE_URL
  if (!path) throw new Error('Isolated privacy fixture is required')
  const database = new Database(path)
  database.exec('INSERT INTO household_privacy_boundary VALUES (1, 1, \'personal fixture\')')
  database.close()
})
afterEach(() => vi.unstubAllEnvs())

describe('private administrative maintenance route', () => {
  it('allows exactly one status route while legacy owner paths remain closed', async () => {
    expect(requireAccess(request())?.status).toBe(403)
    expect(proxy(new NextRequest(request()))).toBeUndefined()
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Vary')).toBe('Authorization, Cookie, Origin')
    expect(await response.json()).toEqual(await runtime.read.mock.results[0].value)
    for (const path of ['/api/v1/maintenance/anything', '/api/v1/maintenance/status/private', '/api/settings', '/api/v1/capabilities']) {
      expect(proxy(new NextRequest(new URL(path, address), { headers: request().headers }))?.status).toBe(403)
    }
    const rebinding = new NextRequest(address, { headers: { ...Object.fromEntries(request().headers), host: 'attacker.example' } })
    expect(proxy(rebinding)?.status).toBe(403)
  })

  it.each<Record<string, string>>([
    {}, { Authorization: 'Bearer personal-device-fixture' }, { Authorization: 'Basic invalid' },
  ])('does not read state without the administrative bearer: %s', async (headers) => {
    expect((await GET(new Request(address, { headers }))).status).toBe(401)
    expect(runtime.read).not.toHaveBeenCalled()
  })

  it.each<Record<string, string>>([{ Origin: 'http://127.0.0.1:3000' }, { 'Sec-Fetch-Site': 'same-origin' }, { Cookie: 'anything=present' }])('rejects browser context even with a correct key: %s', async (headers) => {
    expect((await GET(request({ headers }))).status).toBe(401)
    expect(runtime.read).not.toHaveBeenCalled()
  })

  it('does not accept a signed owner session', async () => {
    expect((await GET(new Request(address, { headers: { Cookie: `${SESSION_COOKIE}=${issueSession()}` } }))).status).toBe(401)
    expect(runtime.read).not.toHaveBeenCalled()
  })

  it('rejects query selectors, non-read methods and missing provisioning', async () => {
    expect((await GET(new Request(`${address}?side=left`, { headers: request().headers }))).status).toBe(400)
    expect((await GET(request({ method: 'POST' }))).status).toBe(405)
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', '')
    expect((await GET(request())).status).toBe(503)
    expect(runtime.read).not.toHaveBeenCalled()
  })

  it('rechecks key rotation after an awaited read and before consuming the response', async () => {
    const response = await GET(request())
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN + '-rotated')
    await expect(response.text()).rejects.toThrow('access changed')
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
    runtime.read.mockImplementation(async () => {
      vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN + '-rotated')
      return {}
    })
    expect((await GET(request())).status).toBe(401)
  })

  it('withholds output on abort and never includes an exception or unexpected field', async () => {
    const abort = new AbortController()
    const response = await GET(request({ signal: abort.signal }))
    abort.abort()
    await expect(response.text()).rejects.toThrow('access changed')
    expect((await GET(request({ signal: abort.signal }))).status).toBe(499)
    runtime.read.mockRejectedValue(new Error('private-account-path'))
    const failed = await GET(request())
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('private-account-path')
    runtime.read.mockResolvedValue({ privateSleeper: 'private fixture' })
    expect((await GET(request())).status).toBe(503)
  })
})

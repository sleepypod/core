import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ownerRequest, TEST_OWNER_TOKEN } from '@/src/auth/tests/support'

const identity = 'c5142bce-64cc-4f97-8df8-6a572155582e'
const reader = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/src/connections/read', () => ({ readConnectionIdentity: reader.read }))
const { GET } = await import('./route')
const challenge = 'a'.repeat(43)
const address = `https://pod.example/api/v1/connection?challenge=${challenge}`
beforeEach(() => {
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
  reader.read.mockReset().mockReturnValue(identity)
})
afterEach(() => vi.unstubAllEnvs())

describe('authenticated route enrollment identity', () => {
  it('does not disclose or initialize identity before authenticating', async () => {
    for (const token of ['', 'wrong']) {
      expect((await GET(new Request(address, { headers: token ? { Authorization: `Bearer ${token}` } : {} }))).status).toBe(401)
    }
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', '')
    expect((await GET(new Request(address))).status).toBe(503)
    expect(reader.read).not.toHaveBeenCalled()
  })
  it('requires one valid challenge before reading or creating metadata', async () => {
    for (const query of ['', '?challenge=short', `?challenge=${challenge}&challenge=${challenge}`, `?challenge=${challenge}&extra=yes`]) {
      expect((await GET(ownerRequest('https://pod.example/api/v1/connection' + query))).status).toBe(400)
    }
    expect(reader.read).not.toHaveBeenCalled()
  })
  it('returns the installation and echoes only this request challenge without caching', async () => {
    for (const nonce of [challenge, 'b'.repeat(43)]) {
      const response = await GET(ownerRequest(address.replace(challenge, nonce)))
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('vary')).toBe('Authorization, Cookie')
      expect(await response.json()).toEqual({ schemaVersion: 1, controller: 'sleepypod-core', installationId: identity, challenge: nonce })
    }
  })
  it('does not disclose identity to another browser origin or after the personal boundary closes', async () => {
    expect((await GET(ownerRequest(address, { headers: { Host: 'pod.example', Origin: 'https://other.example' } }))).status).toBe(401)
    const databasePath = process.env.DATABASE_URL
    if (!databasePath) throw new Error('Expected isolated privacy database')
    const database = new Database(databasePath)
    database.prepare('INSERT INTO household_privacy_boundary VALUES (1, ?, ?)').run(Date.now(), 'test personal boundary')
    database.close()
    expect((await GET(ownerRequest(address))).status).toBe(403)
    expect(reader.read).not.toHaveBeenCalled()
  })
  it('does not initialize metadata for an aborted request', async () => {
    const signal = AbortSignal.abort()
    expect((await GET(ownerRequest(address, { signal }))).status).toBe(408)
    expect(reader.read).not.toHaveBeenCalled()
  })
  it('returns unavailable rather than substituting a product name or regenerating corrupt metadata', async () => {
    for (const value of [null, 'sleepypod-core', 'corrupt']) {
      reader.read.mockReturnValue(value)
      const response = await GET(ownerRequest(address))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'Controller connection identity is unavailable' })
    }
    reader.read.mockImplementation(() => {
      throw new Error('Private storage path and error details')
    })
    expect(await (await GET(ownerRequest(address))).text()).not.toContain('Private storage')
  })
})

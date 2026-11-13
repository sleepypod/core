// @vitest-environment node
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEST_OWNER_TOKEN, ownerRequest } from '@/src/auth/tests/support'
import { proxy } from '@/proxy'

const runtime = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/src/house-routine/readObservations', () => ({ readHouseRoutineObservations: runtime.read }))
const { GET } = await import('./route')
const address = 'http://127.0.0.1:3000/api/v1/house-routine/observations'
const snapshot = { version: 1, observations: [{
  signal: 'bed', side: 'left', value: 'occupied', source: `pod-presence-v1:${'a'.repeat(64)}`,
  measured_at: '2026-11-13T03:00:00.000Z', qualified: true,
  fields: { whole_bed_empty: false, presence_scope: 'solo-anywhere', qualification: 'attended_empty_and_occupied',
    calibration: 'b'.repeat(64), expires_at: '2026-11-13T03:00:30.000Z' },
}] }

function closePrivacyBoundary() {
  const path = process.env.DATABASE_URL
  if (!path) throw new Error('Isolated privacy fixture is required')
  const database = new Database(path)
  database.prepare('INSERT INTO household_privacy_boundary VALUES (1, 1, \'personal fixture\')').run()
  database.close()
}
beforeEach(() => {
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
  runtime.read.mockReset().mockResolvedValue(snapshot)
})
afterEach(() => vi.unstubAllEnvs())

describe('read-only house presence route', () => {
  it('delivers the v1 House Control shape through ordinary private access', async () => {
    const request = ownerRequest(address)
    expect(proxy(new NextRequest(request))).toBeUndefined()
    const response = await GET(request)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Vary')).toBe('Authorization, Cookie')
    expect(await response.json()).toEqual(snapshot)
  })

  it.each<Record<string, string>>([{}, { Authorization: 'Bearer personal-device-fixture' }, { Authorization: 'Basic invalid' }])('does not inspect sensors for an unauthorized request: %s', async (headers) => {
    expect((await GET(new Request(address, { headers }))).status).toBe(401)
    expect(runtime.read).not.toHaveBeenCalled()
  })

  it('keeps the personal privacy boundary closed in the proxy and direct route', async () => {
    closePrivacyBoundary()
    const request = ownerRequest(address)
    expect(proxy(new NextRequest(request))?.status).toBe(403)
    expect((await GET(request)).status).toBe(403)
    expect(runtime.read).not.toHaveBeenCalled()
  })

  it('withdraws output if privacy changes during the read or before delivery', async () => {
    const response = await GET(ownerRequest(address))
    closePrivacyBoundary()
    await expect(response.text()).rejects.toThrow('access changed')
    expect(runtime.read).toHaveBeenCalledTimes(1)
  })

  it('rechecks authorization after the awaited read', async () => {
    runtime.read.mockImplementation(async () => {
      vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', `${TEST_OWNER_TOKEN}-rotated`)
      return snapshot
    })
    expect((await GET(ownerRequest(address))).status).toBe(401)
  })

  it('rejects query selectors and hides unavailable or malformed internal state', async () => {
    expect((await GET(ownerRequest(`${address}?side=right`))).status).toBe(400)
    expect(runtime.read).not.toHaveBeenCalled()
    runtime.read.mockRejectedValue(new Error('private-account-secret'))
    const unavailable = await GET(ownerRequest(address))
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ error: 'qualified_presence_unavailable' })
    runtime.read.mockResolvedValue({ ...snapshot, privateNotes: 'do not expose' })
    expect((await GET(ownerRequest(address))).status).toBe(503)
  })

  it('does not expose movement or sleep assertions', async () => {
    const text = await (await GET(ownerRequest(address))).text()
    for (const absent of ['head_degrees', 'duration_minutes', 'sleep_date', 'stage', 'score', 'note']) expect(text).not.toContain(absent)
  })

  it('refuses writes and interrupted requests without reading the sensors', async () => {
    expect((await GET(ownerRequest(address, { method: 'POST' }))).status).toBe(405)
    const abort = new AbortController()
    abort.abort()
    expect((await GET(ownerRequest(address, { signal: abort.signal }))).status).toBe(408)
    expect(runtime.read).not.toHaveBeenCalled()
  })
})

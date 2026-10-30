import { describe, expect, it, vi } from 'vitest'
import preparation from '../../fixtures/preparation-v1.json'
import { householdSessionSchema } from '../../contract'
import { PersonalBrowserClient } from '../client'
const session = householdSessionSchema.parse(preparation.ownerSession)
describe('personal-only transport', () => {
  it('uses only same-origin personal endpoints, a pinned sleeper, and no redirect or owner fallback', async () => {
    const fetcher = vi.fn(async () => new Response('{}'))
    const client = new PersonalBrowserClient(session, fetcher)
    await client.read('me/bed')
    expect(fetcher).toHaveBeenCalledWith('/api/v1/me/bed', expect.objectContaining({ redirect: 'error', cache: 'no-store', credentials: 'same-origin', headers: { 'X-Sleepypod-Sleeper-Id': session.selfSleeperId } }))
    for (const path of ['../../api/settings', 'me/bed?side=left', 'https://other.test', 'controls', 'me/controls/invalid']) await expect(client.read(path)).rejects.toThrow()
    await expect(client.read('household/session', 'POST', {})).rejects.toThrow()
    await expect(client.read('me/bed', 'PUT', {})).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('bounds actual response bytes independently of content-length', async () => {
    const client = new PersonalBrowserClient(session, vi.fn(async () => new Response('a'.repeat(524289), { headers: { 'Content-Length': '1' } })))
    await expect(client.read('me/bed')).rejects.toThrow('too large')
  })
  it('ignores late responses after account disposal', async () => {
    let finish!: (value: Response) => void
    const client = new PersonalBrowserClient(session, vi.fn(() => new Promise<Response>(resolve => finish = resolve)))
    const reading = client.read('me/bed')
    client.dispose()
    finish(new Response('{}'))
    await expect(reading).rejects.toThrow('account changed')
  })
  it.each([401, 403, 409, 404, 500])('sanitizes error %s without exposing a peer body or retrying', async (status) => {
    const fetcher = vi.fn(async () => new Response('private peer payload', { status }))
    await expect(new PersonalBrowserClient(session, fetcher).read('me/bed')).rejects.not.toThrow('private peer payload')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

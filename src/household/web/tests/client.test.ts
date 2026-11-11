import { describe, expect, it, vi } from 'vitest'
import preparation from '../../fixtures/preparation-v1.json'
import { householdSessionSchema } from '../../contract'
import { PersonalBrowserClient } from '../client'
const session = householdSessionSchema.parse(preparation.ownerSession)
describe('personal-only transport', () => {
  it('allows only validated library reads and keeps their original payload bytes', async () => {
    const payload = JSON.stringify({ payload: 'a'.repeat(600000) })
    const fetcher = vi.fn<typeof fetch>(async () => new Response(payload))
    const client = new PersonalBrowserClient(session, fetcher)
    const record = 'me/learning/records/30000000-0000-4000-8000-000000000001'
    expect(await client.read(record)).toEqual(JSON.parse(payload))
    await expect(client.read('me/learning/archives')).rejects.toThrow('too large')
    for (const path of ['me/learning/archives?side=left', 'me/learning/records', `${record}?side=left`, `${record}#fragment`,
      'me/learning/archives?limit=01', 'me/learning/archives?limit=1&limit=2']) await expect(client.read(path)).rejects.toThrow()
    await expect(client.read(record, 'POST', {})).rejects.toThrow()
    await expect(client.read(record, 'GET', {})).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
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
  it('pins maintenance to the personal sleeper and never retries a lost restart', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'))
    const client = new PersonalBrowserClient(session, fetcher)
    const operationId = '10000000-0000-4000-8000-000000000001'
    await client.read(`household/transition?operationId=${operationId}`)
    await client.read(`household/transition/cancellation-preview?operationId=${operationId}`)
    fetcher.mockRejectedValueOnce(new Error('lost reply'))
    await expect(client.read('household/transition/restart', 'POST', { operationId })).rejects.toThrow('not be resent')
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls[2]).toEqual(['/api/v1/household/transition/restart', expect.objectContaining({
      method: 'POST', redirect: 'error', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Sleepypod-Sleeper-Id': session.selfSleeperId },
    })])
    for (const path of ['household/transition?side=right', 'household/transition/restart?command=reboot', 'household/transition/cancel'])
      await expect(client.read(path)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('admits only validated read-only history routes and preserves an opaque encoded cursor', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'))
    const client = new PersonalBrowserClient(session, fetcher)
    const query = new URLSearchParams({ startsAt: '1793314800000', endsAt: '1793336400000', kind: 'presence', limit: '30', cursor: 'opaque+cursor/with=padding' })
    await client.read(`me/sleep?${query}`)
    await client.read('me/sleep/10000000-0000-4000-8000-000000000001')
    expect(fetcher.mock.calls[0]?.[0]).toContain('cursor=opaque%2Bcursor%2Fwith%3Dpadding')
    for (const suffix of ['&side=left', '&sleeperId=someone', '&startsAt=1793314800000', '#fragment', '?kind=movement'])
      await expect(client.read(`me/sleep?${query}${suffix}`)).rejects.toThrow()
    for (const path of ['me/sleep', 'me/sleep?startsAt=01&endsAt=2&kind=presence', 'me/sleep/invalid', 'me/sleep/10000000-0000-4000-8000-000000000001?side=left'])
      await expect(client.read(path)).rejects.toThrow()
    await expect(client.read(`me/sleep?${query}`, 'POST', {})).rejects.toThrow()
    await expect(client.read(`me/sleep?${query}`, 'PUT', {})).rejects.toThrow()
    await expect(client.read(`me/sleep?${query}`, 'GET', {})).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(2)
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

import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { householdHttp } from '../../http'
import { householdSessionSchema } from '../../contract'
import { temporaryReviewSchema } from '../contract'
import { temporaryFixture } from './fixture'

let fixture: ReturnType<typeof temporaryFixture>
beforeEach(() => {
  fixture = temporaryFixture()
})
afterEach(() => {
  fixture.close()
  vi.unstubAllEnvs()
})
function request(key: string, suffix = '', body?: unknown, method = body === undefined ? 'GET' : 'POST', extraHeaders: Record<string, string> = {}) {
  return new Request(`http://pod.local/api/v1/household/temporary-arrangement${suffix}`, {
    method, headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...extraHeaders },
    ...body !== undefined ? { body: JSON.stringify(body) } : {},
  })
}
const response = (input: Request) => householdHttp(input, { store: fixture.identities, verifySoloConfiguration: () => false,
  temporaryArrangementReviews: fixture.service })

describe('temporary review personal API', () => {
  it('projects only each caller’s private plan and caches neither view', async () => {
    const empty = await response(request(fixture.ownerKey))
    expect(await empty.json()).toEqual({ version: 1, review: null })
    const created = await response(request(fixture.ownerKey, '', fixture.proposal()))
    expect(created.status).toBe(200)
    const review = temporaryReviewSchema.parse(await created.json())
    const member = await response(request(fixture.memberKey, `/${review.reviewId}`))
    expect(member.headers.get('cache-control')).toBe('private, no-store')
    const partner = temporaryReviewSchema.parse(await member.json())
    expect(JSON.stringify(partner)).not.toContain('Owner private week')
    expect(JSON.stringify(partner)).toContain('Partner private week')
    const saved = await response(request(fixture.memberKey, '/approve', fixture.approval(review.reviewId, fixture.memberKey)))
    expect(saved.status).toBe(200)
    expect(temporaryReviewSchema.parse(await saved.json())).toMatchObject({ self: { approved: true }, canActivate: false })
    const cancelled = await response(request(fixture.ownerKey, '/cancel', { ...fixture.context(), version: 1, reviewId: review.reviewId }))
    expect(temporaryReviewSchema.parse(await cancelled.json()).state).toBe('cancelled')
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('separates the personal review from owner connection-key authentication', async () => {
    const ownerConnectionKey = randomBytes(32).toString('hex')
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', ownerConnectionKey)
    for (const key of ['bad-key', ownerConnectionKey]) {
      const denied = await response(request(key, '', fixture.proposal()))
      expect(denied.status).toBe(401)
    }
    expect(fixture.database.prepare('SELECT * FROM household_temporary_reviews').all()).toEqual([])
  })

  it('rejects foreign origins, stale account hints, caller-supplied plans and nonexistent activation', async () => {
    const before = fixture.operating()
    expect((await response(request(fixture.ownerKey, '', fixture.proposal(), 'POST', { Origin: 'https://elsewhere.invalid' }))).status).toBe(403)
    expect((await response(request(fixture.ownerKey, '', fixture.proposal(), 'POST', { 'x-sleepypod-sleeper-id': fixture.member.selfSleeperId }))).status).toBe(409)
    expect((await response(request(fixture.ownerKey, '', { ...fixture.proposal(), source: {} }))).status).toBe(400)
    expect((await response(request(fixture.ownerKey, '/activate', fixture.proposal()))).status).toBe(404)
    expect(fixture.operating()).toEqual(before)
  })

  it('advertises inert preparation separately and disables it without changing existing bed behavior', () => {
    const session = fixture.service.present(fixture.identities.session(fixture.ownerKey))
    expect(householdSessionSchema.parse(session).capabilities).toMatchObject({ temporaryArrangementReview: true, activateTemporaryArrangement: false })
    fixture.clock.enabled = false
    expect(fixture.service.present(session).capabilities).toMatchObject({ temporaryArrangementReview: false, activateTemporaryArrangement: false })
  })
})

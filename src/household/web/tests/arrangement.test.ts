import { describe, expect, it, vi } from 'vitest'
import preparation from '../../fixtures/preparation-v1.json'
import examples from '../../fixtures/arrangement-review-v1.json'
import { householdSessionSchema } from '../../contract'
import { approveArrangementSchema, cancelArrangementSchema, proposeArrangementSchema, arrangementReviewSchema } from '../../arrangementContract'
import { PersonalWebWorkspace } from '../workspace'
import { PersonalWebError, readArrangementReview } from '../protocol'
import { PersonalBrowserClient, type PersonalWebTransport } from '../client'

function setup(role: 'owner' | 'member' = 'owner') {
  let now = examples.ownerReview.createdAt + 2000
  const session = householdSessionSchema.parse({ ...preparation[`${role}Session`], capabilities: { ...preparation[`${role}Session`].capabilities, arrangementReview: true } })
  const review = arrangementReviewSchema.parse(examples[`${role}Review`])
  const posts: unknown[] = []
  let saved: typeof review | null = null
  const client: PersonalWebTransport = { dispose: vi.fn(), read: vi.fn(async (path, method = 'GET', body) => {
    if (path === 'household/session') return session
    if (path === 'household/arrangement' && method === 'GET') return { version: 1, review: saved }
    posts.push(body)
    if (path === 'household/arrangement') {
      const request = proposeArrangementSchema.parse(body)
      saved = { ...structuredClone(review), reviewId: request.requestId }
    }
    else if (path === 'household/arrangement/approve' && saved) {
      approveArrangementSchema.parse(body)
      saved = { ...saved, self: { ...saved.self, approved: true }, canApprove: false }
    }
    else if (path === 'household/arrangement/cancel' && saved) {
      cancelArrangementSchema.parse(body)
      saved = { ...saved, state: 'cancelled', canApprove: false }
    }
    else throw new Error('Unexpected route')
    return saved
  }) }
  const invalidated = vi.fn()
  const workspace = new PersonalWebWorkspace({ session: structuredClone(session), client, invalidated,
    journal: { list: vi.fn(async () => []), reserve: vi.fn(), remove: vi.fn() }, now: () => now })
  return { workspace, client, session, review, posts, invalidated, setNow: (value: number) => now = value,
    load: () => saved = structuredClone(review) }
}
const confirms = { side: true, routine: true, separateActivation: true }

describe('private shared-arrangement web review', () => {
  it('requires explicit preparation and three acknowledgments; only review endpoints receive POSTs', async () => {
    const fixture = setup()
    await fixture.workspace.proposeArrangement('right', true)
    expect(fixture.posts).toEqual([])
    await fixture.workspace.refreshArrangement()
    await fixture.workspace.proposeArrangement('right', false)
    expect(fixture.posts).toEqual([])
    await fixture.workspace.proposeArrangement('right', true)
    for (const field of Object.keys(confirms)) await fixture.workspace.approveArrangement({ ...confirms, [field]: false })
    expect(fixture.posts).toHaveLength(1)
    await fixture.workspace.approveArrangement(confirms)
    expect(fixture.workspace.getSnapshot().arrangement?.self.approved).toBe(true)
    expect(fixture.workspace.getSnapshot().arrangement?.canActivate).toBe(false)
    await fixture.workspace.cancelArrangement()
    expect(fixture.posts).toHaveLength(3)
    expect(fixture.workspace.getSnapshot().arrangement?.state).toBe('cancelled')
  })

  it.each(['propose', 'approve', 'cancel'] as const)('recovers a lost %s response by GET without replay', async (operation) => {
    const fixture = setup()
    if (operation !== 'propose') fixture.load()
    await fixture.workspace.refreshArrangement()
    const original = fixture.client.read
    fixture.client.read = vi.fn(async (path, method, body) => {
      const result = await original(path, method, body)
      if (method === 'POST') throw new Error('reply lost')
      return result
    })
    const run = () => operation === 'propose'
      ? fixture.workspace.proposeArrangement('right', true)
      : operation === 'approve' ? fixture.workspace.approveArrangement(confirms) : fixture.workspace.cancelArrangement()
    await run()
    expect(fixture.workspace.getSnapshot().arrangementLoaded).toBe(false)
    await run()
    expect(fixture.posts).toHaveLength(1)
    await fixture.workspace.refreshArrangement()
    expect(fixture.workspace.getSnapshot().arrangementLoaded).toBe(true)
    expect(fixture.posts).toHaveLength(1)
    expect(fixture.workspace.getSnapshot().message).toContain('checked')
  })

  it('does not queue a second operation or accept a response after the account is disposed', async () => {
    const fixture = setup()
    let release!: (value: unknown) => void
    vi.mocked(fixture.client.read).mockImplementationOnce(() => new Promise(resolve => release = resolve))
    const reading = fixture.workspace.refreshArrangement()
    await fixture.workspace.refreshArrangement()
    expect(fixture.client.read).toHaveBeenCalledTimes(1)
    fixture.workspace.dispose()
    release(fixture.session)
    await reading
    expect(fixture.workspace.getSnapshot().arrangement).toBeNull()
    expect(fixture.posts).toEqual([])
  })

  it.each(['sessionRevision', 'assignmentRevision'] as const)('rechecks changed %s before any POST', async (field) => {
    const fixture = setup()
    fixture.load()
    await fixture.workspace.refreshArrangement()
    fixture.session[field]++
    await fixture.workspace.approveArrangement(confirms)
    expect(fixture.posts).toEqual([])
    expect(fixture.invalidated).toHaveBeenCalledOnce()
    expect(fixture.workspace.getSnapshot().arrangement).toBeNull()
  })

  it.each(['expired', 'future', 'disabled'] as const)('blocks %s approval before sending', async (condition) => {
    const fixture = setup()
    fixture.load()
    await fixture.workspace.refreshArrangement()
    if (condition === 'disabled') fixture.session.capabilities.arrangementReview = false
    else fixture.setNow(condition === 'expired' ? fixture.review.expiresAt : fixture.review.createdAt - 1)
    await fixture.workspace.approveArrangement(confirms)
    expect(fixture.posts).toEqual([])
  })

  it('never lets a member propose or claims approval from an unconfirmed reply', async () => {
    const member = setup('member')
    await member.workspace.refreshArrangement()
    await member.workspace.proposeArrangement('right', true)
    expect(member.posts).toEqual([])
    const fixture = setup()
    fixture.load()
    await fixture.workspace.refreshArrangement()
    vi.mocked(fixture.client.read).mockImplementationOnce(async () => fixture.session).mockImplementationOnce(async () => fixture.review)
    await fixture.workspace.approveArrangement(confirms)
    expect(fixture.workspace.getSnapshot().arrangementLoaded).toBe(false)
    expect(fixture.workspace.getSnapshot().error).toContain('not confirmed')
  })

  it('validates both role projections and rejects another person, partner private fields and inconsistent readiness', () => {
    for (const role of ['owner', 'member'] as const) {
      const fixture = setup(role)
      expect(readArrangementReview(fixture.review, fixture.session)).toEqual(fixture.review)
      for (const patch of [
        { sleeperId: '00000000-0000-4000-8000-000000000099' },
        { assignmentRevision: 5 }, { canActivate: true },
        { partner: { ...fixture.review.partner, week: [] } },
        { partner: { ...fixture.review.partner, proposedSide: fixture.review.self.proposedSide } },
        { self: { ...fixture.review.self, approved: true } },
        { state: 'approved_for_separate_activation' },
      ]) expect(() => readArrangementReview({ ...fixture.review, ...patch }, fixture.session)).toThrow()
    }
  })

  it('permits only the narrow review methods and rejects arbitrary household access', async () => {
    const fetcher = vi.fn(async () => new Response('{}'))
    const client = new PersonalBrowserClient(setup().session, fetcher)
    await client.read('household/arrangement')
    for (const path of ['household/arrangement', 'household/arrangement/approve', 'household/arrangement/cancel']) await client.read(path, 'POST', {})
    for (const path of ['household/arrangement/activate', 'household/accounts', 'household/arrangement?owner=true']) await expect(client.read(path)).rejects.toThrow(PersonalWebError)
    await expect(client.read('household/arrangement/approve')).rejects.toThrow()
    await expect(client.read('household/arrangement', 'PUT', {})).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
})

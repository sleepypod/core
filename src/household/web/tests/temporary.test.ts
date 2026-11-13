import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { householdSessionSchema } from '../../contract'
import preparation from '../../fixtures/preparation-v1.json'
import { approveTemporaryReviewSchema, cancelTemporaryReviewSchema, temporaryProposalSchema, type TemporaryReview } from '../../temporary/contract'
import { TemporaryArrangementWorkspace } from '../temporary'
import { personalTemporaryPath } from '../temporaryPaths'
import { PersonalWebError } from '../protocol'
import { temporaryReviewFixture } from './temporaryFixture'

function setup() {
  const session = householdSessionSchema.parse(structuredClone(preparation.ownerSession))
  session.capabilities.temporaryArrangementReview = true
  const clock = { now: Date.parse('2026-11-13T04:00:00Z'), uptime: 1000 }
  const saved = { review: null as TemporaryReview | null }
  const read = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (path === 'household/session') return structuredClone(session)
    if (method === 'POST') {
      if (path.endsWith('/approve')) {
        approveTemporaryReviewSchema.parse(body)
        if (saved.review) Object.assign(saved.review, { self: { ...saved.review.self, approved: true }, canApprove: false, state: 'approved_for_separate_activation' })
      }
      else if (path.endsWith('/cancel')) {
        cancelTemporaryReviewSchema.parse(body)
        if (saved.review) Object.assign(saved.review, { state: 'cancelled', canApprove: false, canCancel: false })
      }
      else {
        const request = temporaryProposalSchema.parse(body)
        saved.review = temporaryReviewFixture(session, request.requestId, clock.now, request.kind, request.kind === 'guest' ? request.residentSide : 'left')
      }
      return structuredClone(saved.review)
    }
    if (path === 'household/temporary-arrangement') return { version: 1, review: structuredClone(saved.review) }
    if (!saved.review) throw new PersonalWebError('missing', 'No saved plan yet')
    return structuredClone(saved.review)
  }
  const client = { read: vi.fn(read), dispose: vi.fn() }, invalidated = vi.fn()
  const workspace = new TemporaryArrangementWorkspace({ session: structuredClone(session), client, invalidated,
    now: () => clock.now, uptime: () => clock.uptime })
  return { session, clock, saved, read, client, invalidated, workspace }
}
const writes = (fixture: ReturnType<typeof setup>) => fixture.client.read.mock.calls.filter(([, method]) => method === 'POST')

it('prepares, independently approves and cancels only a review, with no activation path', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  expect(writes(fixture)).toHaveLength(0)
  await fixture.workspace.prepare('guest', 'right', 12, true)
  expect(fixture.workspace.getSnapshot()).toMatchObject({ fresh: true, pending: null, review: { canActivate: false, self: { approved: false } } })
  await fixture.workspace.approve(false)
  expect(writes(fixture)).toHaveLength(1)
  await fixture.workspace.approve(true)
  expect(fixture.workspace.getSnapshot().review?.self.approved).toBe(true)
  await fixture.workspace.cancel()
  expect(fixture.workspace.getSnapshot().review?.state).toBe('cancelled')
  expect(writes(fixture).map(([path]) => path)).toEqual(['household/temporary-arrangement', 'household/temporary-arrangement/approve', 'household/temporary-arrangement/cancel'])
})

it.each(['prepare', 'approve', 'cancel'] as const)('recovers a lost %s response with reads, never repeats the write', async (kind) => {
  const fixture = setup()
  await fixture.workspace.refresh()
  if (kind !== 'prepare') await fixture.workspace.prepare('guest', 'right', 12, true)
  fixture.client.read.mockImplementation(async (path, method, body) => {
    const response = await fixture.read(path, method, body)
    if (method === 'POST') throw new Error('Network response lost')
    return response
  })
  if (kind === 'prepare') await fixture.workspace.prepare('guest', 'right', 12, true)
  else if (kind === 'approve') await fixture.workspace.approve(true)
  else await fixture.workspace.cancel()
  expect(fixture.workspace.getSnapshot().pending?.kind).toBe(kind)
  const count = writes(fixture).length
  await fixture.workspace.prepare('guest', 'right', 12, true)
  await fixture.workspace.approve(true)
  await fixture.workspace.cancel()
  expect(writes(fixture)).toHaveLength(count)
  fixture.workspace.clear()
  expect(fixture.workspace.getSnapshot().review).toBeNull()
  await fixture.workspace.refresh()
  expect(fixture.workspace.getSnapshot()).toMatchObject({ pending: null, fresh: true, error: null })
  expect(writes(fixture)).toHaveLength(count)
})

it('keeps an absent uncertain proposal blocked instead of inferring that it failed', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  fixture.client.read.mockImplementation((path, method, body) => method === 'POST' ? Promise.reject(new Error('Lost')) : fixture.read(path, method, body))
  await fixture.workspace.prepare('guest', 'left', 8, true)
  await fixture.workspace.refresh()
  expect(fixture.workspace.getSnapshot().pending?.kind).toBe('prepare')
  expect(writes(fixture)).toHaveLength(1)
})

it('releases a known rejected request for a fresh explicit review without retrying it', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  fixture.client.read.mockImplementation((path, method, body) => method === 'POST' ? Promise.reject(new PersonalWebError('conflict', 'Changed')) : fixture.read(path, method, body))
  await fixture.workspace.prepare('guest', 'left', 8, true)
  expect(fixture.workspace.getSnapshot()).toMatchObject({ pending: null, fresh: false })
  expect(fixture.workspace.getSnapshot().error).toContain('rejected')
  await fixture.workspace.refresh()
  expect(writes(fixture)).toHaveLength(1)
})

it.each(['account', 'assignment', 'household', 'capability'] as const)('withdraws private state after a %s change', async (kind) => {
  const fixture = setup()
  await fixture.workspace.refresh()
  await fixture.workspace.prepare('guest', 'right', 12, true)
  if (kind === 'account') fixture.session.accountId = randomUUID()
  if (kind === 'assignment') fixture.session.assignmentRevision++
  if (kind === 'household') fixture.session.householdRevision++
  if (kind === 'capability') fixture.session.capabilities.temporaryArrangementReview = false
  await fixture.workspace.refresh()
  expect(fixture.workspace.getSnapshot().review).toBeNull()
  expect(fixture.invalidated).toHaveBeenCalledTimes(kind === 'capability' ? 0 : 1)
})

it.each(['wall', 'uptime', 'backward'] as const)('withdraws old reviews after %s clock changes', async (kind) => {
  const fixture = setup()
  await fixture.workspace.refresh()
  if (kind === 'wall') fixture.clock.now += 31_000
  if (kind === 'uptime') fixture.clock.uptime += 31_000
  if (kind === 'backward') fixture.clock.now -= 1000
  fixture.workspace.tick()
  expect(fixture.workspace.canChange()).toBe(false)
  await fixture.workspace.prepare('guest', 'right', 12, true)
  expect(writes(fixture)).toHaveLength(0)
})

it('requires recording acknowledgment, bounded duration and assigned partners before a swap', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  await fixture.workspace.prepare('guest', 'right', 12, false)
  await fixture.workspace.prepare('guest', 'right', 100, true)
  await fixture.workspace.prepare('side_swap', 'right', 12, true)
  expect(writes(fixture)).toHaveLength(0)
})

it('does not approve an expired or stale assignment review but allows cancellation', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  await fixture.workspace.prepare('guest', 'right', 12, true)
  if (!fixture.saved.review) throw new Error('Missing fixture')
  fixture.saved.review.reviewExpiresAt = fixture.clock.now
  await fixture.workspace.refresh()
  await fixture.workspace.approve(true)
  expect(writes(fixture)).toHaveLength(1)
  await fixture.workspace.cancel()
  expect(fixture.workspace.getSnapshot().review?.state).toBe('cancelled')
})

it('rejects another person’s response and discards a request finishing after clear', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  await fixture.workspace.prepare('guest', 'right', 12, true)
  if (!fixture.saved.review) throw new Error('Missing fixture')
  fixture.saved.review.sleeperId = randomUUID()
  await fixture.workspace.refresh()
  expect(fixture.workspace.getSnapshot().review).toBeNull()
  expect(fixture.invalidated).toHaveBeenCalledOnce()
  const other = setup()
  other.client.read.mockImplementation(async (path, method, body) => {
    const value = await other.read(path, method, body)
    if (path !== 'household/session') other.workspace.clear()
    return value
  })
  await other.workspace.refresh()
  expect(other.workspace.getSnapshot()).toMatchObject({ review: null, loaded: false, busy: false })
})

it('allows only strict private review paths and methods', () => {
  const root = 'household/temporary-arrangement', reviewId = randomUUID()
  expect(personalTemporaryPath(root, 'GET', undefined)).toBe(true)
  expect(personalTemporaryPath(`${root}/${reviewId}`, 'GET', undefined)).toBe(true)
  for (const path of [`${root}/activate`, `${root}/return`, `${root}/${reviewId}?private=true`, `${root}/../me/bed`, `${root}/approve`])
    expect(personalTemporaryPath(path, 'GET', undefined)).toBe(false)
  expect(personalTemporaryPath(root, 'POST', { kind: 'guest' })).toBe(false)
  expect(personalTemporaryPath(root, 'PUT', undefined)).toBe(false)
  expect(personalTemporaryPath(root, 'GET', {})).toBe(false)
})

it('keeps failed reads uneditable after ticks while retaining only dated personal review content', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  await fixture.workspace.prepare('guest', 'right', 12, true)
  fixture.client.read.mockImplementation((path, method, body) => path === 'household/session'
    ? fixture.read(path, method, body)
    : Promise.reject(new Error('Unavailable')))
  await fixture.workspace.refresh()
  fixture.workspace.tick()
  expect(fixture.workspace.getSnapshot()).toMatchObject({ loaded: true, fresh: false })
  expect(fixture.workspace.canChange()).toBe(false)
  expect(fixture.workspace.getSnapshot().review?.self.displayName).toBe('Example sleeper')
})

it('checks continued account access and clears saved content when it is revoked', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  await fixture.workspace.prepare('guest', 'right', 12, true)
  fixture.session.sessionRevision++
  await fixture.workspace.checkAccess()
  expect(fixture.invalidated).toHaveBeenCalledOnce()
  expect(fixture.workspace.getSnapshot().review).toBeNull()
})

it('rejects an invalid response timezone before it can reach the renderer', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  await fixture.workspace.prepare('guest', 'right', 12, true)
  if (!fixture.saved.review) throw new Error('Missing fixture')
  fixture.saved.review.timeZone = 'Invalid/Place'
  await fixture.workspace.refresh()
  expect(fixture.workspace.getSnapshot().fresh).toBe(false)
  expect(fixture.workspace.getSnapshot().review?.timeZone).toBe('America/Los_Angeles')
})

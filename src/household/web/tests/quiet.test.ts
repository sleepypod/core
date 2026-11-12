import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { z } from 'zod'
import preparation from '../../fixtures/preparation-v1.json'
import { householdSessionSchema } from '../../contract'
import type { quietReceiptSchema } from '../../quietContract'
import { quietWriteSchema } from '../../quietContract'
import { PersonalQuietWorkspace } from '../quiet'
import { PersonalWebError } from '../protocol'
import { PersonalBrowserClient } from '../client'

function setup() {
  const session = householdSessionSchema.parse({ ...preparation.ownerSession,
    capabilities: { ...preparation.ownerSession.capabilities, householdQuiet: true } })
  const clock = { now: Date.parse('2026-11-12T08:00:00Z'), uptime: 1000 }
  const saved = { revision: null as string | null, until: null as number | null, otherUntil: null as number | null }
  const receipts = new Map<string, z.infer<typeof quietReceiptSchema>>()
  const envelope = () => ({ version: 1, generatedAt: clock.now,
    scope: { podId: session.podId, householdId: session.householdId, accountId: session.accountId,
      sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
      assignmentRevision: session.assignmentRevision, householdRevision: session.householdRevision } })
  const read = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (path === 'household/session') return structuredClone(session)
    if (method === 'POST') {
      const request = quietWriteSchema.parse(body)
      if (request.expectedRevision !== saved.revision) throw new PersonalWebError('conflict', 'Changed')
      const receipt = { requestId: request.requestId, revision: randomUUID(), savedAt: clock.now, until: request.until }
      receipts.set(request.requestId, receipt)
      Object.assign(saved, { revision: receipt.revision, until: receipt.until })
      return { ...envelope(), receipt }
    }
    if (path.startsWith('me/quiet/requests/')) return { ...envelope(), receipt: receipts.get(path.split('/').at(-1) ?? '') ?? null }
    const mine = saved.until !== null && saved.until > clock.now ? saved.until : null
    const ends = [mine, saved.otherUntil].filter((value): value is number => value !== null && value > clock.now)
    return { ...envelope(), mine: { revision: saved.revision, until: mine }, shared: { paused: ends.length > 0, until: ends.length ? Math.max(...ends) : null } }
  }
  const client = { read: vi.fn(read), dispose: vi.fn() }, invalidated = vi.fn()
  const workspace = new PersonalQuietWorkspace({ session: structuredClone(session), client, invalidated,
    now: () => clock.now, uptime: () => clock.uptime })
  return { clock, session, saved, receipts, envelope, read, client, invalidated, workspace }
}
const writes = (fixture: ReturnType<typeof setup>) => fixture.client.read.mock.calls.filter(([, method]) => method === 'POST')

it('refreshes without writing, then ends only the signed-in person’s request', async () => {
  const fixture = setup()
  fixture.saved.otherUntil = fixture.clock.now + 3_600_000
  await fixture.workspace.refresh()
  expect(writes(fixture)).toHaveLength(0)
  await fixture.workspace.change(120)
  expect(fixture.workspace.getSnapshot()).toMatchObject({ fresh: true, pending: null, page: {
    mine: { until: fixture.clock.now + 7_200_000 }, shared: { paused: true, until: fixture.clock.now + 7_200_000 } } })
  await fixture.workspace.change(null)
  expect(fixture.workspace.getSnapshot()).toMatchObject({ fresh: true, pending: null, page: {
    mine: { until: null }, shared: { paused: true, until: fixture.saved.otherUntil } } })
  expect(writes(fixture)).toHaveLength(2)
})

it('reconciles a lost committed reply using reads and preserves the other person’s request', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  fixture.client.read.mockImplementation(async (path, method, body) => {
    const response = await fixture.read(path, method, body)
    if (method === 'POST') throw new Error('Lost response')
    return response
  })
  await fixture.workspace.change(60)
  await fixture.workspace.refresh()
  expect(fixture.workspace.getSnapshot().error).toContain('not confirmed')
  await fixture.workspace.change(480)
  await fixture.workspace.reconcile()
  expect(writes(fixture)).toHaveLength(1)
  expect(fixture.workspace.getSnapshot()).toMatchObject({ pending: null, error: null, fresh: true })
})

it('keeps a missing receipt uncertain until its command has expired on the controller clock', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  fixture.client.read.mockImplementation((path, method, body) => method === 'POST'
    ? Promise.reject(new Error('Never received'))
    : fixture.read(path, method, body))
  await fixture.workspace.change(60)
  await fixture.workspace.reconcile()
  expect(fixture.workspace.getSnapshot().pending).not.toBeNull()
  fixture.clock.now += 31_000
  fixture.clock.uptime += 31_000
  await fixture.workspace.reconcile()
  expect(fixture.workspace.getSnapshot()).toMatchObject({ pending: null, fresh: true })
  expect(fixture.workspace.getSnapshot().message).toContain('expired without a saved result')
  expect(writes(fixture)).toHaveLength(1)
})

it.each(['stale', 'future', 'monotonic', 'end'])('withdraws %s status without inferring that shared quiet ended', async (kind) => {
  const fixture = setup()
  fixture.saved.otherUntil = fixture.clock.now + 1000
  await fixture.workspace.refresh()
  if (kind === 'stale') fixture.clock.now += 16_000
  if (kind === 'future') fixture.clock.now -= 6000
  if (kind === 'monotonic') fixture.clock.uptime += 16_000
  if (kind === 'end') fixture.clock.now += 1000
  fixture.workspace.tick()
  expect(fixture.workspace.getSnapshot().fresh).toBe(false)
  await fixture.workspace.change(60)
  expect(writes(fixture)).toHaveLength(0)
})

it('rejects a newer revision rather than overwriting another device’s request', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  fixture.saved.revision = randomUUID()
  await fixture.workspace.change(60)
  expect(writes(fixture)).toHaveLength(0)
  expect(fixture.workspace.getSnapshot().error).toContain('another device')
})

it.each(['account', 'assignment', 'household', 'disabled'])('withdraws private state after %s changes', async (kind) => {
  const fixture = setup()
  await fixture.workspace.refresh()
  if (kind === 'account') fixture.session.accountId = randomUUID()
  if (kind === 'assignment') fixture.session.assignmentRevision += 1
  if (kind === 'household') fixture.session.householdRevision += 1
  if (kind === 'disabled') fixture.session.capabilities.householdQuiet = false
  await fixture.workspace.refresh()
  expect(fixture.workspace.getSnapshot()).toMatchObject({ page: null, fresh: false, pending: null })
  expect(fixture.invalidated).toHaveBeenCalledTimes(kind === 'disabled' ? 0 : 1)
})

it('does not display a late response after the view is hidden', async () => {
  const fixture = setup()
  let release!: (value: unknown) => void
  fixture.client.read.mockImplementation((path, method, body) => path === 'me/quiet'
    ? new Promise((resolve) => { release = resolve })
    : fixture.read(path, method, body))
  const reading = fixture.workspace.refresh()
  await vi.waitFor(() => expect(release).toBeDefined())
  fixture.workspace.clear()
  release(await fixture.read('me/quiet'))
  await reading
  expect(fixture.workspace.getSnapshot()).toMatchObject({ page: null, fresh: false })
})

it('does not accept a receipt for a different request', async () => {
  const fixture = setup()
  await fixture.workspace.refresh()
  fixture.client.read.mockImplementation(async (path, method, body) => {
    const response = await fixture.read(path, method, body)
    if (method === 'POST') return { ...fixture.envelope(), receipt: { ...[...fixture.receipts.values()][0], requestId: randomUUID() } }
    return response
  })
  await fixture.workspace.change(60)
  expect(fixture.workspace.getSnapshot().pending).not.toBeNull()
  expect(fixture.workspace.getSnapshot().message).toBeNull()
})

it('admits only exact personal quiet routes and validated writes', async () => {
  const fixture = setup(), fetcher = vi.fn<typeof fetch>(async () => new Response('{}'))
  const client = new PersonalBrowserClient(fixture.session, fetcher)
  await client.read('me/quiet')
  await client.read(`me/quiet/requests/${randomUUID()}`)
  await fixture.workspace.refresh()
  await fixture.workspace.change(60)
  const request = writes(fixture)[0][2]
  await client.read('me/quiet', 'POST', request)
  for (const path of ['me/quiet?account=other', 'me/quiet#fragment', 'me/quiet/requests/bad', 'me/quiet/requests/../other'])
    await expect(client.read(path)).rejects.toThrow()
  await expect(client.read('me/quiet', 'POST', { ...request as object, until: -1 })).rejects.toThrow()
  await expect(client.read('me/quiet', 'PUT', request)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(3)
})

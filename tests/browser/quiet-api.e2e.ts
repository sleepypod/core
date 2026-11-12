import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes, randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { householdSessionSchema } from '../../src/household/contract'
import { quietReadResponseSchema, quietWriteResponseSchema } from '../../src/household/quietContract'

const runFixture = promisify(execFile)
const secret = () => randomBytes(32).toString('base64url')
test('production personal routes preserve independent quiet requests and unchanged routines', async ({ request }) => {
  const original = (await runFixture('pnpm', ['exec', 'tsx', 'tests/browser/fixture.ts', 'household-prepare'], { env: process.env }))
    .stdout.trim().split('\n').at(-1)
  if (!original) throw new Error('Missing original fixture arrangement')
  const owner = secret(), member = secret(), invite = secret()
  const headers = (token: string) => ({ authorization: `Bearer ${token}` })
  const context = () => ({ requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1 })
  try {
    const setup = await request.post('/api/v1/household/setup', { headers: headers(process.env.SLEEPYPOD_AUTH_TOKEN ?? ''),
      data: { requestId: randomUUID(), displayName: 'Quiet fixture owner', deviceName: 'Browser fixture', deviceSecret: owner,
        currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true } })
    expect(setup.status()).toBe(200)
    expect(householdSessionSchema.parse(await setup.json()).capabilities.householdQuiet).toBe(true)
    const invitation = await request.post('/api/v1/household/invitations', { headers: headers(owner),
      data: { ...context(), kind: 'new_person', invitation: invite, expiresInMinutes: 30 } })
    expect(invitation.status()).toBe(200)
    const joined = await request.post('/api/v1/household/join', { data: { invitation: invite,
      displayName: 'Quiet fixture partner', deviceName: 'Other browser', deviceSecret: member } })
    expect(joined.status()).toBe(200)
    const before = await (await request.get('/api/v1/me/routines', { headers: headers(owner) })).json()
    const now = Date.now()
    const ownerRequest = { ...context(), issuedAt: now, expiresAt: now + 60_000, expectedRevision: null, until: now + 7_200_000 }
    const saved = await request.post('/api/v1/me/quiet', { headers: headers(owner), data: ownerRequest })
    expect(saved.status()).toBe(200)
    const ownerReceipt = quietWriteResponseSchema.parse(await saved.json()).receipt
    expect(ownerReceipt).not.toBeNull()
    const partner = await request.post('/api/v1/me/quiet', { headers: headers(member),
      data: { ...context(), issuedAt: now, expiresAt: now + 60_000, expectedRevision: null, until: now + 3_600_000 } })
    expect(partner.status()).toBe(200)
    const cleared = await request.post('/api/v1/me/quiet', { headers: headers(owner),
      data: { ...context(), issuedAt: now, expiresAt: now + 60_000, expectedRevision: ownerReceipt?.revision, until: null } })
    expect(cleared.status()).toBe(200)
    const retried = await request.post('/api/v1/me/quiet', { headers: headers(owner), data: ownerRequest })
    expect(quietWriteResponseSchema.parse(await retried.json()).receipt).toEqual(ownerReceipt)
    const reading = await request.get('/api/v1/me/quiet', { headers: headers(owner) })
    expect(reading.status()).toBe(200)
    expect(reading.headers()['cache-control']).toContain('no-store')
    const state = quietReadResponseSchema.parse(await reading.json())
    expect(state.mine.until).toBeNull()
    expect(state.shared).toEqual({ paused: true, until: now + 3_600_000 })
    const otherReceipt = await request.get(`/api/v1/me/quiet/requests/${ownerRequest.requestId}`, { headers: headers(member) })
    expect(quietWriteResponseSchema.parse(await otherReceipt.json()).receipt).toBeNull()
    const denied = await request.get('/api/v1/me/quiet', { headers: headers(process.env.SLEEPYPOD_AUTH_TOKEN ?? '') })
    expect(denied.status()).toBe(401)
    expect(await (await request.get('/api/v1/me/routines', { headers: headers(owner) })).json()).toEqual(before)
  }
  finally {
    await runFixture('pnpm', ['exec', 'tsx', 'tests/browser/fixture.ts', 'household-cleanup', original], { env: process.env })
  }
})

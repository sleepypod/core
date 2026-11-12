import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { executionFixture } from '@/src/comfort/experiments/tests/executionFixture'
import { ExperimentExecutionHost } from '@/src/comfort/experiments/execution'
import { ExperimentExecutionIdentity, personalExperimentAccess } from '@/src/comfort/experiments/execution-access'
import { ComfortExperimentService } from '@/src/comfort/experiments/service'
import { ComfortExperimentStore } from '@/src/comfort/experiments/store'
import { readExperimentAvailability } from '@/src/comfort/experiments/access'
import { createScheduledExperimentPlan } from '@/src/comfort/experiments/plan'
import { resolveExperimentSchedule } from '@/src/comfort/experiments/schedule'
import { HouseholdStore } from '../store'
import { PersonalRuntimeAuthority } from '../runtimeAuthority'
import { PersonalExperimentApi } from '../experimentApi'
import { householdHttp } from '../http'

const fixtures: { host: ExperimentExecutionHost, close(): void }[] = []
async function fixture() {
  const test = await executionFixture()
  await test.host.stop()
  await test.qualifyRight()
  const identities = new HouseholdStore(test.database, test.now), ownerKey = randomBytes(32).toString('base64url')
  const owner = identities.setup({ requestId: randomUUID(), displayName: 'Synthetic owner', deviceName: 'Synthetic phone',
    deviceSecret: ownerKey, currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  const invitation = identities.createInvitation(ownerKey, { requestId: randomUUID(), expectedSessionRevision: 1,
    expectedAssignmentRevision: 1, kind: 'new_person', invitation: randomBytes(32).toString('base64url'), expiresInMinutes: 30 })
  const memberKey = randomBytes(32).toString('base64url')
  identities.join({ invitation: invitation.invitation, displayName: 'Synthetic partner', deviceName: 'Synthetic second phone', deviceSecret: memberKey })
  const authority = new PersonalRuntimeAuthority(test.database, identities, () => true)
  const identity = new ExperimentExecutionIdentity(test.database, identities, authority, () => null)
  const access = personalExperimentAccess(identities.session(ownerKey), authority.resolve(ownerKey))
  const availability = readExperimentAvailability(test.database, access)
  if (!availability.context || !availability.schedule) throw new Error('Synthetic personal schedule missing')
  const plan = createScheduledExperimentPlan(availability.context, 74,
    resolveExperimentSchedule(availability.schedule, test.plan.firstNightDate, test.now()), test.now())
  new ComfortExperimentStore(test.database, access.subjectKey, test.now).create(plan)
  const host = new ExperimentExecutionHost({ ...test.deps,
    subject: principal => identity.subject(principal), resolve: principal => identity.resolve(principal) })
  fixtures.push({ host, close: () => test.database.close() })
  await host.start()
  const dependencies = { store: identities, verifySoloConfiguration: () => true,
    personalExperiments: new PersonalExperimentApi(identities, authority,
      new ComfortExperimentService(test.database, test.now), test.now,
      async credential => ({ host, principal: () => identity.personalPrincipal(credential) })) }
  const call = (action = '', body?: unknown, key: string | null = ownerKey, extra: Record<string, string> = {}) => householdHttp(
    new Request(`http://pod.test/api/v1/me/comfort-experiments/${plan.id}/execution${action}`, {
      method: action ? 'POST' : 'GET', headers: { host: 'pod.test', ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), dependencies)
  return { ...test, host, identities, owner, ownerKey, memberKey, plan, call }
}
afterEach(async () => {
  for (const test of fixtures.splice(0)) {
    await test.host.stop()
    test.close()
  }
  vi.restoreAllMocks()
})

it('authenticates real personal execution routes, derives both solo zones and isolates the partner account', async () => {
  const test = await fixture()
  expect((await test.call('', undefined, null)).status).toBe(401)
  expect((await test.call('', undefined, test.memberKey)).status).toBe(404)
  expect((await test.call('/preview', { sides: ['right'] })).status).toBe(400)
  const prepared = await test.call('/preview', {})
  expect(prepared.status).toBe(200)
  const review = await prepared.json()
  expect(review.review.sides).toEqual(['left', 'right'])
  expect(review.scope.accountId).toBe(test.owner.accountId)
  const confirm = { reviewId: review.review.id, planHash: review.review.planHash, confirmed: true }
  expect((await test.call('/confirm', confirm, test.memberKey)).status).toBe(404)
  expect((await test.call('/confirm', confirm, test.ownerKey, { origin: 'https://foreign.test' })).status).toBe(403)
  const confirmed = await test.call('/confirm', confirm)
  expect(confirmed.status).toBe(200)
  const status = await confirmed.json()
  expect(status).toMatchObject({ state: 'admitted', admission: { sides: ['left', 'right'] } })
  expect(test.writes).not.toHaveBeenCalled()
  expect((await (await test.call('/cancel', { admissionId: status.admission.id })).json()).state).toBe('revoked')
  expect(test.host.admissions.claim('left')).toBeNull()
  expect(test.host.admissions.claim('right')).toBeNull()
})

it('returns an authentication error after device revocation during a queued confirmation', async () => {
  const test = await fixture(), prepared = await (await test.call('/preview', {})).json()
  let release!: () => void, entered!: () => void
  const arrived = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = test.deps.withSideLock('left', async () => {
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await arrived
  let enteredConfirm!: () => void
  const confirming = new Promise<void>((resolve) => {
    enteredConfirm = resolve
  })
  const originalConfirm = test.host.confirm.bind(test.host)
  vi.spyOn(test.host, 'confirm').mockImplementation((...parameters) => {
    const pending = originalConfirm(...parameters)
    enteredConfirm()
    return pending
  })
  const pending = test.call('/confirm', { reviewId: prepared.review.id, planHash: prepared.review.planHash, confirmed: true })
  await confirming
  test.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?').run(test.now(), test.owner.accountId)
  release()
  await held
  expect((await pending).status).toBe(401)
  expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_admissions').get()).toEqual({ count: 0 })
})

it('withdraws an execution response when its personal device is revoked before delivery', async () => {
  const test = await fixture(), pending = await test.call()
  expect(pending.status).toBe(200)
  test.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?').run(test.now(), test.owner.accountId)
  await expect(pending.text()).rejects.toThrow('changed')
})

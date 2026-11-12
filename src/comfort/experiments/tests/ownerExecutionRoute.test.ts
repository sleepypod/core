import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ownerRequest, TEST_OWNER_TOKEN } from '@/src/auth/tests/support'
import { HouseholdStore } from '@/src/household/store'
import { PersonalRuntimeAuthority } from '@/src/household/runtimeAuthority'
import { executionFixture } from './executionFixture'
import { ExperimentExecutionHost } from '../execution'
import { ExperimentExecutionIdentity } from '../execution-access'
import { experimentDigest, legacyExperimentAccess, readExperimentAvailability } from '../access'
import { createScheduledExperimentPlan } from '../plan'
import { resolveExperimentSchedule } from '../schedule'
import { ComfortExperimentStore } from '../store'

const runtime = vi.hoisted(() => ({ database: undefined as Database.Database | undefined,
  execution: vi.fn(), identity: vi.fn() }))
vi.mock('@/src/db', () => ({ get sqlite() {
  return runtime.database
} }))
vi.mock('../execution-instance', () => ({ getExperimentExecution: runtime.execution, getExperimentExecutionIdentity: runtime.identity }))
const { handleOwnerExperimentRequest } = await import('../runtime')
let test: Awaited<ReturnType<typeof executionFixture>>, host: ExperimentExecutionHost, planId: string
function request(action = '', body?: unknown) {
  return ownerRequest(`http://pod.test/api/v1/comfort/experiments/${planId}/execution${action}`,
    body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
}
beforeEach(async () => {
  test = await executionFixture()
  await test.host.stop()
  await test.qualifyRight()
  runtime.database = test.database
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
  vi.spyOn(Date, 'now').mockImplementation(test.now)
  const identities = new HouseholdStore(test.database, test.now)
  const identity = new ExperimentExecutionIdentity(test.database, identities,
    new PersonalRuntimeAuthority(test.database, identities, () => true),
    () => experimentDigest(['owner-credential-revision', process.env.SLEEPYPOD_AUTH_TOKEN]))
  const access = legacyExperimentAccess(test.database), availability = readExperimentAvailability(test.database, access)
  if (!availability.context || !availability.schedule) throw new Error('Synthetic owner schedule missing')
  const plan = createScheduledExperimentPlan(availability.context, 74,
    resolveExperimentSchedule(availability.schedule, test.plan.firstNightDate, test.now()), test.now())
  new ComfortExperimentStore(test.database, access.subjectKey, test.now).create(plan)
  planId = plan.id
  host = new ExperimentExecutionHost({ ...test.deps,
    subject: principal => identity.subject(principal), resolve: principal => identity.resolve(principal) })
  runtime.execution.mockReturnValue(host)
  runtime.identity.mockReturnValue(identity)
  await host.start()
})
afterEach(async () => {
  await host?.stop()
  test?.database.close()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

it('authenticates before loading execution and routes owner review, confirmation, readback and cancellation', async () => {
  expect((await handleOwnerExperimentRequest(new Request(request().url))).status).toBe(401)
  expect(runtime.execution).not.toHaveBeenCalled()
  const prepared = await handleOwnerExperimentRequest(request('/preview', {}))
  expect(prepared.status).toBe(200)
  const preview = await prepared.json()
  expect(preview.review.sides).toEqual(['left', 'right'])
  const confirmed = await handleOwnerExperimentRequest(request('/confirm', {
    reviewId: preview.review.id, planHash: preview.review.planHash, confirmed: true,
  }))
  expect(confirmed.status).toBe(200)
  const status = await confirmed.json()
  expect((await (await handleOwnerExperimentRequest(request())).json()).admission.id).toBe(status.admission.id)
  const cancelled = await handleOwnerExperimentRequest(request('/cancel', { admissionId: status.admission.id }))
  expect((await cancelled.json()).state).toBe('revoked')
  expect(test.writes).not.toHaveBeenCalled()
})

it('withdraws pending owner execution output after token rotation', async () => {
  const pending = await handleOwnerExperimentRequest(request())
  expect(pending.status).toBe(200)
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', 'different-owner-credential-long-enough-for-authentication')
  await expect(pending.text()).rejects.toThrow('access changed')
})

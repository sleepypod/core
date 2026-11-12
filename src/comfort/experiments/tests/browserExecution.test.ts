import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { experimentExecutionBrowserRequest, readBrowserExperimentExecution } from '../browserExecution'
import { experimentExecutionResponse } from '../execution-http'
import { executionFixture } from './executionFixture'

const fixtures: Awaited<ReturnType<typeof executionFixture>>[] = []
afterEach(async () => {
  for (const test of fixtures.splice(0)) {
    await test.host.stop()
    test.database.close()
  }
})
async function fixture() {
  const test = await executionFixture()
  fixtures.push(test)
  const scope = { kind: 'legacy' as const, installationId: randomUUID() }
  test.access.scope = scope
  await test.admit()
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  await test.host.tick()
  const record = test.plans.read(test.plan.id)
  if (!record) throw new Error('Synthetic plan missing')
  const response = await experimentExecutionResponse(new Request(`http://pod.test/api/v1/comfort/experiments/${test.plan.id}/execution`),
    undefined, test.host, () => ({ access: test.access, principal: test.principal }), test.now)
  const payload = await response.json()
  return { ...test, scope, record, payload, read: (input: unknown) => readBrowserExperimentExecution(input, record, scope, test.now()) }
}

it('reads real execution receipts without treating acknowledgment as physical confirmation', async () => {
  const test = await fixture()
  const value = test.read(test.payload)
  expect(value.state).toBe('admitted')
  expect(value.applications[0]).toMatchObject({ outcome: 'acknowledged', acknowledgment: 'accepted_not_physically_verified', requestedTargetF: 74 })
})

it.each(['account', 'plan', 'state', 'expiry', 'zone', 'target', 'future', 'duplicate', 'promoted', 'resolution'] as const)(
  'withdraws a browser receipt with changed %s evidence', async (change) => {
    const test = await fixture(), payload = structuredClone(test.payload)
    if (change === 'account') payload.scope.installationId = randomUUID()
    if (change === 'plan') payload.planId = randomUUID()
    if (change === 'state') payload.state = 'revoked'
    if (change === 'expiry') payload.admission.endsAt++
    if (change === 'zone') payload.applications[0].side = 'right'
    if (change === 'target') payload.applications[0].requestedTargetF = 100
    if (change === 'future') payload.applications[0].finishedAt = test.now() + 1
    if (change === 'duplicate') payload.applications.push(payload.applications[0])
    if (change === 'promoted') payload.applications[0].outcome = 'unknown'
    if (change === 'resolution') {
      payload.applications[0].outcome = 'resolved'
      payload.applications[0].acknowledgment = 'unconfirmed'
      payload.applications[0].resolution = { observedAt: payload.applications[0].attemptedAt, resolvedAt: test.now(), targetF: 74 }
    }
    expect(() => test.read(payload)).toThrow()
  },
)

it('allows only exact execution paths and strict reviewed-action payloads', () => {
  const planId = randomUUID(), reviewId = randomUUID(), applicationId = randomUUID(), path = `${planId}/execution`
  expect(experimentExecutionBrowserRequest(path, 'GET')).toBe(true)
  expect(experimentExecutionBrowserRequest(`${path}/preview`, 'POST', {})).toBe(true)
  expect(experimentExecutionBrowserRequest(`${path}/confirm`, 'POST', { reviewId, planHash: 'a'.repeat(64), confirmed: true })).toBe(true)
  expect(experimentExecutionBrowserRequest(`${path}/cancel`, 'POST', { admissionId: reviewId })).toBe(true)
  expect(experimentExecutionBrowserRequest(`${path}/recover`, 'POST', { admissionId: reviewId, applicationId, confirmed: true })).toBe(true)
  for (const invalid of [`${path}?side=right`, `${path}/preview#confirm`, `${path}/preview/extra`, `../${path}`, `${path}/`])
    expect(experimentExecutionBrowserRequest(invalid, 'GET')).toBe(false)
  expect(experimentExecutionBrowserRequest(path, 'GET', {})).toBe(false)
  expect(experimentExecutionBrowserRequest(`${path}/confirm`, 'POST', { reviewId, planHash: 'a'.repeat(64), confirmed: false })).toBe(false)
  expect(experimentExecutionBrowserRequest(`${path}/recover`, 'POST', { admissionId: reviewId, applicationId, confirmed: true, observedAt: Date.now() })).toBe(false)
  expect(experimentExecutionBrowserRequest(`${path}/preview`, 'POST', { side: 'left', qualified: true })).toBe(false)
  expect(experimentExecutionBrowserRequest(path, 'DELETE')).toBe(false)
})

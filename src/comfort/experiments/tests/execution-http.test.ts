import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentExecutionResponse } from '../execution-http'
import { executionFixture } from './executionFixture'

const fixtures: Awaited<ReturnType<typeof executionFixture>>[] = []
async function fixture() {
  const test = await executionFixture()
  fixtures.push(test)
  const authorize = () => ({ access: test.access, principal: test.principal })
  const respond = (action = '', body?: unknown, method = action ? 'POST' : 'GET', signal?: AbortSignal) =>
    experimentExecutionResponse(new Request(`http://pod.test/api/v1/comfort/experiments/${test.plan.id}/execution${action}`, { method, signal }),
      body, test.host, authorize, test.now)
  const preview = async () => (await respond('/preview', {})).json()
  const confirm = async () => {
    const prepared = await preview()
    return (await respond('/confirm', { reviewId: prepared.review.id, planHash: prepared.review.planHash, confirmed: true })).json()
  }
  return { ...test, authorize, respond, preview, confirm }
}
afterEach(async () => {
  for (const test of fixtures.splice(0)) {
    await test.host.stop()
    test.database.close()
  }
  vi.restoreAllMocks()
})

it('previews actual qualification and admits once, with a read-only lost-response path', async () => {
  const test = await fixture()
  const preview = await test.preview()
  expect(preview).toMatchObject({ version: 1, planId: test.plan.id, state: 'not_admitted', admission: null,
    review: { sides: ['left'], expiresAt: test.now() + 60_000 } })
  expect(JSON.stringify(preview)).not.toMatch(/subjectKey|principal|deviceId|evidence|sourcePath|interruptionHash/)
  expect(test.host.admissions.current('left')).toBeNull()
  const input = { reviewId: preview.review.id, planHash: preview.review.planHash, confirmed: true }
  await test.respond('/confirm', input) // The caller loses the first reply.
  const recovered = await (await test.respond()).json()
  expect(recovered).toMatchObject({ state: 'admitted', admission: { id: preview.review.id }, applications: [] })
  await (await test.respond('/confirm', input)).json()
  expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_admissions').get()).toEqual({ count: 1 })
  expect(test.writes).not.toHaveBeenCalled()
  const head = await test.respond('', undefined, 'HEAD')
  expect(await head.text()).toBe('')
  expect(head.headers.get('cache-control')).toBe('private, no-store')
})

it('requires all actual qualification sources and never accepts fabricated evidence from a client', async () => {
  const test = await fixture()
  test.database.prepare('DELETE FROM comfort_qualifications').run()
  await expect(test.preview()).rejects.toThrow()
  await expect(test.respond('/preview', { zones: ['left'], qualified: true })).rejects.toThrow()
  expect(test.host.admissions.current('left')).toBeNull()
  expect(test.writes).not.toHaveBeenCalled()
})

it.each([
  ['/preview', 'GET', undefined], ['/preview', 'HEAD', undefined], ['', 'POST', {}],
  ['?side=right', 'GET', undefined], ['/confirm', 'POST', { reviewId: randomUUID(), planHash: '1'.repeat(64) }],
  ['/preview', 'POST', { targetF: 90 }], ['/recover', 'POST', { admissionId: randomUUID(), applicationId: randomUUID(), confirmed: true, observedAt: 123 }],
] as const)('rejects unsupported execution request %s %s', async (path, method, body) => {
  const test = await fixture()
  await expect(test.respond(path, body, method)).rejects.toThrow()
  expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_admissions').get()).toEqual({ count: 0 })
})

it('withholds a queued confirmation when the account changes while waiting for the side lock', async () => {
  const test = await fixture(), preview = await test.preview()
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
  const pending = test.respond('/confirm', { reviewId: preview.review.id, planHash: preview.review.planHash, confirmed: true })
  test.access.scope = { syntheticAccount: 'another-account' }
  release()
  await held
  await expect(pending).rejects.toThrow('changed')
  expect(test.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiment_admissions').get()).toEqual({ count: 0 })
})

it('withdraws delayed responses on account, content and cancellation changes', async () => {
  const test = await fixture(), confirmed = await test.confirm()
  const pendingAccount = await test.respond()
  test.access.scope = { syntheticAccount: 'changed' }
  await expect(pendingAccount.text()).rejects.toThrow('changed')
  const pendingContent = await test.respond()
  await test.host.cancel(test.principal, confirmed.admission.id, () => {})
  await expect(pendingContent.text()).rejects.toThrow('changed')
  const controller = new AbortController(), pendingAbort = await test.respond('', undefined, 'GET', controller.signal)
  controller.abort()
  await expect(pendingAbort.text()).rejects.toThrow('changed')
})

it('allows this account to read and cancel after its assignment becomes unavailable or the service stops', async () => {
  const test = await fixture()
  await test.qualifyRight()
  const confirmed = await test.confirm()
  await test.host.stop()
  test.deps.resolve = () => {
    throw new Error('Assignment unavailable')
  }
  const result = await (await test.respond('/cancel', { admissionId: confirmed.admission.id })).json()
  expect(result).toMatchObject({ controllerRunning: false, state: 'revoked', admission: { sides: ['left', 'right'] } })
  expect(test.host.admissions.claim('left')).toBeNull()
  expect(test.host.admissions.claim('right')).toBeNull()
  await (await test.respond('/cancel', { admissionId: confirmed.admission.id })).json()
  expect(test.writes).not.toHaveBeenCalled()
})

it('resolves an uncertain attempt only with later server readback and does not replay the write', async () => {
  const test = await fixture(), admitted = await test.confirm()
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  test.beforeApply(async () => {
    throw new Error('Synthetic lost firmware acknowledgment')
  })
  await test.host.tick()
  const status = await (await test.respond()).json(), attempt = status.applications[0]
  expect(attempt).toMatchObject({ outcome: 'unknown', acknowledgment: 'unconfirmed' })
  const input = { admissionId: admitted.admission.id, applicationId: attempt.id, confirmed: true }
  await expect(test.respond('/recover', input)).rejects.toThrow('fresh observation')
  test.advance(test.now() + 1)
  const result = await (await test.respond('/recover', input)).json()
  expect(result).toMatchObject({ state: 'revoked', applications: [{ outcome: 'resolved', acknowledgment: 'unconfirmed',
    resolution: { observedAt: test.now(), targetF: 75 } }] })
  const readback = vi.spyOn(test.deps, 'readback')
  await (await test.respond('/recover', input)).json()
  expect(readback).not.toHaveBeenCalled()
  expect(test.writes).not.toHaveBeenCalled()
  expect(test.host.admissions.current('left')).toBeNull()
})

it('rechecks recovery authority after firmware readback before retaining a resolution', async () => {
  const test = await fixture(), admitted = await test.confirm()
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  test.beforeApply(async () => {
    throw new Error('Synthetic lost firmware acknowledgment')
  })
  await test.host.tick()
  const status = await (await test.respond()).json()
  test.advance(test.now() + 1)
  test.deps.readback = () => {
    test.access.scope = { syntheticAccount: 'changed-during-readback' }
    return { targetF: 75, observedAt: test.now() }
  }
  await expect(test.respond('/recover', { admissionId: admitted.admission.id,
    applicationId: status.applications[0].id, confirmed: true })).rejects.toThrow('changed')
  expect(test.database.prepare('SELECT outcome FROM comfort_experiment_applications').get()).toEqual({ outcome: 'unknown' })
})

it('scopes plan and grant identifiers to the authenticated subject and selected plan', async () => {
  const test = await fixture(), preview = await test.preview()
  await expect(test.host.confirm(test.principal, preview.review.id, preview.review.planHash, () => {}, randomUUID())).rejects.toThrow('another experiment')
  const admitted = await test.confirm()
  await expect(test.host.cancel(test.principal, admitted.admission.id, () => {}, randomUUID())).rejects.toThrow('another experiment')
  test.deps.subject = () => 'f'.repeat(64)
  await expect(test.respond()).rejects.toThrow('not in your library')
  await expect(test.respond('/cancel', { admissionId: admitted.admission.id })).rejects.toThrow('not in your library')
  expect(test.host.admissions.claim('left')?.revokedAt).toBeNull()
})

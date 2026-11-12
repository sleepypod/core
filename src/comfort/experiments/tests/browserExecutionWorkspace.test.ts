import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { ComfortExperimentBrowserWorkspace } from '../browserWorkspace'
import { ComfortExperimentService } from '../service'
import { experimentResponse, experimentErrorResponse } from '../http'
import { experimentExecutionResponse, isExperimentExecutionRequest } from '../execution-http'
import { experimentBrowserProblem } from '../browserError'
import { executionFixture } from './executionFixture'

const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
})
async function fixture() {
  const test = await executionFixture()
  test.access.scope = { kind: 'legacy', installationId: randomUUID() }
  const service = new ComfortExperimentService(test.database, test.now)
  const controls = { lost: '', revision: 'original-account', beforeReply: (async () => {}) as (path: string) => Promise<void>,
    requests: [] as { path: string, method: string }[] }
  const workspace = new ComfortExperimentBrowserWorkspace({
    async access() {
      return { scope: structuredClone(test.access.scope) as { kind: 'legacy', installationId: string }, revision: controls.revision, execution: true }
    },
    async request(path, method, body) {
      controls.requests.push({ path, method })
      const request = new Request(`https://pod.invalid/api/v1/comfort/experiments/${path}`, { method })
      let response: Response
      try {
        response = isExperimentExecutionRequest(request)
          ? await experimentExecutionResponse(request, body, test.host, () => ({ access: test.access, principal: test.principal }), test.now)
          : experimentResponse(request, body, service, () => test.access, test.now)
      }
      catch (error) { response = experimentErrorResponse(error) }
      const result: unknown = await response.json()
      await controls.beforeReply(path)
      if (controls.lost && path.endsWith(controls.lost)) throw new Error('Simulated dropped response')
      if (!response.ok) throw experimentBrowserProblem(result)
      return result
    },
  }, test.now)
  disposals.push(async () => {
    workspace.dispose()
    await test.host.stop()
    test.database.close()
  })
  await workspace.select(test.plan.id)
  expect(workspace.getSnapshot().error).toBeNull()
  return { ...test, controls, workspace, firmwareWrites: test.writes, writes: () => controls.requests.filter(request => request.method === 'POST') }
}

it('opens a saved plan without admission, explicitly reviews and confirms, then stops control and plan', async () => {
  const test = await fixture(), { workspace } = test
  expect(workspace.getSnapshot().execution?.state).toBe('not_admitted')
  expect(test.writes()).toEqual([])
  await workspace.reviewExecution()
  expect(workspace.getSnapshot().execution?.review?.sides).toEqual(['left'])
  expect(test.host.describe(test.principal, test.plan.id).grant).toBeNull()
  await workspace.confirmExecution()
  expect(workspace.getSnapshot().execution?.state).toBe('admitted')
  expect(test.writes().map(request => request.path.split('/').at(-1))).toEqual(['preview', 'confirm'])
  expect(test.firmwareWrites).not.toHaveBeenCalled()
  await workspace.stop()
  expect(workspace.getSnapshot().error).toBeNull()
  expect(workspace.getSnapshot().detail?.record.status).toBe('stopped')
  expect(workspace.getSnapshot().execution?.state).toBe('revoked')
  expect(test.host.describe(test.principal, test.plan.id).grant?.reason).toBe('Cancelled by the sleeper')
})

it('a qualification failure preserves the plan and Stop access without inventing a review', async () => {
  const test = await fixture()
  test.database.prepare('DELETE FROM comfort_qualifications').run()
  await test.workspace.reviewExecution()
  expect(test.workspace.getSnapshot().error).not.toBeNull()
  expect(test.workspace.getSnapshot().detail?.record.plan.id).toBe(test.plan.id)
  expect(test.workspace.getSnapshot().execution?.review).toBeNull()
  await test.workspace.stop()
  expect(test.workspace.getSnapshot().detail?.record.status).toBe('stopped')
})

it('an expired review cannot authorize execution and background reads never renew it', async () => {
  const test = await fixture()
  await test.workspace.reviewExecution()
  const count = test.writes().length, review = test.workspace.getSnapshot().execution?.review
  expect(review).not.toBeNull()
  await test.workspace.checkAccess()
  expect(test.workspace.getSnapshot().execution?.review).toEqual(review)
  test.advance(test.now() + 60001)
  await test.workspace.confirmExecution()
  expect(test.workspace.getSnapshot().execution?.review).toBeNull()
  expect(test.workspace.getSnapshot().message).toContain('expired')
  expect(test.writes()).toHaveLength(count)
})

it('a lost admission is recovered by reading, including the main refresh action', async () => {
  const test = await fixture()
  await test.workspace.reviewExecution()
  test.controls.lost = '/execution/confirm'
  await test.workspace.confirmExecution()
  expect(test.workspace.getSnapshot().uncertain?.action).toBe('execution_confirm')
  expect(test.workspace.getSnapshot().detail).toBeNull()
  const writes = test.writes().length
  await test.workspace.open()
  expect(test.workspace.getSnapshot().execution?.state).toBe('admitted')
  expect(test.writes()).toHaveLength(writes)
})

it('a closed plan with a lost cancellation remains recoverable and no write is repeated', async () => {
  const test = await fixture()
  await test.workspace.reviewExecution()
  await test.workspace.confirmExecution()
  test.controls.lost = '/execution/cancel'
  await test.workspace.stop()
  expect(test.workspace.getSnapshot().uncertain).toMatchObject({ action: 'stop', planStopped: true })
  expect(test.workspace.getSnapshot().error).toContain('cancellation is not yet confirmed')
  const writes = test.writes().length
  await test.workspace.reconcile()
  expect(test.workspace.getSnapshot().detail?.record.status).toBe('stopped')
  expect(test.workspace.getSnapshot().execution?.state).toBe('revoked')
  expect(test.writes()).toHaveLength(writes)
})

it('a lost plan-closure reply leaves a visible retained admission which a new Stop can cancel', async () => {
  const test = await fixture()
  await test.workspace.reviewExecution()
  await test.workspace.confirmExecution()
  test.controls.lost = '/stop'
  await test.workspace.stop()
  const writes = test.writes().length
  await test.workspace.reconcile()
  expect(test.workspace.getSnapshot().detail?.record.status).toBe('stopped')
  expect(test.workspace.getSnapshot().execution?.state).toBe('admitted')
  expect(test.writes()).toHaveLength(writes)
  test.controls.lost = ''
  await test.workspace.stop()
  expect(test.workspace.getSnapshot().execution?.state).toBe('revoked')
})

it('closing a plan rejects another device trying to admit it before the cancellation read', async () => {
  const test = await fixture()
  const otherReview = await test.host.prepare(test.principal, test.plan.id, () => {})
  test.controls.beforeReply = async (path) => {
    if (path.endsWith('/stop')) await expect(test.host.confirm(test.principal, otherReview.id, otherReview.planHash, () => {})).rejects.toThrow()
  }
  await test.workspace.stop()
  expect(test.workspace.getSnapshot().detail?.record.status).toBe('stopped')
  expect(test.host.describe(test.principal, test.plan.id).grant).toBeNull()
})

it('background status reads reflect cancellation elsewhere without writing or re-reviewing', async () => {
  const test = await fixture()
  await test.workspace.reviewExecution()
  await test.workspace.confirmExecution()
  const grant = test.host.describe(test.principal, test.plan.id).grant
  if (!grant) throw new Error('Missing synthetic grant')
  await test.host.cancel(test.principal, grant.review.id, () => {})
  const writes = test.writes().length
  await test.workspace.checkAccess()
  expect(test.workspace.getSnapshot().execution?.state).toBe('revoked')
  expect(test.writes()).toHaveLength(writes)
})

it('a changed account after confirmation withdraws private content and never resends', async () => {
  const test = await fixture()
  await test.workspace.reviewExecution()
  test.controls.beforeReply = async (path) => {
    if (path.endsWith('/execution/confirm')) test.controls.revision = 'new-account'
  }
  await test.workspace.confirmExecution()
  expect(test.workspace.getSnapshot().detail).toBeNull()
  expect(test.workspace.getSnapshot().execution).toBeNull()
  expect(test.workspace.getSnapshot().uncertain).toBeNull()
})

it('explicit recovery reads a later firmware target, ends old permission and does not resend', async () => {
  const test = await fixture()
  await test.workspace.reviewExecution()
  await test.workspace.confirmExecution()
  test.beforeApply(async () => {
    throw new Error('Synthetic firmware result lost')
  })
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  await test.host.tick()
  test.advance(test.now() + 1000)
  await test.workspace.checkAccess()
  const application = test.workspace.getSnapshot().execution?.applications[0]
  expect(application?.outcome).toBe('unknown')
  if (!application) throw new Error('Missing synthetic application')
  const writes = test.writes().length
  await test.workspace.recoverExecution(application.id)
  expect(test.workspace.getSnapshot().error).toBeNull()
  expect(test.workspace.getSnapshot().execution?.state).toBe('revoked')
  expect(test.workspace.getSnapshot().execution?.applications[0]).toMatchObject({ outcome: 'resolved', acknowledgment: 'unconfirmed', resolution: { targetF: 75 } })
  expect(test.writes()).toHaveLength(writes + 1)
  expect(test.firmwareWrites).not.toHaveBeenCalled()
  expect(test.workspace.getSnapshot().message).toContain('No temperature command was replayed')
})

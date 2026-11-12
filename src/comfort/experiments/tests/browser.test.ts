import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { migratedComfortDatabase } from '../../tests/databaseFixture'
import { ComfortExperimentService } from '../service'
import { ComfortExperimentBrowserWorkspace, type ExperimentBrowserAccess } from '../browserWorkspace'
import { experimentBrowserRequest, experimentReviewSchema } from '../browserContract'
import { experimentResponse } from '../http'
import { context, createdAt, fixtureSchedule } from './fixture'
import { personalExperimentPath } from '@/src/household/web/experiments'
let database: Database.Database, service: ComfortExperimentService, workspace: ComfortExperimentBrowserWorkspace, now: number
let identity: ExperimentBrowserAccess
let lost: string | null, release: Promise<void> | null, altered: (value: unknown) => unknown
let requests: {
  path: string
  method: string
  body: unknown
}[]
const scope = { kind: 'legacy' as const, installationId: randomUUID() }
const access = () => ({ subjectKey: context.subjectKey, scope: identity.scope, binding: {}, routineSide: 'left' as const, ready: true })
beforeEach(() => {
  database = migratedComfortDatabase()
  now = createdAt
  lost = null
  release = null
  altered = value => value
  requests = []
  identity = { scope, revision: 'owner-session' }
  service = new ComfortExperimentService(database, () => now, () => ({ context, reason: 'Synthetic policy', schedule: fixtureSchedule() }))
  workspace = new ComfortExperimentBrowserWorkspace({
    async access() { return structuredClone(identity) },
    async request(path, method, body) {
      requests.push({ path, method, body })
      const request = new Request(`https://pod.invalid/api/v1/comfort/experiments${path.startsWith('?') || !path ? path : `/${path}`}`, { method })
      const result = await experimentResponse(request, body, service, access, () => now).json()
      if (release)
        await release
      if (lost === path)
        throw new Error('Simulated lost reply')
      return altered(result)
    },
  }, () => now)
})
afterEach(() => {
  workspace.dispose()
  database.close()
})
it('reviews, confirms and stops the real private service through the browser contract', async () => {
  await workspace.open()
  expect(workspace.getSnapshot().error).toBeNull()
  expect(workspace.getSnapshot().library?.experiments).toEqual([])
  await workspace.preview('2026-11-13', 69)
  const review = workspace.getSnapshot().review
  expect(review?.plan.version).toBe(2)
  expect(review?.nights).toHaveLength(16)
  expect(review?.schedule.windows[0].wake).toMatchObject({ temperatureF: 105, vibrationSeconds: 20 })
  await workspace.confirm()
  expect(workspace.getSnapshot().detail?.record.plan).toEqual(review?.plan)
  expect(workspace.getSnapshot().detail?.execution).toBe('planning_only')
  await workspace.stop()
  expect(workspace.getSnapshot().detail?.record.status).toBe('stopped')
  await workspace.confirm()
  expect(requests.filter(value => value.path === 'confirm')).toHaveLength(1)
})
it.each(['confirm', 'stop', 'feedback'] as const)('recovers a lost %s result by GET only', async (action) => {
  await workspace.preview('2026-11-13', 69)
  const id = workspace.getSnapshot().review?.reviewId
  expect(id).toBeDefined()
  if (action !== 'confirm')
    await workspace.confirm()
  lost = action === 'confirm' ? 'confirm' : `${id}/${action}`
  if (action === 'confirm')
    await workspace.confirm()
  else if (action === 'stop')
    await workspace.stop()
  else {
    now = Date.parse('2026-11-14T10:00:00Z')
    await workspace.feedback({ nightDate: '2026-11-13', confirmedFullNight: true, comfort: 8, unwantedAdjustments: 0, problem: false })
  }
  expect(workspace.getSnapshot().uncertain).toEqual({ id, action })
  expect(workspace.getSnapshot().detail).toBeNull()
  const writes = requests.filter(value => value.method === 'POST').length
  await workspace.reconcile()
  expect(workspace.getSnapshot().uncertain).toBeNull()
  expect(workspace.getSnapshot().detail?.record.status).toBe(action === 'stop' ? 'stopped' : 'planned')
  if (action === 'feedback')
    expect(workspace.getSnapshot().detail?.record.feedback[0].comfort).toBe(8)
  expect(requests.filter(value => value.method === 'POST')).toHaveLength(writes)
})
it('expires a review locally without submitting confirmation', async () => {
  await workspace.preview('2026-11-13', 69)
  now += 5 * 60000
  await workspace.confirm()
  expect(workspace.getSnapshot().review).toBeNull()
  expect(workspace.getSnapshot().message).toContain('expired')
  expect(requests.filter(value => value.path === 'confirm')).toEqual([])
})
it('clears private content on identity changes and rejects a response for another account', async () => {
  await workspace.open()
  identity = { ...identity, revision: 'another-session' }
  await workspace.checkAccess()
  expect(workspace.getSnapshot().library).toBeNull()
  await workspace.open()
  expect(workspace.getSnapshot().library).toBeNull()
  expect(requests).toHaveLength(1)
})
it('discards late replies after the page is hidden or disposed', async () => {
  let resolve = () => { }
  release = new Promise<void>((done) => {
    resolve = done
  })
  const opening = workspace.open()
  await new Promise(done => setTimeout(done, 5))
  workspace.clear()
  resolve()
  await opening
  expect(workspace.getSnapshot().library).toBeNull()
  expect(workspace.getSnapshot().busy).toBe(false)
})
it('will not confirm a changed order, schedule or target in a preview response', async () => {
  altered = (value) => {
    const review = experimentReviewSchema.parse(value)
    return { ...review, nights: [...review.nights].reverse() }
  }
  await workspace.preview('2026-11-13', 69)
  expect(workspace.getSnapshot().review).toBeNull()
  expect(workspace.getSnapshot().error).not.toBeNull()
})
it('rejects stale or future response clocks and withdraws earlier private results after a failed read', async () => {
  await workspace.open()
  expect(workspace.getSnapshot().library).not.toBeNull()
  for (const offset of [-120001, 60001]) {
    altered = value => ({ ...(value as object), generatedAt: now + offset })
    await workspace.open()
    expect(workspace.getSnapshot().library).toBeNull()
  }
})
it('saves subjective feedback without converting missing temperature exposure into a positive result', async () => {
  await workspace.preview('2026-11-13', 69)
  await workspace.confirm()
  now = Date.parse('2026-11-14T10:00:00Z')
  await workspace.feedback({ nightDate: '2026-11-13', confirmedFullNight: true, comfort: 9, unwantedAdjustments: 0, problem: false })
  const detail = workspace.getSnapshot().detail
  expect(detail?.record.feedback).toHaveLength(1)
  expect(detail?.record.exposures).toEqual([])
  expect(detail?.comparison.recommendation).toBe('inconclusive')
  expect(detail?.comparison.nights[0].exclusions).toContain('missing_exposure')
})
it('allowlists only scoped planning operations, never hardware writes or telemetry uploads', () => {
  const id = randomUUID(), expectedRevision = randomUUID()
  expect(experimentBrowserRequest('preview', 'POST', { firstNightDate: '2026-11-13', variantF: 69 })).toBe(true)
  expect(personalExperimentPath(`me/comfort-experiments/${id}/stop`, 'POST', { expectedRevision })).toBe(true)
  expect(personalExperimentPath(`me/comfort-experiments?afterId=${id}`, 'GET', undefined)).toBe(true)
  for (const path of ['me/comfort-experiments-other', 'me/comfort-experiments/../bed', `me/comfort-experiments/${id}/exposure`,
    `me/comfort-experiments/${id}/activate`, 'me/comfort-experiments?afterId=not-an-id', 'me/comfort-experiments#secret'])
    expect(personalExperimentPath(path, 'GET', undefined)).toBe(false)
  expect(experimentBrowserRequest('preview', 'POST', { firstNightDate: '2026-11-13', variantF: 69, side: 'right' })).toBe(false)
})

import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { migratedComfortDatabase } from '../../tests/databaseFixture'
import { ComfortExperimentService } from '../service'
import { experimentResponse, readExperimentBody } from '../http'
import type { ExperimentAccess } from '../access'
import { context, createdAt, fixtureSchedule } from './fixture'

let database: Database.Database, service: ComfortExperimentService, access: ExperimentAccess, now: number
const proposal = { firstNightDate: '2026-11-13', variantF: 69 }
function request(path = '', method = 'GET', signal?: AbortSignal) {
  return new Request(`http://pod.test/api/v1/comfort/experiments${path}`, { method, signal })
}
function respond(path = '', method = 'GET', body?: unknown, signal?: AbortSignal) {
  return experimentResponse(request(path, method, signal), body, service, () => access, () => now)
}
beforeEach(() => {
  database = migratedComfortDatabase()
  now = createdAt
  access = { subjectKey: context.subjectKey, scope: { account: 'first' }, binding: {}, routineSide: 'left', ready: true }
  service = new ComfortExperimentService(database, () => now, () => ({ context, reason: 'fixture', schedule: fixtureSchedule() }))
})
afterEach(() => database.close())

it('serves private preview, confirmation, detail, list and stop without accepting a plan from the client', async () => {
  const preview = await respond('/preview', 'POST', proposal).json()
  const confirmed = await respond('/confirm', 'POST', { reviewId: preview.reviewId, planHash: preview.planHash }).json()
  const detail = respond(`/${preview.reviewId}`)
  expect(detail.headers.get('cache-control')).toBe('private, no-store')
  expect(detail.headers.get('vary')).toContain('X-Sleepypod-Sleeper-Id')
  expect(await detail.json()).toEqual(confirmed)
  expect((await respond().json()).experiments).toHaveLength(1)
  expect((await respond(`/${preview.reviewId}/stop`, 'POST', { expectedRevision: confirmed.record.revision }).json()).record.status).toBe('stopped')
  expect(await respond('', 'HEAD').text()).toBe('')
})

it('withdraws delayed data on account switch, record update or request cancellation', async () => {
  const pendingAccount = respond()
  access = { ...access, scope: { account: 'second' } }
  await expect(pendingAccount.text()).rejects.toThrow('changed')
  const preview = await respond('/preview', 'POST', proposal).json()
  const confirm = { reviewId: preview.reviewId, planHash: preview.planHash }
  const saved = await respond('/confirm', 'POST', confirm).json(), pendingRecord = respond(`/${preview.reviewId}`)
  service.stop(access, preview.reviewId, { expectedRevision: saved.record.revision })
  await expect(pendingRecord.text()).rejects.toThrow('changed')
  const abort = new AbortController(), pendingAbort = respond('', 'GET', undefined, abort.signal)
  abort.abort()
  await expect(pendingAbort.text()).rejects.toThrow('changed')
})

it('rolls back a write if authority changes before the transaction is acknowledged', () => {
  database.pragma('synchronous = NORMAL')
  const review = service.prepare(access, proposal)
  let calls = 0
  const authorize = () => {
    calls++
    if (calls >= 3) throw new Error('fixture account revoked')
    return access
  }
  expect(() => experimentResponse(request('/confirm', 'POST'), { reviewId: review.reviewId, planHash: review.planHash }, service, authorize)).toThrow('revoked')
  expect(service.overview(access).experiments).toEqual([])
  expect(database.pragma('synchronous', { simple: true })).toBe(1)
})

it('uses durable synchronization for accepted writes, then restores the configured database mode', async () => {
  database.pragma('synchronous = NORMAL')
  const modes: number[] = []
  const response = experimentResponse(request('/preview', 'POST'), proposal, service, () => {
    modes.push(database.pragma('synchronous', { simple: true }) as number)
    return access
  }, () => now)
  await response.json()
  expect(modes).toContain(2)
  expect(database.pragma('synchronous', { simple: true })).toBe(1)
})

it.each(['/unknown/exposures', '?side=right', '?afterId=x', '/preview?side=right', '/preview/stop'])('rejects unsupported route or query %s', (path) => {
  expect(() => respond(path, path.includes('preview') ? 'POST' : 'GET', proposal)).toThrow()
})

it('rejects telemetry upload routes and never commits through a HEAD request', () => {
  expect(() => respond('/preview', 'HEAD', proposal)).toThrow()
  expect(() => respond('', 'POST', { exposures: [] })).toThrow()
  expect(service.overview(access).experiments).toEqual([])
})

it('limits input bytes and rejects invalid UTF-8, missing bodies and non-JSON formats', async () => {
  const upload = (body?: BodyInit, contentType = 'application/json') => new Request('http://pod.test', {
    method: 'POST', headers: { 'content-type': contentType }, body,
  })
  await expect(readExperimentBody(upload(JSON.stringify(proposal)))).resolves.toEqual(proposal)
  await expect(readExperimentBody(upload(' '.repeat(8193)))).rejects.toMatchObject({ status: 413 })
  await expect(readExperimentBody(upload(new Uint8Array([0xff])))).rejects.toMatchObject({ status: 400 })
  await expect(readExperimentBody(upload())).rejects.toMatchObject({ status: 400 })
  await expect(readExperimentBody(upload('{}', 'text/plain'))).rejects.toMatchObject({ status: 415 })
})

it('cancels an unfinished upload on abort without waiting for another chunk', async () => {
  const abort = new AbortController()
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{'))
  } })
  const incoming = new Request('http://pod.test', { method: 'POST', headers: { 'content-type': 'application/json' },
    body, signal: abort.signal, duplex: 'half' } as RequestInit)
  const pending = readExperimentBody(incoming)
  abort.abort()
  await expect(pending).rejects.toMatchObject({ status: 408 })
})

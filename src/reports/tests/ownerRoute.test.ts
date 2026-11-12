import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ownerRequest, TEST_OWNER_TOKEN } from '@/src/auth/tests/support'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import type { MorningReportStore } from '../store'
import { reportFixture } from './fixture'

const fixture = vi.hoisted(() => ({ database: undefined as Database.Database | undefined, readIdentity: vi.fn() }))
vi.mock('@/src/db', () => ({
  get sqlite() { return fixture.database },
}))
vi.mock('@/src/connections/read', () => ({ readConnectionIdentity: fixture.readIdentity }))
const { handleOwnerReportRequest } = await import('../runtime')
const shared = globalThis as typeof globalThis & { __sleepypodMorningReports?: MorningReportStore }
const installation = 'c5142bce-64cc-4f97-8df8-6a572155582e'
const address = 'http://pod.test/api/v1/reports'
beforeEach(() => {
  fixture.database = migratedComfortDatabase()
  fixture.readIdentity.mockReset().mockReturnValue(installation)
  delete shared.__sleepypodMorningReports
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
})
afterEach(() => {
  fixture.database?.close()
  delete shared.__sleepypodMorningReports
  vi.unstubAllEnvs()
})
const upload = (input = reportFixture()) => ownerRequest(`${address}/${input.report.id}`, { method: 'PUT',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: null, document: input }) })
function closeLegacyAccess() {
  const filename = process.env.DATABASE_URL
  if (!filename) throw new Error('Expected isolated privacy database')
  const database = new Database(filename)
  database.prepare('INSERT INTO household_privacy_boundary VALUES (1, ?, ?)').run(Date.now(), 'fixture personal boundary')
  database.close()
}

it('requires owner authentication before reading identity or accepting report storage', async () => {
  expect((await handleOwnerReportRequest(new Request(address))).status).toBe(401)
  expect((await handleOwnerReportRequest(new Request(address, { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401)
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', '')
  expect((await handleOwnerReportRequest(new Request(address))).status).toBe(503)
  expect(fixture.readIdentity).not.toHaveBeenCalled()
  expect(fixture.database?.prepare('SELECT COUNT(*) AS count FROM morning_reports').get()).toEqual({ count: 0 })
})

it('supports a real owner-key save, read, conditional delete and tombstone reconciliation', async () => {
  const input = reportFixture(), saved = await handleOwnerReportRequest(upload(input))
  expect(saved.status).toBe(200)
  const body = await saved.json()
  expect(body.report).toEqual(input.report)
  expect(body.scope).toEqual({ kind: 'legacy', installationId: installation })
  const listed = await handleOwnerReportRequest(ownerRequest(address))
  expect(listed.headers.get('cache-control')).toContain('no-store')
  expect((await listed.json()).reports).toHaveLength(1)
  const deleted = await handleOwnerReportRequest(ownerRequest(`${address}/${input.report.id}`, { method: 'DELETE',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: body.receipt.revision }) }))
  expect((await deleted.json()).receipt.deleted).toBe(true)
  expect((await handleOwnerReportRequest(upload(input))).status).toBe(409)
})

it('rejects another browser origin and the persistent personal-account boundary', async () => {
  const foreign = ownerRequest(address, { headers: { host: 'pod.test', origin: 'https://outside.test' } })
  expect((await handleOwnerReportRequest(foreign)).status).toBe(401)
  closeLegacyAccess()
  expect((await handleOwnerReportRequest(upload())).status).toBe(403)
  expect(fixture.readIdentity).not.toHaveBeenCalled()
})

it('withdraws selected content if the personal boundary closes before delivery', async () => {
  const input = reportFixture()
  await (await handleOwnerReportRequest(upload(input))).text()
  const pending = await handleOwnerReportRequest(ownerRequest(`${address}/${input.report.id}`))
  closeLegacyAccess()
  await expect(pending.text()).rejects.toThrow('access changed')
})

it('rejects a changed installation between selection and delivery', async () => {
  const pending = await handleOwnerReportRequest(ownerRequest(address))
  fixture.readIdentity.mockReturnValue('17aedc6f-25ac-4bcb-8e3d-d2d3c2c936f3')
  await expect(pending.text()).rejects.toThrow('changed before delivery')
})

it('does not initialize a report library for an already aborted request', async () => {
  const response = await handleOwnerReportRequest(ownerRequest(address, { signal: AbortSignal.abort() }))
  expect(response.status).toBe(408)
  expect(fixture.readIdentity).not.toHaveBeenCalled()
  expect(shared.__sleepypodMorningReports).toBeUndefined()
})

it('rechecks owner authentication after the complete upload and does not commit after key rotation', async () => {
  const input = reportFixture(), bytes = new TextEncoder().encode(JSON.stringify({ expectedRevision: null, document: input }))
  let uploadController!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    uploadController = controller
    controller.enqueue(bytes.slice(0, 10))
  } })
  const pending = handleOwnerReportRequest(ownerRequest(`${address}/${input.report.id}`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half',
  } as RequestInit))
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', 'a-new-owner-key-that-is-long-enough-for-authentication')
  uploadController.enqueue(bytes.slice(10))
  uploadController.close()
  expect((await pending).status).toBe(401)
  expect(fixture.database?.prepare('SELECT COUNT(*) AS count FROM morning_reports').get()).toEqual({ count: 0 })
})

it('keeps storage errors generic and never returns SQL or report contents as diagnostics', async () => {
  fixture.database?.exec('DROP TABLE morning_reports')
  const response = await handleOwnerReportRequest(ownerRequest(address))
  expect(response.status).toBe(503)
  expect(await response.text()).not.toMatch(/SELECT|morning_reports|SQL/)
})

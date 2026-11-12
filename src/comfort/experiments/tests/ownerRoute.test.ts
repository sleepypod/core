import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ownerRequest, TEST_OWNER_TOKEN } from '@/src/auth/tests/support'
import { migratedComfortDatabase } from '../../tests/databaseFixture'
import { createComfortLimitStore } from '@/src/temperature/limitStore'
import { dateInTimeZone } from '@/src/lib/timeZoneDate'

const fixture = vi.hoisted(() => ({ database: undefined as Database.Database | undefined }))
vi.mock('@/src/db', () => ({ get sqlite() {
  return fixture.database
} }))
const { handleOwnerExperimentRequest } = await import('../runtime')
function database(): Database.Database {
  if (!fixture.database) throw new Error('Fixture database missing')
  return fixture.database
}
const address = 'http://pod.test/api/v1/comfort/experiments'
const proposal = () => ({ firstNightDate: dateInTimeZone(Date.now(), 'UTC'), variantF: 71 })
const request = (path = '', body?: unknown) => ownerRequest(`${address}${path}`, body
  ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }
  : undefined)
beforeEach(() => {
  fixture.database = migratedComfortDatabase()
  fixture.database.exec(`INSERT INTO device_settings (id, bed_mode, unused_zone_mode, timezone) VALUES (1, 'solo-left', 'follow', 'UTC');
    INSERT INTO side_settings (side, name) VALUES ('left', 'Left'), ('right', 'Right');
    INSERT INTO power_schedules (side, day_of_week, on_time, off_time, off_day_offset, on_temperature) VALUES
      ('left', 'monday', '22:00', '07:15', 1, 70), ('left', 'tuesday', '22:00', '07:15', 1, 70);`)
  createComfortLimitStore(fixture.database).save('left', 0, { enabled: true, minF: 70, maxF: 72 })
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
})
afterEach(() => {
  fixture.database?.close()
  vi.unstubAllEnvs()
})
function closeLegacyAccess() {
  const filename = process.env.DATABASE_URL
  if (!filename) throw new Error('Expected isolated privacy database')
  const database = new Database(filename)
  database.prepare('INSERT INTO household_privacy_boundary VALUES (1, ?, ?)').run(Date.now(), 'fixture personal boundary')
  database.close()
}

it('requires owner authentication before initializing identity or reading records', async () => {
  expect((await handleOwnerExperimentRequest(new Request(address))).status).toBe(401)
  expect((await handleOwnerExperimentRequest(new Request(address, { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401)
  expect(database().prepare('SELECT COUNT(*) AS count FROM controller_connection_identity').get()).toEqual({ count: 0 })
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', '')
  expect((await handleOwnerExperimentRequest(new Request(address))).status).toBe(503)
})

it('supports authenticated owner preview, save, recovery and stop without changing existing settings', async () => {
  const before = database().prepare('SELECT * FROM device_settings').all()
  const preview = await (await handleOwnerExperimentRequest(request('/preview', proposal()))).json()
  expect(preview.scope.kind).toBe('legacy')
  const saved = await (await handleOwnerExperimentRequest(request('/confirm', { reviewId: preview.reviewId, planHash: preview.planHash }))).json()
  expect(saved.record.status).toBe('planned')
  const pending = await handleOwnerExperimentRequest(request(`/${preview.reviewId}`))
  expect((await pending.json()).record).toEqual(saved.record)
  const stopped = await handleOwnerExperimentRequest(request(`/${preview.reviewId}/stop`, { expectedRevision: saved.record.revision }))
  expect((await stopped.json()).record.status).toBe('stopped')
  expect(database().prepare('SELECT * FROM device_settings').all()).toEqual(before)
})

it('preserves same-origin and durable personal-account boundaries', async () => {
  const foreign = ownerRequest(address, { headers: { host: 'pod.test', origin: 'https://outside.test' } })
  expect((await handleOwnerExperimentRequest(foreign)).status).toBe(401)
  closeLegacyAccess()
  expect((await handleOwnerExperimentRequest(request('/preview', proposal()))).status).toBe(403)
})

it('withdraws a pending response after token rotation or personal-boundary closure', async () => {
  const pending = await handleOwnerExperimentRequest(request())
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', 'a-new-owner-key-long-enough-for-authentication')
  await expect(pending.text()).rejects.toThrow('access changed')
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
  const next = await handleOwnerExperimentRequest(request())
  closeLegacyAccess()
  await expect(next.text()).rejects.toThrow('access changed')
})

it('does not initialize identity for an already cancelled request', async () => {
  expect((await handleOwnerExperimentRequest(ownerRequest(address, { signal: AbortSignal.abort() }))).status).toBe(408)
  expect(database().prepare('SELECT COUNT(*) AS count FROM controller_connection_identity').get()).toEqual({ count: 0 })
})

it('rechecks owner credentials after upload and never exposes database error details', async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    writer = controller
  } })
  const pending = handleOwnerExperimentRequest(ownerRequest(`${address}/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
  } as RequestInit))
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', 'a-new-owner-key-long-enough-for-authentication')
  writer.enqueue(new TextEncoder().encode(JSON.stringify(proposal())))
  writer.close()
  expect((await pending).status).toBe(401)
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', TEST_OWNER_TOKEN)
  database().exec('DROP TABLE comfort_experiments')
  const broken = await handleOwnerExperimentRequest(request())
  expect(broken.status).toBe(503)
  expect(await broken.text()).not.toMatch(/SQL|SELECT|comfort_experiments/)
})

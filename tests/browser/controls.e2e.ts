import { randomUUID } from 'node:crypto'
import { test, expect } from './ownerTest'

test('control receipts enforce owner auth, expiry, duplicate protection and OpenAPI contract', async ({ request, playwright }) => {
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const now = Date.now()
  // Already-expired requests cannot reach either production actuator transport.
  const input = { requestId: randomUUID(), issuedAt: now - 60_000, expiresAt: now - 30_000, action: { kind: 'base.stop' } }
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  expect((await anonymous.post('/api/v1/controls', { data: input })).status()).toBe(401)
  expect((await anonymous.get(`/api/v1/controls/${input.requestId}`)).status()).toBe(401)
  expect((await anonymous.post('/api/trpc/controls.submit', { data: input })).status()).toBe(401)
  await anonymous.dispose()

  const response = await request.post('/api/v1/controls', { headers, data: input })
  expect(response.status(), await response.text()).toBe(200)
  const receipt = await response.json()
  expect(receipt).toMatchObject({ requestId: input.requestId, state: 'expired', dispatchCount: 0, physicalVerification: 'unverified', replayAllowed: false })
  const repeated = await request.post('/api/v1/controls', { headers, data: input })
  expect(await repeated.json()).toEqual(receipt)
  expect(await (await request.get(`/api/v1/controls/${input.requestId}`, { headers })).json()).toEqual(receipt)
  const conflict = await request.post('/api/v1/controls', { headers, data: { ...input, action: { kind: 'vibration.clear', side: 'right' } } })
  expect(conflict.status()).toBe(409)
  expect((await request.get(`/api/v1/controls/${randomUUID()}`, { headers })).status()).toBe(404)
  const malformed = await request.post('/api/v1/controls', { headers, data: { ...input, requestId: randomUUID(), expiresAt: input.issuedAt } })
  expect(malformed.status()).toBe(400)

  const capabilities = await (await request.get('/api/v1/capabilities', { headers })).json()
  expect(capabilities.endpoints.controls).toBe('/api/v1/controls')
  expect(capabilities.controlSemantics).toMatchObject({ receiptScope: 'versioned_controls_only', durableCommandReceipts: true, commandExpiry: true, maxLifetimeMs: 60000 })
  const document = await (await request.get('/api/openapi.json', { headers })).json()
  expect(document.paths['/v1/controls']).toHaveProperty('post')
  expect(document.paths['/v1/controls/{requestId}']).toHaveProperty('get')
})

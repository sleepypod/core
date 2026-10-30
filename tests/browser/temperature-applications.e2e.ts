import { expect, test } from './ownerTest'

test('temperature application history is authenticated, read-only and empty without physical writes', async ({ request, playwright }) => {
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  const endpoint = '/api/v1/device/temperature/applications'
  expect((await anonymous.get(`${endpoint}?side=left`)).status()).toBe(401)
  expect((await anonymous.get('/api/trpc/device.temperatureApplications?input=%7B%22json%22%3A%7B%22side%22%3A%22left%22%7D%7D')).status()).toBe(401)
  await anonymous.dispose()
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  for (const side of ['left', 'right']) {
    const response = await request.get(`${endpoint}?side=${side}`, { headers })
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ apiVersion: 1, side, items: [], nextBeforeId: null })
  }
  for (const query of ['side=other', 'side=left&beforeId=-1', 'side=left&beforeId=1.5']) {
    expect((await request.get(`${endpoint}?${query}`, { headers })).status()).toBe(400)
  }
  const document = await (await request.get('/api/openapi.json', { headers })).json()
  expect(document.paths['/v1/device/temperature/applications']?.get).toBeDefined()
  const capabilities = await (await request.get('/api/v1/capabilities', { headers })).json()
  expect(capabilities.endpoints.temperatureApplications).toBe(endpoint)
  expect(capabilities.features.temperatureApplicationHistory.implemented).toBe(true)
})

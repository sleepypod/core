import { test, expect } from './ownerTest'

test('Maintenance status is an administrative read with no browser authority or actuator route', async ({ page, playwright }) => {
  const address = '/api/v1/maintenance/status'
  const administrative = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218',
    storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` } })
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  try {
    expect((await anonymous.get(address)).status()).toBe(401)
    expect((await page.request.get(address)).status()).toBe(401)
    expect((await administrative.get(address, { headers: { Origin: 'http://127.0.0.1:3218' } })).status()).toBe(401)
    const response = await administrative.get(address)
    expect(response.status()).toBe(200)
    expect(response.headers()['cache-control']).toBe('private, no-store')
    const status = await response.json()
    expect(Object.keys(status).sort()).toEqual(['apiVersion', 'controller', 'device', 'generatedAt', 'kind', 'privacyBoundary', 'temperatureRuntime', 'thermalIdle'])
    expect(status).toMatchObject({ apiVersion: 1, kind: 'sleepypod-maintenance-status',
      controller: { id: 'sleepypod-core' }, device: { freshness: 'unavailable' }, thermalIdle: null, temperatureRuntime: 'not_ready' })
    expect(Object.keys(status.controller).sort()).toEqual(['id', 'revision'])
    expect(Object.keys(status.device)).toEqual(['freshness'])
    const head = await administrative.head(address)
    expect(head.status()).toBe(200)
    expect(await head.body()).toHaveLength(0)
    expect((await administrative.post(address, { data: { action: 'restart' } })).status()).toBe(405)
    expect((await administrative.get(`${address}?side=left`)).status()).toBe(400)
    for (const path of ['/api/v1/maintenance/restart', `${address}/anything`, '/api/settings']) {
      expect((await anonymous.get(path)).status()).toBe(401)
    }
  }
  finally {
    await administrative.dispose()
    await anonymous.dispose()
  }
})

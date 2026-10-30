import { test, expect } from './ownerTest'

test('bedroom devices retain provenance, reject unauthenticated writes and appear on web and tablet', async ({ page, request, playwright }, testInfo) => {
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  for (const path of ['/api/v1/home/bedroom', '/api/v1/home/bedroom/history', '/api/trpc/bedroom.status?input=%7B%22json%22%3A%7B%7D%7D']) {
    expect((await anonymous.get(path)).status()).toBe(401)
  }
  expect((await anonymous.post('/api/v1/home/bedroom/reports', { data: { reports: [] } })).status()).toBe(401)
  expect((await anonymous.put('/api/v1/home/bedroom/configuration', { data: {} })).status()).toBe(401)
  await anonymous.dispose()
  const initial = await (await request.get('/api/v1/home/bedroom', { headers })).json()
  expect(initial.config).toEqual({ enabled: false, roomName: 'Bedroom', sources: [] })
  const sources = [
    ...['left', 'right'].flatMap(side => [
      { id: `${side}-temperature`, deviceId: side, deviceName: `Fixture ${side} bedside`, location: side, provider: 'apple_home', metric: 'temperature', unit: '°F', label: 'Temperature', useForControl: true },
      { id: `${side}-humidity`, deviceId: side, deviceName: `Fixture ${side} bedside`, location: side, provider: 'apple_home', metric: 'humidity', unit: '%', label: 'Humidity', useForControl: true },
    ]),
    { id: 'monitor-temperature', deviceId: 'monitor', deviceName: 'Fixture air monitor', location: 'room', provider: 'homebridge', metric: 'temperature', unit: '°F', label: 'Temperature', useForControl: false },
    { id: 'monitor-particles', deviceId: 'monitor', deviceName: 'Fixture air monitor', location: 'room', provider: 'homebridge', metric: 'pm25', unit: 'µg/m³', label: 'Particles', useForControl: false },
    { id: 'purifier-power', deviceId: 'purifier', deviceName: 'Fixture purifier', location: 'room', provider: 'homebridge', metric: 'power', unit: 'on/off', label: 'Power', useForControl: false },
    { id: 'diffuser-power', deviceId: 'diffuser', deviceName: 'Fixture scent diffuser', location: 'room', provider: 'homebridge', metric: 'power', unit: 'on/off', label: 'Power', useForControl: false },
  ].map(source => ({ ...source, externalId: `fixture.${source.id}`, enabled: true, maxAgeSeconds: 120 }))
  const config = { enabled: true, roomName: 'Bedroom test fixture', sources }
  const saved = await request.put('/api/v1/home/bedroom/configuration', { headers, data: { expectedRevision: initial.revision, config } })
  expect(saved.ok()).toBeTruthy()
  const { revision } = await saved.json()
  expect((await request.put('/api/v1/home/bedroom/configuration', { headers, data: { expectedRevision: initial.revision, config } })).status()).toBe(409)
  const reports = sources.map(source => ({ schemaVersion: 1, revision, sourceId: source.id, available: true,
    value: source.id === 'monitor-temperature' ? 68 : source.metric === 'temperature' ? 76 : source.metric === 'humidity' ? 50 : source.id === 'diffuser-power' ? 0 : 1,
    observedAt: Date.now(), measuredAt: null, timeBasis: source.deviceId === 'monitor' ? 'cached' : 'device_read' }))
  const received = await request.post('/api/v1/home/bedroom/reports', { headers, data: { reports } })
  expect(received.ok()).toBeTruthy()
  expect((await received.json()).results.every((item: { accepted: boolean }) => item.accepted)).toBe(true)
  const statusResponse = await request.get('/api/v1/home/bedroom', { headers })
  expect(statusResponse.headers()['cache-control']).toContain('no-store')
  const status = await statusResponse.json()
  expect(status.guidance).toMatchObject({ state: 'ready', offsetF: -1 })
  expect(status.observations.find((item: { source: { id: string } }) => item.source.id === 'monitor-particles')).toMatchObject({ status: 'cached', value: null, controlEligible: false })
  await page.goto('/en/home')
  await expect(page.getByRole('heading', { name: 'Bedroom test fixture', exact: true })).toBeVisible()
  for (const name of ['Fixture left bedside', 'Fixture right bedside', 'Fixture air monitor', 'Fixture purifier', 'Fixture scent diffuser']) {
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  }
  await expect(page.getByText('Saved value · freshness unknown', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('Last reported: 68°F · cached, freshness unknown', { exact: true })).toBeVisible()
  await expect(page.getByText('Last reported: 1 µg/m³ · cached, freshness unknown', { exact: true })).toBeVisible()
  await expect(page.getByText('68°F', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('bedroom-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 834, height: 1194 })
  await page.screenshot({ path: testInfo.outputPath('bedroom-ipad.png'), fullPage: true })
  await page.goto('/en/schedule')
  await expect(page.getByRole('complementary', { name: 'Bedroom context for your routine' })).toContainText('76.0°F')
  await expect(page.getByRole('complementary', { name: 'Bedroom context for your routine' })).toContainText('Fixture air monitor · Temperature: Last reported 68°F · cached, freshness unknown')
  await expect(page.getByRole('complementary', { name: 'Bedroom context for your routine' })).toContainText('Saved routines and wake alarms keep priority')
  expect((await request.put('/api/v1/home/bedroom/configuration', { headers, data: { expectedRevision: revision, config: initial.config } })).ok()).toBeTruthy()
})

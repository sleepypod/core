import { test, expect } from './ownerTest'

test('water forecasting authenticates, rejects incomplete fitting and preserves controls', async ({ page, request, playwright }, testInfo) => {
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  for (const endpoint of ['/api/v1/comfort/forecast?side=left', '/api/v1/comfort/forecast/preview?side=left',
    '/api/trpc/comfort.waterForecast?input=%7B%22json%22%3A%7B%22side%22%3A%22left%22%7D%7D']) {
    expect((await anonymous.get(endpoint)).status()).toBe(401)
  }
  expect((await anonymous.post('/api/v1/comfort/forecast/train', { data: {} })).status()).toBe(401)
  await anonymous.dispose()
  const before = await (await request.get('/api/v1/comfort?side=left', { headers })).json()
  const readiness = await (await request.get('/api/v1/comfort/forecast?side=left', { headers })).json()
  expect(readiness).toMatchObject({ completeNights: 0, requiredNights: 20, canTrain: false, model: null })
  expect((await request.post('/api/v1/comfort/forecast/train', { headers, data: { side: 'left', expectedDatasetHash: 'f'.repeat(64) } })).status()).toBe(409)
  expect((await request.post('/api/v1/comfort/forecast/train', { headers, data: { side: 'left', expectedDatasetHash: readiness.datasetHash } })).status()).toBe(412)
  expect((await request.post('/api/v1/comfort/forecast/train', { headers, data: { side: 'left', expectedDatasetHash: readiness.datasetHash, recordings: [] } })).status()).toBe(400)
  expect((await request.get('/api/v1/comfort/forecast?side=other', { headers })).status()).toBe(400)
  expect(await (await request.get('/api/v1/comfort/forecast/preview?side=left', { headers })).json()).toMatchObject({ predictions: [] })
  await page.goto('/en/autopilot')
  const card = page.getByRole('region', { name: 'Water temperature forecast' })
  await expect(card).toContainText('0 / 20')
  await expect(card.getByRole('button', { name: 'Train water forecast' })).toBeDisabled()
  await card.getByRole('button', { name: 'Refresh forecast' }).click()
  await expect(card).toContainText('Bed adjustments')
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`water-forecast-${width}.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  expect((await (await request.get('/api/v1/comfort?side=left', { headers })).json()).state).toEqual(before.state)
  expect((await (await request.get('/api/v1/comfort/forecast?side=left', { headers })).json()).model).toBeNull()
})

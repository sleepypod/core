import { test, expect } from './ownerTest'

test('Watch upload keeps breathing and SDNN separate and deduplicates a repeated export', async ({ page, request, playwright }, testInfo) => {
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const timestamp = Math.floor((Date.now() - 3_600_000) / 1000) * 1000
  const instant = new Date(timestamp).toISOString()
  const date = instant.replace('T', ' ').replace(/\.\d+Z$/, ' +0000')
  const record = (metric: string, value: number, unit: string, source = 'Apple Watch') =>
    `<Record type="HKQuantityTypeIdentifier${metric}" sourceName="${source}" startDate="${date}" endDate="${date}" value="${value}" unit="${unit}" />`
  const xml = `<HealthData>${[
    record('HeartRate', 62, 'count/min'), record('RespiratoryRate', 0.25, 'count/s'), record('HeartRateVariabilitySDNN', 0.048, 's'),
    record('HeartRate', 90, 'count/min', 'SleepyPod Watch'), record('RespiratoryRate', 25, 'count/min', 'Free Sleep Watch'),
  ].join('')}</HealthData>`
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  expect((await anonymous.post('/api/biometrics/watch-upload?side=left', { data: xml })).status()).toBe(401)
  expect((await anonymous.post('/api/biometrics/reference-samples', { data: {} })).status()).toBe(401)
  await anonymous.dispose()
  const params = { side: 'left', startDate: '2026-10-10T00:00:00Z', endDate: new Date().toISOString(), limit: '20000' }
  const originalVitals = await (await request.get('/api/biometrics/vitals', { headers, params })).json()
  const openapi = await (await request.get('/api/openapi.json', { headers })).json()
  expect(openapi.paths['/biometrics/reference-samples']).toHaveProperty('get')
  expect(openapi.paths['/biometrics/reference-samples']).toHaveProperty('post')

  await page.goto('/en/sleep?view=biometrics')
  await page.getByRole('button', { name: 'Upload Apple Watch data', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Watch SDNN stays separate')
  await dialog.getByLabel('Health export', { exact: true }).setInputFiles({ name: 'synthetic-export.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) })
  await dialog.getByRole('button', { name: 'Upload and sync', exact: true }).click()
  await expect(dialog.getByRole('status').filter({ hasText: 'Imported' })).toContainText('Imported 1 new heart-rate, 1 new breathing-rate and 1 new HRV samples')
  await dialog.screenshot({ path: testInfo.outputPath('watch-import.png') })
  await dialog.getByRole('button', { name: 'Upload and sync', exact: true }).click()
  await expect(dialog.getByRole('status').filter({ hasText: 'Imported' })).toContainText('Imported 0 new heart-rate, 0 new breathing-rate and 0 new HRV samples')

  for (const [metric, value] of [['breathing_rate', 15], ['hrv_sdnn', 48]] as const) {
    const response = await request.get('/api/biometrics/reference-samples', { headers, params: { side: 'left', metric, startDate: instant, endDate: instant } })
    expect(response.status(), await response.text()).toBe(200)
    expect(await response.json()).toEqual([{ timestamp: instant, value }])
    const other = await request.get('/api/biometrics/reference-samples', { headers, params: { side: 'right', metric, startDate: instant, endDate: instant } })
    expect(await other.json()).toEqual([])
  }
  const invalid = await request.post('/api/biometrics/reference-samples', { headers, data: { side: 'left', source: 'apple_watch', metric: 'hrv_rmssd', samples: [{ timestamp: timestamp / 1000, value: 48 }] } })
  expect(invalid.status()).toBe(400)
  expect(await (await request.get('/api/biometrics/vitals', { headers, params })).json()).toEqual(originalVitals)
})

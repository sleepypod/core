import { test, expect } from './ownerTest'

test('personal models require authentication and separate upload, preview and activation', async ({ page, request, playwright }, testInfo) => {
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const model = {
    version: 'Synthetic browser fixture', kind: 'forest', classes: ['wake', 'light', 'deep', 'rem'],
    featureContract: ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction'],
    trees: [{ f: [-1], t: [0], l: [-1], r: [-1], v: [[0, 1, 0, 0]] }],
    metrics: { nestedSelection: { kappa: 0.4, nights: 8 }, notes: 'Synthetic test metadata only' },
    testVectors: [{ inputs: { hrZ: 0, hrStdZ: 0, motionZ: 0, nightFraction: 0.5 }, expected: 1 }],
  }
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  expect((await anonymous.get('/api/sleep-stages/models?side=left')).status()).toBe(401)
  expect((await anonymous.post('/api/sleep-stages/models', { data: { side: 'left', model } })).status()).toBe(401)
  await anonymous.dispose()
  const openapi = await (await request.get('/api/openapi.json', { headers })).json()
  for (const path of ['/sleep-stages/models', '/sleep-stages/models/selected', '/sleep-stages/model', '/sleep-stages/model/active', '/sleep-stages/model/preview']) {
    expect(openapi.paths).toHaveProperty(path)
  }
  const originalStages = await (await request.get('/api/biometrics/sleep-stages', { headers, params: { side: 'left', sleepRecordId: '1' } })).json()
  expect(originalStages.stagedBy.engine).toBe('rules')

  await page.goto('/en/settings?section=sleep-stages')
  await page.getByLabel('Upload model', { exact: true }).setInputFiles({ name: 'candidate.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(model)) })
  await expect(page.getByRole('status').filter({ hasText: 'Model saved' })).toBeVisible()
  const saved = await (await request.get('/api/sleep-stages/models?side=left', { headers })).json()
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ version: model.version, selected: false, active: false, metrics: model.metrics })
  expect(await (await request.get('/api/sleep-stages/model?side=left', { headers })).json()).toMatchObject({ model: null, active: false })

  await page.getByRole('button', { name: 'Preview latest night', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Selection unchanged' })).toContainText('No overlapping Watch stages')
  expect(await (await request.get('/api/sleep-stages/model?side=left', { headers })).json()).toMatchObject({ model: null, active: false })
  await page.getByRole('button', { name: 'Use this model', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Model selected and active' })).toBeVisible()
  const staged = await (await request.get('/api/biometrics/sleep-stages', { headers, params: { side: 'left', sleepRecordId: '1' } })).json()
  expect(staged.stagedBy).toMatchObject({ engine: 'model', version: model.version, modelHash: saved[0].modelHash, reason: 'active_model' })
  expect(staged.stageView).toEqual(originalStages.stageView)
  const crossSide = await request.put('/api/sleep-stages/models/selected', { headers, data: { side: 'right', id: saved[0].id, active: true } })
  expect(crossSide.status()).toBe(404)
  expect(await (await request.get('/api/sleep-stages/models?side=right', { headers })).json()).toEqual([])

  await page.screenshot({ path: testInfo.outputPath('model-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Preview latest night', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('model-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  const replacement = await request.put('/api/sleep-stages/model', { headers, data: { side: 'left', model: { ...model, version: 'Second synthetic candidate' } } })
  expect(replacement.status(), await replacement.text()).toBe(200)
  expect(await (await request.get('/api/sleep-stages/model?side=left', { headers })).json()).toMatchObject({ active: false })
  const restored = await (await request.get('/api/biometrics/sleep-stages', { headers, params: { side: 'left', sleepRecordId: '1' } })).json()
  expect(restored.stagedBy.engine).toBe('rules')
})

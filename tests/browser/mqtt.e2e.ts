import { test, expect } from './ownerTest'

test('MQTT TLS requirement is enforced in the form and authenticated partial updates', async ({ page, request, playwright }, testInfo) => {
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  expect((await anonymous.patch('/api/mqtt/settings', { data: { enabled: true } })).status()).toBe(401)
  await anonymous.dispose()

  // This isolated fixture stays disabled throughout: no household broker or hardware is contacted.
  const initial = await request.patch('/api/mqtt/settings', { headers, data: {
    enabled: false, url: 'mqtt://127.0.0.1:1883', tlsEnabled: true,
  } })
  expect(initial.ok()).toBe(true)
  const rejected = await request.patch('/api/mqtt/settings', { headers, data: { enabled: true } })
  expect(rejected.status()).toBe(400)
  expect(await rejected.text()).toContain('TLS requires')
  expect(await (await request.get('/api/mqtt/settings', { headers })).json()).toMatchObject({ enabled: false, tlsEnabled: true })

  await page.goto('/en/settings?section=mqtt')
  const bridge = page.getByRole('switch', { name: 'Toggle MQTT bridge', exact: true })
  const url = page.getByLabel(/Broker URL/)
  const save = page.getByRole('button', { name: 'Save', exact: true })
  const probe = page.getByRole('button', { name: 'Test connection', exact: true })
  await expect(page.getByText('TLS requires an mqtts:// or wss:// broker URL. Update the URL and port.', { exact: true })).toBeVisible()
  await expect(probe).toBeDisabled()
  await expect(save).toBeEnabled()
  await bridge.click()
  await expect(save).toBeDisabled()
  await expect(url).toHaveValue('mqtt://127.0.0.1:1883')
  await page.screenshot({ path: testInfo.outputPath('mqtt-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await url.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('mqtt-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await url.fill('mqtts://127.0.0.1:8883')
  await expect(save).toBeEnabled()
  await expect(probe).toBeEnabled()
  await bridge.click()
  await save.click()
  await expect(page.getByText('Settings saved.', { exact: true })).toBeVisible()
  await page.reload()
  await expect(url).toHaveValue('mqtts://127.0.0.1:8883')
  await expect(bridge).not.toBeChecked()
  expect(await (await request.get('/api/mqtt/settings', { headers })).json()).toMatchObject({ enabled: false, tlsEnabled: true, url: 'mqtts://127.0.0.1:8883' })
})

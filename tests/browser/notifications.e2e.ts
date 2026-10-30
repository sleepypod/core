import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect } from './ownerTest'

test('owner alerts deliver once, persist read status and protect REST and tRPC', async ({ page, request, playwright }, testInfo) => {
  const origin = 'http://127.0.0.1:3218'
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const anonymous = await playwright.request.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] } })
  for (const path of ['/api/v1/notifications', '/api/trpc/notifications.list?input=%7B%22json%22%3A%7B%7D%7D']) {
    expect((await anonymous.get(path)).status()).toBe(401)
  }
  expect((await anonymous.post('/api/v1/notifications/acknowledge', { data: { ids: [1] } })).status()).toBe(401)
  expect((await anonymous.post('/api/trpc/notifications.acknowledge', { data: { json: { ids: [1] } } })).status()).toBe(401)
  await anonymous.dispose()

  await page.goto('/en/settings')
  await page.getByRole('button', { name: 'Alerts', exact: true }).click()
  await expect(page.getByText(/No automation alerts yet/)).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await promisify(execFile)('pnpm', ['exec', 'tsx', 'tests/browser/fixture.ts', 'notify'], { timeout: 30_000, maxBuffer: 65536 })
  await expect(page.getByTestId('toast')).toContainText('Browser fixture alert', { timeout: 12_000 })
  await page.getByRole('button', { name: 'Alerts, 1 unread' }).click()
  const dialog = page.getByRole('dialog', { name: 'Automation alerts' })
  await expect(dialog.getByText('Unread', { exact: true })).toBeVisible()
  await expect(dialog).toContainText('Background push is not available')
  await page.screenshot({ path: testInfo.outputPath('alerts-desktop.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('alerts-mobile.png'), animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(dialog.getByRole('button', { name: 'Mark Browser fixture alert read' })).toHaveCSS('color', 'rgb(236, 236, 236)')
  await page.screenshot({ path: testInfo.outputPath('alerts-mobile-dark.png'), animations: 'disabled' })

  const initial = await (await request.get('/api/v1/notifications', { headers })).json()
  expect(initial).toMatchObject({ apiVersion: 1, unreadCount: 1, delivery: { foregroundInbox: true, backgroundPush: false } })
  const identifier = initial.items[0].id
  expect(await (await request.get(`/api/v1/notifications?beforeId=${identifier}`, { headers })).json()).toMatchObject({
    items: [], newestId: identifier, nextBeforeId: null, unreadCount: 1,
  })
  expect((await request.get('/api/v1/notifications?beforeId=-1', { headers })).status()).toBe(400)
  expect((await request.post('/api/v1/notifications/acknowledge', { headers, data: { ids: [] } })).status()).toBe(400)
  expect((await request.post('/api/v1/notifications/acknowledge', { headers: { Origin: 'https://untrusted.example' }, data: { ids: [identifier] } })).status()).toBe(401)
  await dialog.getByRole('button', { name: 'Mark Browser fixture alert read' }).click()
  await expect(dialog.getByText('Read', { exact: true })).toBeVisible()
  const saved = await (await request.get('/api/v1/notifications', { headers })).json()
  expect(saved.unreadCount).toBe(0)
  expect(saved.items[0].acknowledgedAt).toEqual(expect.any(Number))
  expect((await request.post('/api/v1/notifications/acknowledge', { headers, data: { ids: [identifier] } })).ok()).toBe(true)
  expect((await (await request.get('/api/v1/notifications', { headers })).json()).items[0].acknowledgedAt).toBe(saved.items[0].acknowledgedAt)
  await page.reload()
  await page.getByRole('button', { name: 'Alerts', exact: true }).click()
  await expect(page.getByRole('dialog').getByText('Read', { exact: true })).toBeVisible()
  await expect(page.getByTestId('toast')).toHaveCount(0)
})

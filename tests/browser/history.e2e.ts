import { test, expect } from './ownerTest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('original history stays read-only, source-labelled and paged independently of live measurements', async ({ page, request, playwright }, testInfo) => {
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  for (const endpoint of ['/api/v1/history', '/api/v1/history/records', '/api/v1/history/presence',
    '/api/trpc/importedHistory.status?input=%7B%22json%22%3A%7B%7D%7D']) {
    expect((await anonymous.get(endpoint)).status()).toBe(401)
  }
  await anonymous.dispose()
  await page.goto('/en/sleep?view=history')
  await expect(page.getByRole('heading', { name: 'Imported history', exact: true })).toBeVisible()
  await expect(page.getByText('No earlier records have been imported.', { exact: true })).toBeVisible()
  await promisify(execFile)('pnpm', ['exec', 'tsx', 'tests/browser/fixture.ts', 'imported-history'], { timeout: 30_000, maxBuffer: 65536 })
  const directory = process.env.SLEEPYPOD_BROWSER_FIXTURE
  if (!directory) throw new Error('Isolated fixture directory required')
  const files = ['legacy-history.db', 'free-sleep-history.db'].map(name => join(directory, name))
  const before = files.map(filename => readFileSync(filename))
  await page.reload()
  await expect(page.getByText('1 available record', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^View imported bed presence/ }).click()
  const detail = page.getByLabel('Imported bed presence detail')
  await expect(detail).toContainText('Recorded occupied time: 2h 30m')
  await expect(detail.getByRole('img', { name: 'Recorded presence timeline' })).toBeVisible()
  await expect(page.getByText(/These records do not count as Preview nights/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('imported-presence-desktop.png'), fullPage: true })
  const sides = page.getByRole('tablist', { name: 'Historical side' })
  await sides.getByRole('tab', { name: 'Right', exact: true }).click()
  await page.getByRole('button', { name: /^View imported bed presence/ }).click()
  await expect(detail).toContainText('Recorded occupied time: Unavailable')
  await expect(detail.getByRole('img')).toHaveCount(0)
  await sides.getByRole('tab', { name: 'Left', exact: true }).click()
  await page.getByRole('tab', { name: 'Vitals', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(50)
  await expect(page.locator('tbody tr').first()).toContainText('Unavailable')
  await page.getByRole('button', { name: 'Older records', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(5)
  await expect(page.getByRole('button', { name: 'Older records', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Newer records', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(50)
  await page.getByLabel('From', { exact: true }).fill('2026-10-10')
  await page.getByLabel('Through', { exact: true }).fill('2026-10-10')
  // First twenty-four samples occurred on the prior local date despite their UTC timestamp.
  await expect(page.locator('tbody tr')).toHaveCount(31)
  await page.getByLabel('From', { exact: true }).fill('2026-10-12')
  await expect(page.getByRole('alert').filter({ hasText: 'Choose a valid date range' })).toBeVisible()
  await expect(page.locator('table')).toHaveCount(0)
  await page.getByLabel('Through', { exact: true }).fill('2026-10-12')
  await expect(page.getByText(/No records in this date range/)).toBeVisible()
  await sides.getByRole('tab', { name: 'Right', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.locator('tbody tr')).toContainText('70')
  await page.setViewportSize({ width: 390, height: 844 })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`imported-vitals-phone-${colorScheme}.png`), fullPage: true })
  }
  const statusResponse = await request.get('/api/v1/history', { headers })
  expect(statusResponse.status()).toBe(200)
  expect(statusResponse.headers()['cache-control']).toContain('no-store')
  expect(statusResponse.headers().vary).toContain('Authorization')
  const rpcResponse = await request.get('/api/trpc/importedHistory.status?input=%7B%22json%22%3A%7B%7D%7D', { headers })
  expect(rpcResponse.status()).toBe(200)
  expect(rpcResponse.headers()['cache-control']).toContain('no-store')
  const status = await statusResponse.json()
  expect(status).toMatchObject({ status: 'ready', semantics: { previewEvidence: false, automationInput: false } })
  const parameters = new URLSearchParams({ snapshotId: status.snapshot.snapshotId, side: 'left', kind: 'vitals',
    startTime: '2026-10-10T06:00:00Z', endTime: '2026-10-11T06:00:00Z', limit: '1' })
  const first = await (await request.get(`/api/v1/history/records?${parameters}`, { headers })).json()
  expect(first.records).toHaveLength(1)
  parameters.set('snapshotId', 'f'.repeat(64))
  const conflict = await request.get(`/api/v1/history/records?${parameters}`, { headers })
  expect(conflict.status()).toBe(409)
  expect(conflict.headers()['cache-control']).toContain('no-store')
  expect(files.map(filename => readFileSync(filename))).toEqual(before)
})

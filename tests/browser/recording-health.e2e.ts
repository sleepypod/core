import { test, expect } from './ownerTest'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

test.use({ serviceWorkers: 'block' })

test('recording checks require authentication and expose independent sources', async ({ request, playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  try {
    expect((await anonymous.get('/api/health/recording')).status()).toBe(401)
  }
  finally { await anonymous.dispose() }
  const response = await request.get('/api/health/recording', {
    headers: { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` },
  })
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toContain('no-store')
  const report = await response.json()
  expect(report.apiVersion).toBe(1)
  expect(report.checks).toHaveLength(8)
  expect(report.checks.find((check: { id: string }) => check.id === 'recording-database').state).toBe('ok')
  expect(report.checks.find((check: { id: string }) => check.id === 'storage')).toBeDefined()
  // An isolated test server has no Pod sensors. It cannot establish readiness.
  expect(report.state).not.toBe('ready')
})

for (const width of [390, 1440]) {
  test(`repeated reported breaks prompt review without rewriting recordings at ${width}px`, async ({ page, request }, testInfo) => {
    const root = process.env.SLEEPYPOD_BROWSER_FIXTURE
    const databasePath = process.env.BIOMETRICS_DATABASE_URL
    assert(root && databasePath && dirname(resolve(databasePath)) === resolve(root), 'Isolated browser fixture required')
    const database = new Database(databasePath, { fileMustExist: true })
    const start = Math.floor(Date.now() / 1000) - 4 * 3600, end = start + 2 * 3600
    const present = [[start, start + 300], [start + 360, start + 900], [start + 960, start + 1500], [start + 1560, end]]
    const absent = [[start + 300, start + 360], [start + 900, start + 960], [start + 1500, start + 1560]]
    const inserted = database.prepare(`INSERT INTO sleep_records (side,entered_bed_at,left_bed_at,sleep_duration_seconds,present_intervals,not_present_intervals,created_at)
      VALUES ('left',?,?,?,?,?,?)`).run(start, end, end - start, JSON.stringify(present), JSON.stringify(absent), end).lastInsertRowid
    try {
      const original = database.prepare('SELECT * FROM sleep_records WHERE id=?').get(inserted)
      await expect.poll(async () => {
        const response = await request.get('/api/health/recording', { headers: { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` } })
        const body = await response.json()
        return body.checks.find((check: { id: string }) => check.id === 'presence-history')?.detail
      }, { timeout: 20_000, intervals: [1000] }).toContain('3 short reported breaks')
      await page.setViewportSize({ width, height: 1000 })
      await page.goto('/en/sleep')
      const card = page.getByRole('region', { name: 'Recording readiness' })
      await expect(card.getByText('Recording needs attention', { exact: true })).toBeVisible()
      await expect(card.getByText(/genuine exits and inconsistent sensing/)).toBeVisible()
      await expect(card.getByText(/Only completed records are reviewed/)).toBeVisible()
      await expect(card.getByRole('button', { name: /Restart|Calibrate|Delete|Prime/ })).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await card.screenshot({ path: testInfo.outputPath(`recording-breaks-${width}.png`) })
      await card.locator('li').filter({ hasText: 'Recent presence interruptions' }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath(`recording-break-detail-${width}.png`) })
      expect(database.prepare('SELECT * FROM sleep_records WHERE id=?').get(inserted)).toEqual(original)
    }
    finally {
      database.prepare('DELETE FROM sleep_records WHERE id=?').run(inserted)
      database.close()
    }
  })

  test(`recording readiness remains readable and withdraws stale status at ${width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.clock.install()
    await page.goto('/en/sleep')
    const card = page.getByRole('region', { name: 'Recording readiness' })
    await expect(card.getByRole('button', { name: 'Check again', exact: true })).toBeVisible()
    await expect(card.getByText(/Recording (needs attention|checks are incomplete)/)).toBeVisible()
    const bounds = await card.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds?.x).toBeGreaterThanOrEqual(0)
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width)
    await card.screenshot({ path: testInfo.outputPath(`recording-readiness-${width}.png`) })
    // Keep the owner session observable while just this source fails. A complete
    // connection loss correctly replaces private web screens with the login gate.
    await page.route('**/api/trpc/health.recording**', route => route.abort())
    await page.clock.fastForward(90_000)
    await expect(card.getByText('Recording check unavailable', { exact: true })).toBeVisible()
    await expect(card.getByText('See last successful check')).toBeVisible()
    await expect(card.getByRole('button', { name: /Restart|Calibrate|Delete|Prime/ })).toHaveCount(0)
    await context.setOffline(true)
    await page.clock.fastForward(90_000)
    await expect(page.getByRole('heading', { name: 'Connect to your Pod' })).toBeVisible()
    await expect(card).toHaveCount(0)
  })
}

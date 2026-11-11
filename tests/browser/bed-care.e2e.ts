import { test, expect } from './ownerTest'

test.use({ serviceWorkers: 'block' })
test('bed care requires owner access over REST and tRPC', async ({ request, playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  try {
    for (const path of ['/api/health/care', '/api/trpc/health.care']) expect((await anonymous.get(path)).status()).toBe(401)
  }
  finally { await anonymous.dispose() }
  const response = await request.get('/api/health/care', { headers: { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` } })
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toContain('no-store')
  const report = await response.json()
  expect(report.apiVersion).toBe(1)
  expect(report.checks).toHaveLength(5)
  expect(report.checks.find((check: { id: string }) => check.id === 'water').state).toBe('unknown')
})
for (const width of [390, 1024]) {
  test(`bed care shows practical recovery and withdraws stale observations at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.clock.install()
    await page.goto('/en/system?tab=care')
    const care = page.getByRole('region', { name: 'Bed care', exact: true })
    await expect(care.getByText('Water & priming', { exact: true })).toBeVisible()
    await expect(care.getByText('No current water reading is available.', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`bed-care-${width}-top.png`) })
    for (const name of ['View temperature delivery', 'Review pump alerts', 'Open recording diagnostics', 'Review storage', 'Open backups']) {
      const link = care.getByRole('link', { name, exact: true })
      await link.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
      await expect(link).toBeVisible()
      expect(await link.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
      })).toBe(true)
      if (name === 'Open recording diagnostics') await page.screenshot({ path: testInfo.outputPath(`bed-care-${width}-middle.png`) })
    }
    await expect(care.getByRole('button', { name: /Prime|Restart|Delete|Reset|Dismiss/ })).toHaveCount(0)
    await page.route('**/api/trpc/health.care**', route => route.abort())
    await page.clock.fastForward(35_000)
    await expect(care.getByRole('status')).toContainText('Care checks unavailable')
    await care.getByText('A careful recovery, step by step', { exact: true }).click()
    await expect(care.getByText(/^Before software maintenance, export a backup/)).toBeVisible()
    await care.getByRole('link', { name: 'Find instructions for your Pod' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`bed-care-${width}-recovery.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

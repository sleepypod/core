import { test, expect } from './ownerTest'

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

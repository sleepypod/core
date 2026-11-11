import { initTRPC } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import superjson from 'superjson'
import { z } from 'zod'
import { test, expect } from './ownerTest'

test.use({ serviceWorkers: 'block' })
test('target response audit authenticates, stays read-only and reports absent evidence', async ({ page, request, playwright, baseURL }, testInfo) => {
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  try {
    for (const path of ['/api/v1/comfort/response?side=left', '/api/trpc/comfort.targetResponse']) expect((await anonymous.get(path)).status()).toBe(401)
  }
  finally { await anonymous.dispose() }
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const before = await (await request.get('/api/v1/comfort?side=left', { headers })).json()
  const response = await request.get('/api/v1/comfort/response?side=left', { headers })
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toContain('no-store')
  expect(await response.json()).toMatchObject({ status: 'read', reviewedNights: 0, responseNights: 0,
    coolingWindows: 0, warmingWindows: 0, modelAvailable: false, activationAvailable: false })
  expect((await request.get('/api/v1/comfort/response?side=middle', { headers })).status()).toBe(400)
  await page.goto('/en/autopilot')
  const section = page.getByRole('region', { name: 'Learning from small temperature changes' })
  await section.getByRole('button', { name: 'Check recorded changes' }).click()
  await expect(section.getByText('0 of 0')).toBeVisible()
  await expect(section.getByText(/Keep your comfortable routine/)).toBeVisible()
  await section.screenshot({ path: testInfo.outputPath('response-empty.png') })
  expect((await (await request.get('/api/v1/comfort?side=left', { headers })).json()).state).toEqual(before.state)
})

for (const width of [390, 1440]) {
  test(`target response evidence at ${width}px distinguishes observations and withdraws a failed read`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1100 })
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light', reducedMotion: 'reduce' })
    let failed = false
    let pending: Promise<void> | null = null
    let release: () => void = () => undefined
    const protocol = initTRPC.create({ transformer: superjson })
    const read = protocol.procedure.input(z.object({ side: z.enum(['left', 'right']) })).query(async ({ input }) => {
      if (pending) await pending
      if (failed) throw new Error('Illustrative controller unavailable')
      return { apiVersion: 1, policy: 'acknowledged-small-step-v1', generatedAt: Date.now(), side: input.side, attribution: 'physical_zone_only',
        status: 'partial', reviewedNights: 12, responseNights: 9, coolingWindows: 8, warmingWindows: 4, requiredNights: 20,
        datasetHash: 'a'.repeat(64), modelAvailable: false, activationAvailable: false,
        exclusions: [{ date: '2026-11-09', count: 2, reason: 'Actual preceding water readings and timely firmware confirmation are missing.' },
          { date: '2026-11-08', count: 1, reason: 'Another change or unresolved command overlaps this response window.' }],
        exclusionsTruncated: false, reason: 'Illustrative response-readiness fixture; no personal measurements.' }
    })
    await page.route('**/api/trpc/**', async (route) => {
      const incoming = route.request()
      const paths = decodeURIComponent(new URL(incoming.url()).pathname.split('/api/trpc/')[1]).split(',')
      if (!paths.includes('comfort.targetResponse')) return route.continue()
      const procedures = Object.fromEntries(paths.map(path => [path, path === 'comfort.targetResponse'
        ? read
        : protocol.procedure.input(z.unknown()).query(async ({ input }) => {
            const forwarded = await request.get(`/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`,
              { headers: { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` } })
            const value = await forwarded.json()
            if (!value.result?.data) throw new Error('Fixture read unavailable')
            return superjson.deserialize(value.result.data)
          })]))
      const response = await fetchRequestHandler({ endpoint: '/api/trpc', router: protocol.router(procedures),
        req: new Request(incoming.url(), { method: incoming.method(), headers: incoming.headers(), body: incoming.postData() }), createContext: () => ({}) })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    })
    await page.goto('/en/autopilot')
    const section = page.getByRole('region', { name: 'Learning from small temperature changes' })
    const assertControlFits = async () => {
      const column = await section.boundingBox(), button = await section.getByRole('button').boundingBox()
      if (!column || !button) throw new Error('The evidence control must be laid out')
      expect(button.x + button.width).toBeLessThanOrEqual(column.x + column.width + 0.5)
      expect(button.height).toBeGreaterThanOrEqual(44)
      expect(await section.getByRole('button').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
    await expect(section.getByText('9 of 12')).toHaveCount(0)
    const initialText = await page.addStyleTag({ content: ':root{font-size:24px}' })
    await assertControlFits()
    await section.screenshot({ path: testInfo.outputPath(`response-${width}-initial-large.png`) })
    await initialText.evaluate(element => element.parentNode?.removeChild(element))
    await section.getByRole('button', { name: 'Check recorded changes' }).click()
    await expect(section.getByText('9 of 12')).toBeVisible()
    await section.getByText('Why some changes were excluded', { exact: true }).click()
    await expect(section.getByText(/Another change or unresolved command/)).toBeVisible()
    await section.screenshot({ path: testInfo.outputPath(`response-${width}.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: testInfo.outputPath(`response-${width}-page.png`), fullPage: true })
    await page.addStyleTag({ content: ':root{font-size:24px}' })
    await section.screenshot({ path: testInfo.outputPath(`response-${width}-large.png`) })
    expect(await section.getByRole('button', { name: 'Check evidence again' }).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(21, 1)
    await section.locator('h4').evaluate(element => element.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: testInfo.outputPath(`response-${width}-large-upper.png`) })
    await section.getByText('About these observations', { exact: true }).click()
    await section.locator('details').last().evaluate(element => element.scrollIntoView({ block: 'center' }))
    await expect(section.getByText(/Do not change temperatures just to fill the count/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`response-${width}-large-lower.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await assertControlFits()
    failed = true
    pending = new Promise<void>((resolve) => {
      release = resolve
    })
    await section.getByRole('button', { name: 'Check evidence again' }).click()
    await expect(section.getByRole('button', { name: 'Checking recorded changes…' })).toBeDisabled()
    await assertControlFits()
    await section.screenshot({ path: testInfo.outputPath(`response-${width}-loading-large.png`) })
    release()
    await expect(section.getByRole('alert')).toContainText('Reconnect to your Pod')
    await expect(section.getByText('9 of 12')).toHaveCount(0)
    await section.screenshot({ path: testInfo.outputPath(`response-${width}-failed.png`) })
    await expect(section.getByRole('button', { name: 'Check evidence again' })).toBeEnabled()
    await assertControlFits()
  })
}

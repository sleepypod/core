import { initTRPC } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import superjson from 'superjson'
import { z } from 'zod'
import { test, expect } from './ownerTest'
import { nightExplanationExample } from '../../src/night/tests/example'
import { nightQuerySchema } from '../../src/night/contract'

test.use({ serviceWorkers: 'block' })
test('night history is owner-only with independent source status and no-store responses', async ({ request, playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  try {
    for (const path of ['/api/v1/device/night-explanation?side=left', '/api/trpc/device.nightExplanation']) expect((await anonymous.get(path)).status()).toBe(401)
  }
  finally { await anonymous.dispose() }
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const response = await request.get('/api/v1/device/night-explanation?side=left', { headers })
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toContain('no-store')
  expect(await response.json()).toMatchObject({ side: 'left', attribution: 'physical_zone_only', apiVersion: 1 })
  expect((await request.get('/api/v1/device/night-explanation?side=left&wakeDate=2040-01-01', { headers })).status()).toBe(412)
})
for (const { width, appearance } of [
  { width: 390, appearance: 'normal' }, { width: 1024, appearance: 'normal' },
  { width: 390, appearance: 'large-dark' }, { width: 1024, appearance: 'large-dark' },
]) {
  test(`night explanation at ${width}px ${appearance} preserves gaps, source clocks and failed reads`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ colorScheme: appearance === 'large-dark' ? 'dark' : 'light', reducedMotion: 'reduce' })
    let failed = false
    const protocol = initTRPC.create({ transformer: superjson })
    const current = Date.now() - 1000
    const read = protocol.procedure.input(nightQuerySchema).query(({ input }) => {
      if (failed) throw new Error('Illustrative controller unavailable')
      return nightExplanationExample(current, input.side, input.wakeDate)
    })
    await page.route('**/api/trpc/**', async (route) => {
      const incoming = route.request()
      const paths = decodeURIComponent(new URL(incoming.url()).pathname.split('/api/trpc/')[1]).split(',')
      if (!paths.includes('device.nightExplanation')) return route.continue()
      const procedures = Object.fromEntries(paths.map(path => [path, path === 'device.nightExplanation'
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
    await page.goto('/en')
    if (appearance === 'large-dark') await page.addStyleTag({ content: ':root{font-size:24px}' })
    const region = page.getByRole('region', { name: 'Overnight explanation' })
    await region.getByText('What happened overnight?', { exact: true }).click()
    await expect(region.getByText('Temperature request acknowledged · 70°F', { exact: true })).toBeVisible()
    const scale = appearance === 'large-dark' ? 1.5 : 1
    for (const label of [region.locator('summary').first(), region.locator('h3').first(), region.getByRole('button', { name: 'Refresh night' })]) {
      expect(await label.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(14 * scale, 1)
    }
    expect(await region.locator('svg text').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize)))
      .toBeCloseTo((width <= 600 ? 24 : 13) * scale, 1)
    const axisBoxes = await region.locator('svg text').evaluateAll(labels => labels.map((label) => {
      const box = (label as SVGGraphicsElement).getBBox()
      return { text: label.textContent, x: box.x, y: box.y, width: box.width, height: box.height }
    }))
    expect(axisBoxes.every(box => box.x >= 0 && box.x + box.width <= 700 && box.y >= 0 && box.y + box.height <= 236), JSON.stringify(axisBoxes)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`night-${width}-${appearance}-full.png`), fullPage: true })
    await region.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }))
    await page.screenshot({ path: testInfo.outputPath(`night-${width}-${appearance}-overview.png`) })
    await region.locator('summary').filter({ hasText: /^Room conditions/ }).click()
    await expect(region.getByText(/measurement time not supplied/)).toBeVisible()
    await region.locator('summary').filter({ hasText: /^Room conditions/ }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`night-${width}-${appearance}-room.png`) })
    await region.getByLabel('Event source').selectOption('decisions')
    await expect(region.getByText('Temperature request acknowledged · 70°F', { exact: true })).toHaveCount(0)
    // The explanation is available in both existing bed layouts.
    await page.getByRole('button', { name: 'Cards', exact: true }).click()
    await expect(region.getByText('What happened overnight?', { exact: true })).toBeVisible()
    await region.getByText('What happened overnight?', { exact: true }).click()
    await expect(region.getByText('Temperature request acknowledged · 70°F', { exact: true })).toBeVisible()
    failed = true
    await region.getByRole('button', { name: 'Refresh night' }).click()
    await expect(region.getByRole('status')).toContainText('Night evidence is unavailable')
    await region.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
    await page.screenshot({ path: testInfo.outputPath(`night-${width}-${appearance}-unavailable.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

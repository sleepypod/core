import { test, expect } from './ownerTest'
import { initTRPC } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import superjson from 'superjson'
import { z } from 'zod'
import { previewPredictiveTarget } from '../../src/comfort/predictive-policy'
import { predictiveFixture, predictiveHorizons } from '../../src/comfort/tests/predictiveFixture'

test.use({ serviceWorkers: 'block' })

test('predictive reads require owner authentication and cannot accept targets or activate controls', async ({ request, playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  try {
    for (const path of ['/api/v1/comfort/predictive/preview?side=left', '/api/trpc/comfort.predictiveTargetPreview']) {
      expect((await anonymous.get(path)).status()).toBe(401)
    }
  }
  finally { await anonymous.dispose() }
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const before = await (await request.get('/api/v1/comfort?side=left', { headers })).json()
  const response = await request.get('/api/v1/comfort/predictive/preview?side=left', { headers })
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toContain('no-store')
  expect(await response.json()).toMatchObject({ side: 'left', disposition: 'withheld', activationAvailable: false, proposedTargetF: null })
  expect((await request.get('/api/v1/comfort/predictive/preview?side=middle', { headers })).status()).toBe(400)
  expect((await (await request.get('/api/v1/comfort?side=left', { headers })).json()).state).toEqual(before.state)
})

for (const width of [390, 1440]) {
  test(`predictive comparison at ${width}px explains alternatives and expires without a hardware request`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1100 })
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light', reducedMotion: 'reduce' })
    let resultKind = 'candidate', calls = 0
    const mutations: string[] = []
    page.on('request', (incoming) => {
      if (incoming.method() === 'POST' && incoming.url().includes('/api/')) mutations.push(incoming.url())
    })
    const protocol = initTRPC.create({ transformer: superjson })
    await page.route('**/api/trpc/**', async (route) => {
      const incoming = route.request(), paths = decodeURIComponent(new URL(incoming.url()).pathname.split('/api/trpc/')[1]).split(',')
      if (!paths.includes('comfort.predictiveTargetPreview')) return route.continue()
      const procedures = Object.fromEntries(paths.map(path => [path, path === 'comfort.predictiveTargetPreview'
        ? protocol.procedure.input(z.unknown()).query(() => {
            calls++
            if (resultKind === 'error') throw new Error('Illustrative network failure')
            const fixture = predictiveFixture(Date.now())
            if (resultKind === 'hold') fixture.hold = predictiveHorizons(70)
            if (resultKind === 'withheld') fixture.context.device.waterAdequate = null
            const result = previewPredictiveTarget(fixture)
            result.reason = `Illustrative preview only. ${result.reason}`
            return result
          })
        : protocol.procedure.input(z.unknown()).query(async ({ input }) => {
            const response = await request.get(`/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`,
              { headers: { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` } })
            const value = await response.json()
            if (!value.result?.data) throw new Error('Fixture read unavailable')
            return superjson.deserialize(value.result.data)
          })]))
      const response = await fetchRequestHandler({ endpoint: '/api/trpc', router: protocol.router(procedures),
        req: new Request(incoming.url(), { method: incoming.method(), headers: incoming.headers(), body: incoming.postData() }), createContext: () => ({}) })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    })
    await page.goto('/en/autopilot')
    const section = page.getByRole('region', { name: 'Predictive target comparison' })
    await section.scrollIntoViewIfNeeded()
    expect(calls).toBe(0)
    await section.getByRole('button', { name: 'Compare with holding' }).click()
    await expect(section.getByText('69.0°F is an experiment candidate')).toBeVisible()
    await section.getByText('See the alternatives and their uncertainty').click()
    await expect(section.getByText('Hold 70.0°F · Alternative')).toBeVisible()
    await expect(section.getByText('Target 69.0°F · Research choice')).toBeVisible()
    await section.evaluate(element => element.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: testInfo.outputPath(`predictive-${width}-candidate.png`) })
    await page.addStyleTag({ content: ':root{font-size:24px}' })
    await section.evaluate(element => element.scrollIntoView({ block: 'start' }))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const button = section.getByRole('button', { name: 'Refresh target comparison' })
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`predictive-${width}-large.png`) })
    await expect(section.getByText(/comparison has expired/)).toBeVisible({ timeout: 20_000 })
    expect(calls).toBe(1)
    await expect(section.getByText('69.0°F is an experiment candidate')).toHaveCount(0)
    resultKind = 'hold'
    await button.click()
    await expect(section.getByText('Keep 70.0°F in this comparison')).toBeVisible()
    resultKind = 'withheld'
    await button.click()
    await expect(section.getByText('A comparison is not ready yet')).toBeVisible()
    resultKind = 'error'
    await button.click()
    await expect(section.getByRole('alert')).toContainText('comparison could not be read')
    await expect(section.getByText('A comparison is not ready yet')).toHaveCount(0)
    expect(mutations).toEqual([])
    expect(calls).toBe(4)
  })
}

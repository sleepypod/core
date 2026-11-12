import { test, expect } from './ownerTest'
import { initTRPC } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import superjson from 'superjson'
import { z } from 'zod'

test.use({ serviceWorkers: 'block' })
for (const width of [390, 1440]) {
  test(`prospective accuracy at ${width}px keeps source counts and limitations visible`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1100 })
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light', reducedMotion: 'reduce' })
    let fail = false, reads = 0
    const mutations: string[] = []
    page.on('request', (incoming) => {
      if (incoming.method() === 'POST' && incoming.url().includes('/api/')) mutations.push(incoming.url())
    })
    const protocol = initTRPC.create({ transformer: superjson })
    await page.route('**/api/trpc/**', async (route) => {
      const incoming = route.request(), paths = decodeURIComponent(new URL(incoming.url()).pathname.split('/api/trpc/')[1]).split(',')
      if (!paths.includes('comfort.predictiveOutcomes')) return route.continue()
      const procedures = Object.fromEntries(paths.map(path => [path, path === 'comfort.predictiveOutcomes'
        ? protocol.procedure.input(z.unknown()).query(() => {
            reads++
            if (fail) throw new Error('Illustrative unavailable history')
            return { apiVersion: 1, side: 'left', generatedAt: Date.now(), purpose: 'prospective_water_accuracy', activationAvailable: false,
              considered: 5, pending: 1, withheld: 1, scored: 3,
              models: [{ artifactId: 'a'.repeat(64), datasetHash: 'b'.repeat(64), configuration: 'c'.repeat(64), latestAt: Date.now() - 86_400_000,
                comparisons: 3, reviewedNights: 2, horizons: [15, 30].map(minutes => ({ minutes, meanNightErrorF: 1.8,
                  meanNightPersistenceErrorF: 3.6, meanNightRangeCoverage: 0.7 })) }],
              exclusions: [{ code: 'no_review', count: 1 }],
              notice: 'Only the unchanged target is scored. Unapplied alternatives have no measured outcome, and water accuracy is not evidence of better sleep.' }
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
    const section = page.getByRole('region', { name: 'Forecast accuracy' })
    await section.scrollIntoViewIfNeeded()
    expect(reads).toBe(0)
    await section.getByRole('button', { name: 'Check forecast accuracy' }).click()
    await expect(section.getByText('Forecast version 1 · 2 reviewed nights')).toBeVisible()
    await expect(section.getByText('Forecast error: 1.8°F')).toHaveCount(2)
    await section.getByText('Why comparisons were excluded').click()
    await expect(section.getByText(/complete night needs a current review/)).toBeVisible()
    await page.addStyleTag({ content: ':root{font-size:24px}' })
    await section.evaluate(element => element.scrollIntoView({ block: 'start' }))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const button = section.getByRole('button', { name: 'Refresh forecast accuracy' })
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: testInfo.outputPath(`forecast-accuracy-${width}-large.png`) })
    fail = true
    await button.click()
    await expect(section.getByRole('alert')).toContainText('could not be verified')
    await expect(section.getByText(/Forecast version/)).toHaveCount(0)
    expect(mutations).toEqual([])
  })
}

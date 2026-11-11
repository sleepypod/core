import { test, expect } from './ownerTest'
import { initTRPC } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import superjson from 'superjson'
import { z } from 'zod'
import { responsePresentationFixture } from '../../src/comfort/tests/responsePresentationFixture'

test.use({ serviceWorkers: 'block' })

test('response-model APIs authenticate, reject incomplete fits and never change controls', async ({ page, request, playwright, baseURL }, testInfo) => {
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  try {
    for (const path of ['/api/v1/comfort/response/model?side=left', '/api/v1/comfort/response/preview?side=left',
      '/api/trpc/comfort.targetResponseModel', '/api/trpc/comfort.targetResponsePreview']) expect((await anonymous.get(path)).status()).toBe(401)
    expect((await anonymous.post('/api/v1/comfort/response/train', { data: { side: 'left', expectedDatasetHash: 'a'.repeat(64) } })).status()).toBe(401)
  }
  finally { await anonymous.dispose() }
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const before = await (await request.get('/api/v1/comfort?side=left', { headers })).json()
  const response = await request.get('/api/v1/comfort/response/model?side=left', { headers })
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toContain('no-store')
  const status = await response.json()
  expect(status).toMatchObject({ completeNights: 0, canTrain: false, model: null, activationAvailable: false })
  expect((await request.get('/api/v1/comfort/response/model?side=middle', { headers })).status()).toBe(400)
  const fit = await request.post('/api/v1/comfort/response/train', { headers, data: { side: 'left', expectedDatasetHash: status.datasetHash } })
  expect(fit.status()).toBe(412)
  const preview = await request.get('/api/v1/comfort/response/preview?side=left', { headers })
  expect(preview.status()).toBe(200)
  expect(preview.headers()['cache-control']).toContain('no-store')
  expect(await preview.json()).toMatchObject({ side: 'left', activationAvailable: false, candidates: [] })
  expect((await (await request.get('/api/v1/comfort?side=left', { headers })).json()).state).toEqual(before.state)
  await page.goto('/en/autopilot')
  const section = page.getByRole('region', { name: 'Learning from small temperature changes' })
  await section.getByRole('button', { name: 'Check recorded changes' }).click()
  await expect(section.getByText('Collecting evidence', { exact: true })).toBeVisible()
  await section.locator('[aria-label="Target-response evaluation"]').evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: testInfo.outputPath('model-empty.png') })
})

for (const width of [390, 1440]) {
  test(`response evaluation at ${width}px saves a research fit, explains comparisons and withdraws unavailable predictions`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1100 })
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light', reducedMotion: 'reduce' })
    let fitted = false, fitFailed = false, sourceChanged = false, unavailable = false, readFailed = false, writes = 0
    let finishFit: () => void = () => undefined
    const fitGate = new Promise<void>((resolve) => {
      finishFit = resolve
    })
    const status = () => {
      const value = responsePresentationFixture(Date.now())
      if (!fitted) value.model = null
      if (fitFailed && value.model) value.model.horizons[0].validation.passes = false
      if (sourceChanged && value.model) value.model.current = false
      return value
    }
    const protocol = initTRPC.create({ transformer: superjson })
    const procedures = {
      'comfort.targetResponseModel': protocol.procedure.input(z.unknown()).query(() => {
        if (readFailed) throw new Error('Illustrative offline source')
        return status()
      }),
      'comfort.trainTargetResponseModel': protocol.procedure.input(z.object({ side: z.literal('left'), expectedDatasetHash: z.literal('a'.repeat(64)) }))
        .mutation(async () => {
          writes++
          await fitGate
          fitted = true
          return status()
        }),
      'comfort.targetResponsePreview': protocol.procedure.input(z.unknown()).query(() => ({ apiVersion: 1, side: 'left', generatedAt: Date.now(), activationAvailable: false,
        reason: unavailable ? 'Fresh occupied-bed readings are unavailable.' : 'Illustrative water estimates only; no command is sent.',
        candidates: unavailable
          ? []
          : [{ targetF: 69, reason: 'Comparable context',
              predictions: [15, 30].map(minutes => ({ minutes, waterF: 69.4, lowerF: 68.9, upperF: 69.9 })) },
            { targetF: 71, predictions: [], reason: 'No comparable warming observations. Keep the current routine.' }] })),
    }
    await page.route('**/api/trpc/**', async (route) => {
      const incoming = route.request(), paths = decodeURIComponent(new URL(incoming.url()).pathname.split('/api/trpc/')[1]).split(',')
      if (!paths.some(path => path in procedures)) return route.continue()
      const routed = Object.fromEntries(paths.map(path => [path, path in procedures
        ? procedures[path as keyof typeof procedures]
        : protocol.procedure.input(z.unknown()).query(async ({ input }) => {
            const response = await request.get(`/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`,
              { headers: { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` } })
            const value = await response.json()
            if (!value.result?.data) throw new Error('Fixture read unavailable')
            return superjson.deserialize(value.result.data)
          })]))
      const response = await fetchRequestHandler({ endpoint: '/api/trpc', router: protocol.router(routed),
        req: new Request(incoming.url(), { method: incoming.method(), headers: incoming.headers(), body: incoming.postData() }), createContext: () => ({}) })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    })
    await page.goto('/en/autopilot')
    const section = page.getByRole('region', { name: 'Learning from small temperature changes' })
    const evaluation = section.locator('[aria-label="Target-response evaluation"]')
    const capture = async (state: string, anchor = evaluation) => {
      await anchor.evaluate(element => element.scrollIntoView({ block: 'start' }))
      await page.screenshot({ path: testInfo.outputPath(`model-${width}-${state}.png`) })
    }
    await section.getByRole('button', { name: 'Check recorded changes' }).click()
    await expect(section.getByRole('button', { name: 'Evaluate response model' })).toBeVisible()
    expect(writes).toBe(0)
    await capture('ready')
    await section.getByRole('button', { name: 'Evaluate response model' }).click()
    await expect(section.getByRole('button', { name: 'Evaluating later nights…' })).toBeDisabled()
    await capture('fitting')
    finishFit()
    await expect(section.getByText('Research preview', { exact: true })).toBeVisible()
    expect(writes).toBe(1)
    await section.getByText('How the model was checked', { exact: true }).click()
    await expect(section.getByText('15 minutes · Passed comparison')).toBeVisible()
    await expect(section.getByText('30 minutes · Passed comparison')).toBeVisible()
    await section.getByRole('button', { name: 'Preview nearby targets' }).click()
    await expect(section.getByText('If the target were 69.0°F')).toBeVisible()
    await expect(section.getByText(/No comparable warming observations/)).toBeVisible()
    await capture('evaluation')
    await capture('preview', section.getByText('If the target were 69.0°F').locator('..'))
    await page.addStyleTag({ content: ':root{font-size:24px}' })
    const bounds = await section.boundingBox()
    if (!bounds) throw new Error('The response section must be laid out')
    for (const button of await section.getByRole('button').all()) {
      const control = await button.boundingBox()
      if (!control) throw new Error('Controls must be laid out')
      expect(control.x + control.width).toBeLessThanOrEqual(bounds.x + bounds.width + 0.5)
      expect(control.height).toBeGreaterThanOrEqual(44)
      expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await section.getByText('If the target were 69.0°F').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(21, 1)
    const qualifier = page.getByText(/The unchanged-target forecast uses/), evidenceTitle = section.locator('h4')
    expect(await qualifier.evaluate((element, title) => Boolean(element.compareDocumentPosition(title as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await evidenceTitle.elementHandle())).toBe(true)
    await capture('large-evaluation')
    await capture('large-comparison', section.getByText('30 minutes · Passed comparison').locator('..'))
    await capture('large-preview', section.getByText('If the target were 69.0°F').locator('..'))
    unavailable = true
    await section.getByRole('button', { name: 'Refresh response preview' }).click()
    await expect(section.getByText('Fresh occupied-bed readings are unavailable.')).toBeVisible()
    await expect(section.getByText('If the target were 69.0°F')).toHaveCount(0)
    await capture('unavailable', section.getByText('Fresh occupied-bed readings are unavailable.').locator('..'))
    fitFailed = true
    await section.getByRole('button', { name: 'Check evidence again' }).click()
    await expect(section.getByText('Not reliable yet', { exact: true })).toBeVisible()
    await expect(section.getByRole('button', { name: 'Preview nearby targets' })).toHaveCount(0)
    await capture('failed-comparison')
    sourceChanged = true
    await section.getByRole('button', { name: 'Check evidence again' }).click()
    await expect(section.getByText('Needs recheck', { exact: true })).toBeVisible()
    await capture('changed-source')
    readFailed = true
    await section.getByRole('button', { name: 'Check evidence again' }).click()
    await expect(section.getByRole('alert')).toContainText('Reconnect to your Pod')
    await capture('read-failure', section.getByRole('alert'))
    await expect(section.getByText('20 of 23')).toHaveCount(0)
    expect(writes).toBe(1)
  })
}

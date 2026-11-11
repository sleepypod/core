import { randomUUID } from 'node:crypto'
import { initTRPC } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import superjson from 'superjson'
import { z } from 'zod'
import { test, expect } from './ownerTest'
import { controlRequestSchema, type ControlReceipt, type ControlRequest } from '../../src/controls/contract'
import type { CoolingLease } from '../../src/temperature/cooling'

test.use({ serviceWorkers: 'block' })
test('cooling preview is owner-only and expired requests never touch hardware', async ({ request, playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  try {
    for (const path of ['/api/device/cooling?side=left', '/api/trpc/device.getCooling']) expect((await anonymous.get(path)).status()).toBe(401)
  }
  finally { await anonymous.dispose() }
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const response = await request.get('/api/device/cooling?side=left', { headers })
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toContain('no-store')
  expect(await response.json()).toMatchObject({ side: 'left', state: 'unavailable', proposal: null, lease: null })
  const issuedAt = Date.now() - 60_000
  const input = { requestId: randomUUID(), issuedAt, expiresAt: issuedAt + 30_000,
    action: { kind: 'cooling.start', side: 'left', coolingId: randomUUID(), expectedScope: 'a'.repeat(64), expectedTargetF: 70, expectedExpiresAt: Date.now() + 1200_000 } }
  const receipt = await (await request.post('/api/v1/controls', { headers, data: input })).json()
  expect(receipt).toMatchObject({ state: 'expired', dispatchCount: 0, replayAllowed: false })
  expect(await (await request.post('/api/v1/controls', { headers, data: input })).json()).toEqual(receipt)
})

for (const width of [390, 1024]) {
  test(`temporary cooling review, cancellation and lost-reply recovery at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    const clock = Date.now()
    let lease: CoolingLease | null = null
    let lost = false
    const calls: ControlRequest[] = []
    const receipts = new Map<string, ControlReceipt>()
    const protocol = initTRPC.create({ transformer: superjson })
    const cooling = protocol.procedure.input(z.object({ side: z.enum(['left', 'right']) })).query(({ input }) => ({
      apiVersion: 1, side: input.side, generatedAt: Date.now() - 1000, observedAt: Date.now() - 1000,
      state: lease ? 'cooling' : 'ready', reason: 'Browser fixture: a fresh active zone; no real Pod is connected.', physicalVerification: 'unverified', lease,
      proposal: lease ? null : { scope: 'a'.repeat(64), fromTargetF: 70, targetF: 68, expiresAt: clock + 1200_000 },
    }))
    const submit = protocol.procedure.input(controlRequestSchema).mutation(({ input }) => {
      calls.push(input)
      if (input.action.kind === 'cooling.start') {
        lease = { version: 1, id: input.action.coolingId, side: input.action.side, scope: input.action.expectedScope,
          fromTargetF: 70, targetF: 68, startedAt: input.issuedAt, expiresAt: input.action.expectedExpiresAt, sessionEndsAt: clock + 28800_000, phase: 'active' }
      }
      else if (input.action.kind === 'cooling.cancel') {
        if (!lost) lease = null
      }
      else throw new Error('Unexpected hardware action in the fixture')
      const receipt: ControlReceipt = { ...input, version: 1, receivedAt: input.issuedAt, finishedAt: input.issuedAt,
        lastDispatchAt: input.issuedAt, state: 'acknowledged', reason: null, dispatchCount: 1, physicalVerification: 'unverified', replayAllowed: false }
      receipts.set(input.requestId, receipt)
      return receipt
    })
    const read = protocol.procedure.input(z.object({ requestId: z.string() })).query(({ input }) => receipts.get(input.requestId))
    // Only the fixture handles mutations. Other batched reads retain actual isolated-server data.
    await page.route('**/api/trpc/**', async (route) => {
      const incoming = route.request()
      const paths = decodeURIComponent(new URL(incoming.url()).pathname.split('/api/trpc/')[1]).split(',')
      if (!paths.some(path => ['device.getCooling', 'controls.submit', 'controls.get'].includes(path)) && incoming.method() !== 'POST') return route.continue()
      const procedures = Object.fromEntries(paths.map(path => [path,
        path === 'device.getCooling'
          ? cooling
          : path === 'controls.submit'
            ? submit
            : path === 'controls.get'
              ? read
              : protocol.procedure.input(z.unknown()).query(async ({ input }) => {
                  const forwarded = await request.get(`/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`,
                    { headers: { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` } })
                  const result = await forwarded.json()
                  if (!result.result?.data) throw new Error('Fixture read unavailable')
                  return superjson.deserialize(result.result.data)
                }),
      ]))
      const response = await fetchRequestHandler({ endpoint: '/api/trpc', router: protocol.router(procedures),
        req: new Request(incoming.url(), { method: incoming.method(), headers: incoming.headers(), body: incoming.postData() }), createContext: () => ({}) })
      if (lost && incoming.method() === 'POST') return route.abort('connectionfailed')
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    })
    await page.goto('/en')
    const coolingRegion = page.getByRole('region', { name: 'Temporary cooling', exact: true })
    const review = coolingRegion.getByRole('button', { name: 'I’m too hot' })
    await expect(review).toBeEnabled()
    await review.click()
    await expect(coolingRegion.getByText(/Request 68°F instead of 70°F/)).toBeVisible()
    await coolingRegion.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
    await page.screenshot({ path: testInfo.outputPath(`cooling-${width}-review.png`) })
    expect(calls).toHaveLength(0)
    await coolingRegion.getByRole('button', { name: 'Start temporary cooling' }).click()
    await expect(coolingRegion.getByRole('status')).toContainText('Pod acknowledged')
    await expect(coolingRegion.getByText(/Requested 68°F/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`cooling-${width}-active.png`) })
    await coolingRegion.getByRole('button', { name: 'Cancel temporary cooling' }).click()
    await expect(review).toBeEnabled()
    expect(calls.map(call => call.action.kind)).toEqual(['cooling.start', 'cooling.cancel'])
    lost = true
    await review.click()
    await coolingRegion.getByRole('button', { name: 'Start temporary cooling' }).click()
    await expect(coolingRegion.getByRole('status')).toContainText('response was lost')
    await page.screenshot({ path: testInfo.outputPath(`cooling-${width}-lost.png`) })
    await coolingRegion.getByRole('button', { name: 'Check last request' }).click()
    await expect(coolingRegion.getByRole('status')).toContainText('Pod acknowledged')
    expect(calls).toHaveLength(3)
    const cancel = coolingRegion.getByRole('button', { name: 'Cancel temporary cooling' })
    await cancel.click()
    await expect(coolingRegion.getByRole('status')).toContainText('response was lost')
    await expect(cancel).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath(`cooling-${width}-cancel-lost.png`) })
    await coolingRegion.getByRole('button', { name: 'Check last request' }).click()
    await expect(coolingRegion.getByRole('status')).toContainText('Pod acknowledged')
    expect(calls).toHaveLength(4)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

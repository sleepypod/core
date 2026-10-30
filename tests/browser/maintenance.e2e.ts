import { test, expect } from './ownerTest'
import { initTRPC } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import superjson from 'superjson'
import { z } from 'zod'

test('Device restart uses the maintenance contract and distinguishes denial, acceptance and lost replies', async ({ page, playwright }, testInfo) => {
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  expect((await anonymous.post('/api/health/restart-service', { data: { unit: 'sleepypod.service' } })).status()).toBe(401)
  await anonymous.dispose()

  const calls: { path: string, input: unknown }[] = []
  let outcome: 'denied' | 'accepted' | 'lost' = 'denied'
  const protocol = initTRPC.create({ transformer: superjson })
  const fixtureRouter = protocol.router({ health: protocol.router({ restartService: protocol.procedure
    .input(z.object({ unit: z.literal('sleepypod.service') }))
    .mutation(() => ({ ok: outcome === 'accepted', message: outcome === 'accepted'
      ? 'Restart requested. Reconnect to check its status.'
      : 'Restart permission denied by the test fixture.' })),
  }) })
  // Intercept every mutation here, including the old updater route: this browser
  // test must never run a host service command or download a release.
  await page.route('**/api/trpc/**', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') return route.continue()
    calls.push({ path: new URL(request.url()).pathname, input: request.postDataJSON() })
    if (outcome === 'lost') return route.abort('connectionfailed')
    // Use the installed tRPC encoder so this exercises the real JSONL streaming client.
    const response = await fetchRequestHandler({ endpoint: '/api/trpc', router: fixtureRouter,
      req: new Request(request.url(), { method: 'POST', headers: request.headers(), body: request.postData() }), createContext: () => ({}) })
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
  })
  await page.goto('/en/settings?section=device')
  const restart = page.getByRole('button', { name: 'Restart service', exact: true })
  page.once('dialog', dialog => dialog.dismiss())
  await restart.click()
  expect(calls).toHaveLength(0)
  page.on('dialog', dialog => dialog.accept())
  await restart.click()
  await expect(page.getByText('Restart permission denied by the test fixture.', { exact: true })).toBeVisible()
  expect(calls).toEqual([{ path: '/api/trpc/health.restartService', input: { 0: { json: { unit: 'sleepypod.service' } } } }])

  outcome = 'accepted'
  await restart.click()
  const receipt = page.getByText('Restart requested. Reconnect to check its status.', { exact: true })
  await expect(receipt).toBeVisible()
  await expect(restart).toBeDisabled()
  await expect(page.getByText('Restart permission denied by the test fixture.', { exact: true })).toHaveCount(0)
  await receipt.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('maintenance-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await receipt.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('maintenance-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  outcome = 'lost'
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reconnect', exact: true }).click()])
  await expect(restart).toBeEnabled()
  await restart.click()
  await expect(page.getByText('Restart could not be confirmed. Reconnect to check the service before trying again.', { exact: true })).toBeVisible()
  await expect(receipt).toHaveCount(0)
  await expect(restart).toBeDisabled()
  expect(calls).toHaveLength(3)
  expect(calls.every(call => call.path === '/api/trpc/health.restartService')).toBe(true)
})

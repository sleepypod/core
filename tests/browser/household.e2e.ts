import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from './ownerTest'

// Executed inside the browser, including its actual shared cookie jar.
async function browserLogin(input: { key: string, owner?: boolean, exitPersonal?: boolean }) {
  const state = await (await fetch('/api/auth/session', { cache: 'no-store' })).json()
  const response = await fetch(input.owner ? '/api/auth/session' : '/api/v1/household/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(state.browserScopeRevision ? { 'X-Sleepypod-Browser-Revision': state.browserScopeRevision } : {}) },
    body: JSON.stringify({ token: input.key, ...(input.owner ? { exitPersonalSession: input.exitPersonal === true } : {}) }),
  })
  return response.status
}

test('Marissa guide works on phone and desktop without sending any API requests', async ({ page }) => {
  const apiRequests: string[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', (route) => {
    apiRequests.push(route.request().url())
    return route.abort()
  })
  await page.goto('/guide/marissa.html')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('heading', { name: 'Make yourself comfortable.' })).toBeVisible()
  await page.getByRole('button', { name: 'Let’s begin' }).click()
  await page.getByRole('button', { name: 'Got it' }).click()
  await page.getByRole('button', { name: 'Check home Wi-Fi, then try reconnecting' }).click()
  await expect(page.locator('#connection-feedback')).toContainText('Exactly')
  await page.getByRole('button', { name: 'Next: temperatures' }).click()
  await page.getByRole('button', { name: 'Lower practice target one degree' }).click()
  await expect(page.locator('#temp-value')).toHaveText('75')
  await page.getByRole('button', { name: 'Turn practice side off' }).click()
  await expect(page.locator('#temp-caption')).toHaveText('Practice side is off')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: test.info().outputPath('marissa-guide-temperature-phone.png'), fullPage: true })
  await page.getByRole('button', { name: 'Next: your routine' }).click()
  await page.getByLabel('Wake-up', { exact: true }).fill('08:15')
  await page.getByLabel('Which mornings?').selectOption('weekends')
  await expect(page.locator('#routine-feedback')).toContainText('Friday & Saturday nights')
  await expect(page.locator('#warmup-label')).toContainText('7:45 AM')
  await page.getByRole('button', { name: 'Next: sleep in' }).click()
  await page.getByRole('button', { name: 'Preview change' }).click()
  await expect(page.locator('#wake-preview')).toContainText('Clock and wake-up lights have NOT changed')
  await page.getByRole('button', { name: 'Next: Autopilot' }).click()
  await page.getByRole('button', { name: 'Too warm' }).click()
  await expect(page.locator('#comfort-feedback')).toContainText('guide sends nothing')
  await page.getByRole('button', { name: 'Next: privacy & help' }).click()
  await page.getByRole('button', { name: 'Finish your checklist' }).click()
  await page.getByLabel('I joined with my own invitation.').check()
  await page.getByRole('button', { name: 'Finish the guide' }).click()
  await expect(page.locator('#progress-label')).toHaveText('8 of 8 lessons complete')
  await page.reload()
  await expect(page.locator('#progress-label')).toHaveText('8 of 8 lessons complete')
  await page.getByRole('button', { name: 'Reset practice progress' }).click()
  await expect(page.locator('#progress-label')).toHaveText('0 of 8 lessons complete')
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.screenshot({ path: test.info().outputPath('marissa-guide-dark-phone.png'), fullPage: true })
  expect(apiRequests).toEqual([])
  expect(errors).toEqual([])
})

test('real personal API keeps two browser accounts separate and routine drafts inert', async ({ page, browser, request }) => {
  // This scenario changes browser identity. Do not mutate the owner scope used
  // by unrelated, ordinary owner-UI fixtures in the remainder of the suite.
  await page.context().clearCookies()
  const runFixture = promisify(execFile)
  const original = (await runFixture('pnpm', ['exec', 'tsx', 'tests/browser/fixture.ts', 'household-prepare'], { env: process.env })).stdout.trim().split('\n').at(-1)
  if (!original) throw new Error('Missing original fixture arrangement')
  const ownerHeaders = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const beforeRoutines = await (await request.get('/api/routines?side=left', { headers: ownerHeaders })).json()
  const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } })
  try {
    await page.goto('/household/index.html')
    await page.getByText('Owner: prepare this Pod', { exact: true }).click()
    await page.getByLabel('Existing owner connection key').fill(process.env.SLEEPYPOD_AUTH_TOKEN ?? '')
    await page.locator('#owner-name').fill('Example owner')
    await page.locator('#owner-ack').check()
    await page.getByRole('button', { name: 'Create my personal workspace' }).click()
    await expect(page.getByRole('heading', { name: 'Hello, Example owner.' })).not.toBeVisible()
    const ownerPersonalKey = await page.locator('#recovery-key').inputValue()
    await page.getByRole('button', { name: 'I saved it privately' }).click()
    await expect(page.getByRole('heading', { name: 'Hello, Example owner.' })).toBeVisible()
    await page.getByLabel('Preferred overnight target').fill('70')
    await page.getByRole('button', { name: 'Save my preferences' }).click()
    await expect(page.getByRole('status')).toContainText('bed target was not changed')
    await page.getByLabel('Invitation for').selectOption('new_person')
    await page.getByRole('button', { name: 'Create a 30-minute invitation' }).click()
    await expect(page.getByRole('status')).toContainText('private invitation is ready')
    const invitationLink = await page.locator('#invitation-link').inputValue()
    const memberPage = await memberContext.newPage()
    await memberPage.goto(invitationLink)
    await expect(memberPage).toHaveURL(/\/household\/index.html$/)
    await memberPage.getByLabel('Your name', { exact: true }).fill('Example member')
    await memberPage.getByRole('button', { name: 'Prepare my account' }).click()
    await expect(memberPage.getByRole('heading', { name: 'Hello, Example member.' })).not.toBeVisible()
    const memberKey = await memberPage.locator('#recovery-key').inputValue()
    await memberPage.getByRole('button', { name: 'I saved it privately' }).click()
    await expect(memberPage.getByRole('heading', { name: 'Hello, Example member.' })).toBeVisible()
    await expect(memberPage.locator('#assignment')).toContainText('no active bed side assigned')
    await expect(memberPage.getByLabel('Preferred overnight target')).toHaveValue('76')
    await memberPage.getByLabel('Preferred overnight target').fill('82')
    await memberPage.getByRole('button', { name: 'Save my preferences' }).click()
    await expect(memberPage.getByRole('status')).toContainText('preferences were saved')
    await memberPage.getByLabel('Night beginning on').selectOption('friday')
    await memberPage.getByRole('button', { name: 'Add Friday night' }).click()
    await memberPage.getByLabel('Include a wake alarm').check()
    await expect(memberPage.locator('#routine-summary')).toContainText('Saturday')
    await memberPage.getByRole('button', { name: 'Save my private draft' }).click()
    await expect(memberPage.getByTestId('personal-result')).toContainText('operating routine and alarm have not changed')
    await expect.poll(() => memberPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await memberPage.screenshot({ path: test.info().outputPath('personal-workspace-member.png'), fullPage: true })
    await page.reload()
    await expect(page.getByLabel('Preferred overnight target')).toHaveValue('70')
    expect(await (await request.get('/api/routines?side=left', { headers: ownerHeaders })).json()).toEqual(beforeRoutines)
    const memberHeaders = { Authorization: `Bearer ${memberKey}` }
    // The real history route returns attributed records only. Joining never
    // adopts the old source-side rows from the seeded biometric database.
    const historyRange = new URLSearchParams({ startsAt: String(Date.parse('2026-10-10T00:00:00Z')),
      endsAt: String(Date.parse('2026-10-12T00:00:00Z')), kind: 'presence' }).toString()
    const historyResponse = await request.get(`/api/v1/me/sleep?${historyRange}`, { headers: memberHeaders })
    expect(historyResponse.status()).toBe(200)
    expect(historyResponse.headers()['cache-control']).toBe('private, no-store')
    const historySession = await (await request.get('/api/v1/household/session', { headers: memberHeaders })).json()
    expect(historySession.capabilities.personalHistory).toBe(true)
    expect(await historyResponse.json()).toMatchObject({ version: 1, scope: { sleeperId: historySession.selfSleeperId }, records: [], nextCursor: null,
      interpretation: 'recordings_not_confirmed_sleep', intervalSelection: 'overlap_full_records' })
    const historyHead = await request.head(`/api/v1/me/sleep?${historyRange}`, { headers: memberHeaders })
    expect(historyHead.status()).toBe(200)
    expect(await historyHead.text()).toBe('')
    expect((await request.get(`/api/v1/me/sleep?${historyRange}`, { headers: ownerHeaders })).status()).toBe(401)
    expect((await request.get(`/api/v1/me/sleep?${historyRange}&side=left`, { headers: memberHeaders })).status()).toBe(400)
    expect((await request.get(`/api/v1/me/sleep/${randomUUID()}`, { headers: memberHeaders })).status()).toBe(404)
    expect((await request.post('/api/v1/me/sleep', { headers: memberHeaders, data: {} })).status()).toBe(404)
    const cookieHistory = await memberPage.evaluate(async range => (await fetch(`/api/v1/me/sleep?${range}`)).status, historyRange)
    expect(cookieHistory).toBe(409)
    // Exercise the real Next GET/POST exports. A disabled runtime still returns
    // its contract and rejects commands deliberately, rather than a missing 405 route.
    const bedResponse = await request.get('/api/v1/me/bed', { headers: memberHeaders })
    expect(bedResponse.status()).toBe(200)
    const personalBed = await bedResponse.json()
    expect(personalBed).toMatchObject({ availability: 'runtime_disabled', zones: [], routing: { temperature: [], scheduledVibration: [] } })
    const now = Date.now(), requestId = randomUUID()
    const controlResponse = await request.post('/api/v1/me/controls', { headers: memberHeaders, data: {
      version: 1, requestId, scope: personalBed.scope, issuedAt: now, expiresAt: now + 30_000,
      action: { kind: 'temperature', temperatureF: 70, holdMinutes: 30 },
    } })
    expect(controlResponse.status()).toBe(409)
    expect(await controlResponse.json()).toMatchObject({ error: { code: 'not_ready' } })
    expect((await request.get(`/api/v1/me/controls/${requestId}`, { headers: memberHeaders })).status()).toBe(404)
    const reviewResponse = await request.get('/api/v1/me/routines/review', { headers: memberHeaders })
    expect(reviewResponse.status()).toBe(409)
    expect(await reviewResponse.json()).toMatchObject({ error: { code: 'not_ready' } })
    const publicationResponse = await request.post('/api/v1/me/routines/publish', { headers: memberHeaders, data: {
      version: 1, requestId, scope: personalBed.scope, issuedAt: now, expiresAt: now + 30_000,
      reviewRevision: 'a'.repeat(64), confirmReplaceLiveWeek: true, acknowledgeCurrentTargetEffect: true,
    } })
    expect(publicationResponse.status()).toBe(409)
    expect(await publicationResponse.json()).toMatchObject({ error: { code: 'not_ready' } })
    expect((await request.get(`/api/v1/me/routines/publications/${requestId}`, { headers: memberHeaders })).status()).toBe(404)
    expect(await (await request.get('/api/v1/household/session', { headers: memberHeaders })).json())
      .toMatchObject({ capabilities: { personalRoutinePublication: false } })
    for (const path of ['/api/settings', '/api/biometrics/sleep?side=left', '/api/trpc/settings.get', '/api/db-backup', '/api/v1/controls']) expect((await request.get(path, { headers: memberHeaders })).status()).toBe(401)
    expect((await request.get('/api/system/databases/rows?db=sleepypod&table=household_personal_settings', { headers: ownerHeaders })).status()).toBe(403)
    expect((await request.get('/api/db-backup', { headers: ownerHeaders })).status()).toBe(403)
    const context = { requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1 }
    const spoof = await request.put('/api/v1/me/preferences', { headers: memberHeaders, data: { ...context, expectedRevision: 2, sleeperId: 'wrong-person', preferences: { displayUnit: 'F', preferredTemperatureF: 90, comfort: 'balanced', shareWakeTime: false, cloudAnalysisConsent: false } } })
    expect(spoof.status()).toBe(400)
    const anotherSecret = randomBytes(32).toString('base64url')
    const ownInvite = await (await request.post('/api/v1/household/invitations', { headers: memberHeaders, data: { ...context, invitation: randomBytes(32).toString('base64url'), kind: 'own_device', expiresInMinutes: 30 } })).json()
    const joined = await request.post('/api/v1/household/join', { data: { invitation: ownInvite.invitation, deviceSecret: anotherSecret, deviceName: 'Example tablet', displayName: 'Ignored for own device' } })
    expect(joined.status()).toBe(200)
    const devices = (await (await request.get('/api/v1/household/devices', { headers: { Authorization: `Bearer ${anotherSecret}` } })).json()).devices
    const deviceId = devices.find((device: { current: boolean }) => device.current).id
    expect((await request.delete('/api/v1/household/devices', { headers: memberHeaders, data: { ...context, requestId: randomUUID(), deviceId } })).status()).toBe(200)
    expect((await request.get('/api/v1/me/preferences', { headers: { Authorization: `Bearer ${anotherSecret}` } })).status()).toBe(401)
    expect((await request.get('/api/v1/me/preferences', { headers: { Authorization: `Bearer ${ownerPersonalKey}` } })).status()).toBe(200)

    // Cookie changes can precede the cross-tab notification. The old editor's
    // sleeper header must stop it writing into the newly selected account.
    expect(await memberPage.evaluate(browserLogin, { key: ownerPersonalKey })).toBe(200)
    await memberPage.getByLabel('Preferred overnight target').fill('84')
    await memberPage.getByRole('button', { name: 'Save my preferences' }).click()
    await expect(memberPage.getByRole('status')).toContainText('account changed')
    const ownerPreferences = await (await request.get('/api/v1/me/preferences', { headers: { Authorization: `Bearer ${ownerPersonalKey}` } })).json()
    expect(ownerPreferences.preferences.preferredTemperatureF).toBe(70)
    const memberPreferences = await (await request.get('/api/v1/me/preferences', { headers: memberHeaders })).json()
    expect(memberPreferences.preferences.preferredTemperatureF).toBe(82)

    // An older owner login response cannot override a personal browser scope.
    expect(await memberPage.evaluate(browserLogin, { key: process.env.SLEEPYPOD_AUTH_TOKEN ?? '', owner: true })).toBe(200)
    const staleOwnerResult = await memberPage.evaluate(async () => {
      return { legacy: (await fetch('/api/settings')).status, session: await (await fetch('/api/auth/session')).json() }
    })
    expect(staleOwnerResult.legacy).toBe(401)
    expect(staleOwnerResult.session).toMatchObject({ authenticated: false, personalSessionActive: true })

    let releaseOwnerResponse: () => void = () => {}
    let markOwnerProcessed: () => void = () => {}
    const ownerProcessed = new Promise<void>((resolve) => {
      markOwnerProcessed = resolve
    })
    const releaseOwner = new Promise<void>((resolve) => {
      releaseOwnerResponse = resolve
    })
    await memberPage.route('**/api/auth/session', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      markOwnerProcessed()
      await releaseOwner
      await route.fulfill({ response })
    })
    const delayedLogin = memberPage.evaluate(browserLogin, { key: process.env.SLEEPYPOD_AUTH_TOKEN ?? '', owner: true, exitPersonal: true })
    try {
      await ownerProcessed
      // A second login commits while the first response is still in flight.
      expect(await memberPage.evaluate(browserLogin, { key: ownerPersonalKey })).toBe(200)
    }
    finally { releaseOwnerResponse() }
    expect(await delayedLogin).toBe(200)
    await memberPage.unroute('**/api/auth/session')
    const reordered = await memberPage.evaluate(async () => ({ legacy: (await fetch('/api/settings')).status, session: await (await fetch('/api/auth/session')).json() }))
    expect(reordered.legacy).toBe(401)
    expect(reordered.session).toMatchObject({ authenticated: false, personalSessionActive: true })
    expect(await memberPage.evaluate(browserLogin, { key: process.env.SLEEPYPOD_AUTH_TOKEN ?? '', owner: true, exitPersonal: true })).toBe(200)
    const explicitOwnerResult = await memberPage.evaluate(async () => {
      return { legacy: (await fetch('/api/settings')).status, personal: (await fetch('/api/v1/me/preferences')).status }
    })
    expect(explicitOwnerResult).toEqual({ legacy: 200, personal: 401 })

    const secondOwnerTab = await page.context().newPage()
    await secondOwnerTab.goto('/household/index.html')
    await expect(secondOwnerTab.getByRole('heading', { name: 'Hello, Example owner.' })).toBeVisible()
    await page.getByRole('button', { name: 'Sign out here' }).click()
    await expect(secondOwnerTab.getByRole('heading', { name: 'Hello, Example owner.' })).not.toBeVisible()
    await expect(secondOwnerTab.getByRole('status')).toContainText('account changed in another tab')
    await secondOwnerTab.close()
    expect(await memberPage.evaluate(browserLogin, { key: memberKey })).toBe(200)
    await memberPage.route('**/api/v1/me/routines', async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...await response.json(), status: 'scheduled' } })
    })
    await memberPage.reload()
    await expect(memberPage.getByRole('status')).toContainText('preparation workspace can edit drafts only')
    await expect(memberPage.getByLabel('Preferred overnight target')).not.toBeVisible()
    await expect(memberPage.getByRole('button', { name: 'Save my private draft' })).not.toBeVisible()
  }
  finally {
    await memberContext.close()
    await runFixture('pnpm', ['exec', 'tsx', 'tests/browser/fixture.ts', 'household-cleanup', original], { env: process.env })
  }
})

test('an older owner tab opens the isolated personal workspace after shared activation', async ({ page }) => {
  // UI-only fixture: the persistent boundary itself is tested against migrated
  // SQLite and real HTTP/stream guards. No shared browser database is activated.
  await page.route('**/api/auth/session', route => route.fulfill({ json: {
    configured: true, authenticated: false, personalConnectionRequired: true, privacyAvailable: true,
  } }))
  const oldOwnerRequests: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/') && path !== '/api/auth/session' && !path.startsWith('/api/v1/household/')) oldOwnerRequests.push(path)
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/en/sleep')
  const workspace = page.getByRole('link', { name: 'Open my personal workspace' })
  await expect(workspace).toBeVisible()
  await expect(page.getByLabel('Connection key', { exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: test.info().outputPath('personal-connection-required.png'), fullPage: true })
  await workspace.click()
  await expect(page).toHaveURL(/\/household\/index.html$/)
  await expect(page.getByRole('heading', { name: 'Join with an invitation' })).toBeVisible()
  expect(oldOwnerRequests).toEqual([])
})

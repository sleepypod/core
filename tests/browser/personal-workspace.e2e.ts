import { test, expect, type Page } from '@playwright/test'
import preparation from '../../src/household/fixtures/preparation-v1.json' with { type: 'json' }
import controls from '../../src/household/fixtures/personal-controls-v1.json' with { type: 'json' }
import routines from '../../src/household/fixtures/personal-routines-v1.json' with { type: 'json' }

// These UI scenarios intercept every API request. The real server's hardware
// flags remain off; household.e2e covers its real disabled-runtime boundaries.
async function mockPersonal(page: Page, loseFirstControl = false) {
  const session = { ...structuredClone(preparation.ownerSession), selfSleeperId: controls.soloBed.scope.sleeperId,
    capabilities: { ...preparation.ownerSession.capabilities, personalControls: true, personalRoutinePublication: true } }
  const review = structuredClone(routines.readyReview)
  let drafts = { ...preparation.routines, sleeperId: session.selfSleeperId, revision: 2, routines: structuredClone(review.draftWeek) }
  const receipts = new Map<string, unknown>()
  const posts: Array<{ path: string, body: Record<string, unknown> }> = []
  const unexpected: string[] = []
  let lost = false
  await page.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    const body = request.method() === 'GET' ? undefined : request.postDataJSON()
    const json = (value: unknown) => route.fulfill({ json: value })
    if (path === '/api/v1/household/session' && request.method() === 'GET') return json(session)
    if (path === '/api/v1/me/preferences') return json({ ...preparation.preferences, sleeperId: session.selfSleeperId, preferences: { ...preparation.preferences.preferences, preferredTemperatureF: 70 } })
    if (path === '/api/v1/household/devices') return json(preparation.devices)
    if (path === '/api/v1/household/invitations') return json({ invitations: [] })
    if (path === '/api/v1/me/bed') return json({ ...controls.soloBed, observation: { ...controls.soloBed.observation, observedAt: Date.now() } })
    if (path === '/api/v1/me/routines' && request.method() === 'GET') return json(drafts)
    if (path === '/api/v1/me/routines' && request.method() === 'PUT') {
      posts.push({ path, body })
      drafts = { ...drafts, revision: drafts.revision + 1, routines: body.routines }
      review.draftWeek = body.routines
      review.draftRevision = drafts.revision
      return json(drafts)
    }
    if (path === '/api/v1/me/routines/review') return json(review)
    if (path === '/api/v1/me/controls') {
      posts.push({ path, body })
      const receipt = { ...controls.acknowledged, ...body, receivedAt: Date.now(), finishedAt: Date.now(), lastDispatchAt: Date.now() }
      receipts.set(body.requestId, receipt)
      if (loseFirstControl && !lost) {
        lost = true
        return route.abort('failed')
      }
      return json(receipt)
    }
    if (path === '/api/v1/me/routines/publish') {
      posts.push({ path, body })
      const receipt = { ...routines.saved, requestId: body.requestId, draftRevision: drafts.revision, publishedWeek: drafts.routines.map(night => ({ ...night, revision: 'f'.repeat(64) })) }
      receipts.set(body.requestId, receipt)
      return json(receipt)
    }
    const receipt = receipts.get(path.split('/').at(-1) ?? '')
    if (receipt && request.method() === 'GET') return json(receipt)
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 404, json: { error: 'unmocked route' } })
  })
  return { session, review, posts, unexpected }
}

test('private web keeps uncertain requests across reload and preserves explicit Stop', async ({ page }) => {
  const fixture = await mockPersonal(page, true)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/household/index.html')
  await expect(page.getByText('Mixed targets — Left and Right currently report different settings.')).toBeVisible()
  await page.getByLabel('New target (°F)').fill('70')
  await page.getByRole('button', { name: 'Apply my target' }).click()
  await expect(page.getByRole('region', { name: 'Saved request recovery' }).or(page.locator('article[aria-label="Saved request recovery"]'))).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply my target' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Stop temperature', exact: true })).toBeEnabled()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Check saved result' })).toBeVisible()
  expect(fixture.posts).toHaveLength(1)
  await page.getByRole('button', { name: 'Check saved result' }).click()
  await expect(page.getByTestId('personal-result')).toContainText('acknowledged')
  expect(fixture.posts).toHaveLength(1)
  await page.getByRole('button', { name: 'Stop temperature', exact: true }).click()
  await expect.poll(() => fixture.posts.length).toBe(2)
  expect(fixture.posts[1].body.action).toEqual({ kind: 'power', powered: false })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addStyleTag({ content: ':root{font-size:24px}' })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.locator('.personal-bed').scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('personal-controls-dark-large-phone.png') })
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
})

test('full week editor preserves actual plan and requires review plus two publication acknowledgments', async ({ page }) => {
  const fixture = await mockPersonal(page)
  fixture.review.liveWeek[0].draft.alarm.snoozeDuration = 541
  fixture.review.liveWeek[0].draft.temperatures = [{ time: '02:00', temperature: 69, enabled: true }] as never
  await page.goto('/household/index.html')
  await page.getByRole('button', { name: 'Load current bed plan into editor' }).click()
  await expect(page.getByLabel('Overnight target (°F)', { exact: true })).toHaveValue('70')
  await page.getByText('Vibration & snooze', { exact: true }).click()
  await expect(page.getByLabel('Snooze (seconds)')).toHaveValue('541')
  await expect(page.getByLabel('Wake target (°F)', { exact: true })).toHaveValue('105')
  await page.getByRole('button', { name: 'Save my private draft' }).click()
  await expect(page.getByTestId('personal-result')).toContainText('operating routine and alarm have not changed')
  expect(fixture.posts).toHaveLength(1)
  expect((fixture.posts[0].body.routines as Array<{ draft: unknown }>)[0].draft).toEqual(fixture.review.liveWeek[0].draft)
  await page.getByLabel('Overnight target (°F)', { exact: true }).fill('68')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Reload saved draft' }).click()
  await expect(page.getByLabel('Overnight target (°F)', { exact: true })).toHaveValue('70')
  await page.getByRole('button', { name: 'Compare with operating week' }).click()
  const publish = page.getByRole('button', { name: 'Publish my operating week' })
  await expect(publish).toBeDisabled()
  await expect(page.getByRole('region', { name: 'Whole-week comparison' })).toContainText('snooze 541s')
  await page.getByLabel('I reviewed every night, including any removed routines.').check()
  await expect(publish).toBeDisabled()
  await page.getByLabel('I understand publishing can change the current bed target.').check()
  await publish.click()
  await expect(page.getByTestId('personal-result')).toContainText('saved and registered')
  expect(fixture.posts.map(value => value.path)).toEqual(['/api/v1/me/routines', '/api/v1/me/routines/publish'])
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  expect(fixture.unexpected).toEqual([])
})

test('a slow preferences save does not disable the personal Stop buttons', async ({ page }) => {
  const fixture = await mockPersonal(page)
  await page.goto('/household/index.html')
  await expect(page.getByRole('button', { name: 'Stop temperature', exact: true })).toBeEnabled()
  let release!: () => void
  const pending = new Promise<void>(resolve => release = resolve)
  await page.route('**/api/v1/me/preferences', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    await pending
    await route.fulfill({ json: { ...preparation.preferences, sleeperId: fixture.session.selfSleeperId } })
  })
  try {
    await page.getByRole('button', { name: 'Save my preferences' }).click()
    await expect(page.getByRole('button', { name: 'Save my preferences' })).toBeDisabled()
    await page.getByRole('button', { name: 'Stop temperature', exact: true }).click()
    await expect.poll(() => fixture.posts.length).toBe(1)
    expect(fixture.posts[0].body.action).toEqual({ kind: 'power', powered: false })
  }
  finally { release() }
  await expect(page.getByRole('button', { name: 'Save my preferences' })).toBeEnabled()
})

test('IndexedDB reserves atomically across tabs, preserves capacity, and separates people', async ({ page, context }) => {
  await mockPersonal(page)
  await page.goto('/household/index.html')
  const other = await context.newPage()
  await mockPersonal(other)
  await other.goto('/household/index.html')
  const result = await page.evaluate(async () => {
    const modulePath = '/household/personal-runtime.js'
    const { BrowserRecoveryJournal } = await import(modulePath)
    const first = new BrowserRecoveryJournal(), second = new BrowserRecoveryJournal()
    const identity = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004']
    const reference = { version: 1, requestId: crypto.randomUUID(), identity, identityKey: identity.join(':'), kind: 'control', fingerprint: 'a'.repeat(64), expiresAt: Date.now() + 30000 }
    const results = await Promise.allSettled([first.reserve(reference), second.reserve({ ...reference, requestId: crypto.randomUUID() })])
    const session = { podId: identity[0], householdId: identity[1], accountId: identity[2], selfSleeperId: identity[3] }
    const rows = await first.list(session)
    let protectedRemoval = false
    try {
      await first.remove({ ...rows[0], fingerprint: 'b'.repeat(64) })
    }
    catch { protectedRemoval = true }
    const foreign = await first.list({ ...session, accountId: crypto.randomUUID() })
    for (let index = 1; index < 64; index++) await first.reserve({ ...reference, requestId: crypto.randomUUID() }, true)
    let full = false
    try {
      await first.reserve({ ...reference, requestId: crypto.randomUUID() }, true)
    }
    catch { full = true }
    return { successes: results.filter(value => value.status === 'fulfilled').length, count: (await first.list(session)).length, protectedRemoval, foreign: foreign.length, full, keys: Object.keys(rows[0]).sort() }
  })
  expect(result).toEqual({ successes: 1, count: 64, protectedRemoval: true, foreign: 0, full: true, keys: ['expiresAt', 'fingerprint', 'identity', 'identityKey', 'kind', 'requestId', 'version'] })
  await other.close()
})

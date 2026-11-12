import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from './ownerTest'
import { mockPersonal } from './personal-fixture'
import { migratedComfortDatabase } from '../../src/comfort/tests/databaseFixture'
import { ComfortExperimentService } from '../../src/comfort/experiments/service'
import { experimentErrorResponse, experimentResponse } from '../../src/comfort/experiments/http'
import { context, createdAt, fixtureSchedule } from '../../src/comfort/experiments/tests/fixture'
test.use({ serviceWorkers: 'block' })
async function fixture(page: Page, personal = false) {
  const database = migratedComfortDatabase()
  let now = createdAt
  let scope: object
  if (personal) {
    const account = await mockPersonal(page)
    Object.assign(account.session.capabilities, { comfortExperiments: true })
    const session = account.session
    scope = { kind: 'personal', podId: session.podId, householdId: session.householdId, accountId: session.accountId,
      sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
      assignmentRevision: session.assignmentRevision, householdRevision: session.householdRevision }
  }
  else {
    const installationId = randomUUID()
    scope = { kind: 'legacy', installationId }
    await page.route('**/api/v1/connection?*', route => route.fulfill({ json: { schemaVersion: 1, controller: 'sleepypod-core', installationId,
      challenge: new URL(route.request().url()).searchParams.get('challenge') } }))
  }
  await page.clock.setFixedTime(new Date(now))
  const service = new ComfortExperimentService(database, () => now, () => ({ context, reason: 'Synthetic test policy',
    schedule: fixtureSchedule(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday']) }))
  const controls = { lostConfirmation: false, writes: [] as string[], beforeReply: async () => { }, async advance() {
    now = Date.parse('2026-11-17T10:00:00Z')
    await page.clock.setFixedTime(new Date(now))
  }, close: () => database.close() }
  await page.route(personal ? '**/api/v1/me/comfort-experiments**' : '**/api/v1/comfort/experiments**', async (route) => {
    const original = route.request()
    if (original.method() === 'POST')
      controls.writes.push(new URL(original.url()).pathname)
    const request = new Request(original.url(), { method: original.method() })
    let response: Response
    try {
      response = experimentResponse(request, original.method() === 'POST' ? original.postDataJSON() : undefined, service, () => ({ scope, subjectKey: context.subjectKey, binding: {}, ready: true, routineSide: 'left' }), () => now)
    }
    catch (error) {
      response = experimentErrorResponse(error)
    }
    const body = await response.text()
    await controls.beforeReply()
    if (controls.lostConfirmation && original.url().endsWith('/confirm'))
      return route.abort('failed')
    await route.fulfill({ status: response.status, contentType: 'application/json', body })
  })
  return controls
}

test('back keeps the chosen setting and date; expiry cannot submit a stale review', async ({ page }, testInfo) => {
  const data = await fixture(page)
  try {
    await review(page)
    await panel(page).getByRole('button', { name: 'Back to settings' }).click()
    await expect(panel(page).getByRole('heading', { name: 'A small change, within your comfort range' })).toBeFocused()
    await expect(panel(page).getByLabel('Nearby setting')).toHaveValue('69')
    await expect(panel(page).getByLabel('Start no earlier than')).toHaveValue('2026-11-15')
    await panel(page).getByRole('button', { name: 'Preview comparison nights' }).click()
    await expect(panel(page).getByRole('region', { name: 'Review comparison' })).toBeFocused()
    await page.clock.setFixedTime(new Date(createdAt + 5 * 60000))
    await expect(panel(page)).toContainText('The review expired')
    await expect(panel(page).getByRole('heading', { name: 'A small change, within your comfort range' })).toBeFocused()
    await expect(panel(page)).toContainText('Your scheduled setting is 70°F. Your overnight range is 68°F–72°F')
    await expect(panel(page)).toContainText('Dates follow UTC.')
    await expect(panel(page).getByRole('button', { name: 'Save comparison plan' })).toHaveCount(0)
    expect(data.writes.filter(path => path.endsWith('/confirm'))).toEqual([])
    await panel(page).screenshot({ path: testInfo.outputPath('experiment-expired.png') })
  }
  finally { data.close() }
})
const panel = (page: Page) => page.getByRole('region', { name: 'Find your comfortable setting' })
async function review(page: Page, personal = false) {
  await page.goto(personal ? '/household/index.html' : '/en/autopilot?view=learning')
  await panel(page).getByRole('button', { name: 'Open my comparisons' }).click()
  await panel(page).getByLabel('Nearby setting').selectOption('69')
  await panel(page).getByLabel('Start no earlier than').fill('2026-11-15')
  await panel(page).getByRole('button', { name: 'Preview comparison nights' }).click()
  await expect(panel(page).getByRole('region', { name: 'Review comparison' })).toBeFocused()
}
for (const width of [390, 1024]) {
  test(`owner reviews scheduled nights, saves and stops at ${width}px`, async ({ page }, testInfo) => {
    const data = await fixture(page)
    try {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 })
      await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light', reducedMotion: 'reduce' })
      await review(page)
      if (width === 390)
        await page.addStyleTag({ content: 'html{font-size:24px}' })
      await panel(page).screenshot({ path: testInfo.outputPath(`experiment-summary-${width}.png`) })
      await expect(panel(page)).toContainText('16 nights, Sun, Nov 15, 2026')
      await expect(panel(page)).toContainText('This review expires in 5 minutes.')
      await panel(page).getByText('Review all 16 nights', { exact: true }).click()
      await expect(panel(page).getByRole('list', { name: 'Comparison night plan' }).locator('> li')).toHaveCount(16)
      await expect(panel(page)).toContainText('Pair 1 · Settling night')
      await expect(panel(page)).toContainText('6:30 AM')
      await expect(panel(page)).toContainText('7:00 AM with 20s vibration')
      await expect(panel(page)).toContainText('105°F')
      await panel(page).getByText(/skipped dates —/).click()
      await expect(panel(page)).toContainText('No bedtime routine')
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      if (width === 390) {
        await panel(page).getByRole('list', { name: 'Comparison night plan' }).locator('> li').first().scrollIntoViewIfNeeded()
        await page.screenshot({ path: testInfo.outputPath('experiment-nights-phone-start.png') })
        await panel(page).getByRole('list', { name: 'Comparison night plan' }).locator('> li').last().scrollIntoViewIfNeeded()
        await page.screenshot({ path: testInfo.outputPath('experiment-nights-phone-end.png') })
      }
      else await panel(page).screenshot({ path: testInfo.outputPath(`experiment-review-${width}.png`) })
      await panel(page).getByRole('button', { name: 'Save comparison plan' }).click()
      await expect(panel(page).getByRole('region', { name: 'Saved comparison' })).toBeFocused()
      await expect(panel(page)).toContainText('Overnight control has not been activated')
      await panel(page).screenshot({ path: testInfo.outputPath(`experiment-saved-${width}.png`) })
      await panel(page).getByRole('button', { name: 'Stop comparison', exact: true }).click()
      await expect(panel(page).getByRole('heading', { name: 'Comparison stopped' })).toBeVisible()
      await expect(panel(page).getByRole('button', { name: 'Stop comparison', exact: true })).toHaveCount(0)
      expect(data.writes.map(path => path.split('/').at(-1))).toEqual(['preview', 'confirm', 'stop'])
    }
    finally {
      data.close()
    }
  })
}
test('a lost save reply offers read-only recovery and hiding withdraws the private review', async ({ page }, testInfo) => {
  const data = await fixture(page)
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await review(page)
    data.lostConfirmation = true
    await panel(page).getByRole('button', { name: 'Save comparison plan' }).click()
    await expect(panel(page).getByRole('alert')).toContainText('uncertain')
    await panel(page).screenshot({ path: testInfo.outputPath('experiment-uncertain-phone.png') })
    await panel(page).getByRole('button', { name: 'Check saved result' }).click()
    await expect(panel(page).getByRole('heading', { name: 'Your saved comparison' })).toBeVisible()
    expect(data.writes.filter(path => path.endsWith('/confirm'))).toHaveLength(1)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(panel(page).getByRole('region', { name: 'Saved comparison' })).toHaveCount(0)
  }
  finally {
    data.close()
  }
})
test('personal accounts review independently and save honest morning feedback', async ({ page }, testInfo) => {
  const data = await fixture(page, true)
  const ownerRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/comfort/experiments'))
      ownerRequests.push(request.url())
  })
  try {
    await page.setViewportSize({ width: 834, height: 1100 })
    await review(page, true)
    await panel(page).getByRole('button', { name: 'Save comparison plan' }).click()
    await expect(panel(page).getByRole('heading', { name: 'Your saved comparison' })).toBeVisible()
    await data.advance()
    await panel(page).getByLabel('Night beginning').selectOption('2026-11-15')
    await panel(page).getByLabel('Comfort, from 0 to 10').selectOption('8')
    await panel(page).getByLabel('Was this a full night for you?').selectOption('yes')
    await panel(page).getByLabel('Unwanted temperature changes').fill('0')
    await panel(page).getByLabel('Did you notice a problem?').selectOption('no')
    await panel(page).getByRole('button', { name: 'Save morning feedback' }).click()
    await expect(panel(page)).toContainText('Morning feedback saved')
    await expect(panel(page)).toContainText('More evidence needed')
    await panel(page).getByText('Saved check-ins and recording gaps', { exact: true }).click()
    await expect(panel(page)).toContainText('Comfort 8/10')
    await expect(panel(page)).toContainText('Temperature exposure not verified')
    await panel(page).screenshot({ path: testInfo.outputPath('experiment-personal-feedback-tablet.png') })
    expect(ownerRequests).toEqual([])
  }
  finally {
    data.close()
  }
})

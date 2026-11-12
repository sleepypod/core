import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from './ownerTest'
import { mockPersonal } from './personal-fixture'
import { migratedComfortDatabase } from '../../src/comfort/tests/databaseFixture'
import { ComfortExperimentService } from '../../src/comfort/experiments/service'
import { experimentErrorResponse, experimentResponse } from '../../src/comfort/experiments/http'
import { context, createdAt, fixtureSchedule } from '../../src/comfort/experiments/tests/fixture'
import { experimentExecutionStatusSchema, type ExperimentExecutionStatus } from '../../src/comfort/experiments/execution-contract'
import { experimentPlanHash } from '../../src/comfort/experiments/plan'
import { experimentNights } from '../../src/comfort/experiments/nights'
test.use({ serviceWorkers: 'block' })
async function fixture(page: Page, personal = false) {
  const database = migratedComfortDatabase()
  let now = createdAt
  let scope: object
  if (personal) {
    const account = await mockPersonal(page)
    Object.assign(account.session.capabilities, { comfortExperiments: true, comfortExperimentExecution: true })
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
  const access = () => ({ scope, subjectKey: context.subjectKey, binding: {}, ready: true, routineSide: 'left' as const })
  const states = new Map<string, ExperimentExecutionStatus>()
  const controls = { lostConfirmation: false, lostExecution: '', ready: true, writes: [] as string[], beforeReply: async () => { }, async advance() {
    now = Date.parse('2026-11-17T10:00:00Z')
    await page.clock.setFixedTime(new Date(now))
  }, async unknownAttempt() {
    const state = [...states.values()].find(value => value.admission)
    if (!state) throw new Error('Missing browser fixture admission')
    const { plan } = service.detail(access(), state.planId).record
    if (plan.version !== 2) throw new Error('Scheduled browser fixture required')
    now = plan.schedule.windows[0].windowStart + 1001
    state.applications = [{ id: randomUUID(), side: 'left', requestedTargetF: experimentNights(plan)[0].targetF,
      attemptedAt: now - 1000, outcome: 'unknown', acknowledgment: 'unconfirmed', finishedAt: now - 500, resolution: null }]
    await page.clock.setFixedTime(new Date(now))
  }, close: () => database.close() }
  await page.route(personal ? '**/api/v1/me/comfort-experiments**' : '**/api/v1/comfort/experiments**', async (route) => {
    const original = route.request()
    if (original.method() === 'POST')
      controls.writes.push(new URL(original.url()).pathname)
    const request = new Request(original.url(), { method: original.method() })
    let response: Response
    try {
      const execution = new URL(original.url()).pathname.match(/\/([^/]+)\/execution(?:\/(preview|confirm|cancel|recover))?$/)
      if (execution) {
        // UI fixtures model receipts only. Execution unit tests use the real host,
        // migrated storage and identity checks with fake firmware; no Pod is involved.
        const id = execution[1], action = execution[2], { record } = service.detail(access(), id)
        const state = states.get(id) ?? { version: 1, generatedAt: now, scope, planId: id, planStatus: record.status,
          controllerRunning: true, state: 'not_admitted', review: null, admission: null, applications: [] } as ExperimentExecutionStatus
        const payload = original.method() === 'POST' ? original.postDataJSON() : undefined
        state.review = action === 'preview'
          ? { id: randomUUID(), planHash: experimentPlanHash(record.plan), createdAt: now, expiresAt: now + 60000, sides: ['left'] }
          : state.review
        if (action === 'preview' && !controls.ready) {
          return route.fulfill({ status: 409, json: { error: { code: 'not_ready', message: 'Complete the attended control checks and review seven Preview nights first.' } } })
        }
        if (action === 'confirm') {
          if (!state.review || payload.reviewId !== state.review.id || payload.planHash !== state.review.planHash || record.plan.version !== 2)
            throw new Error('Invalid synthetic control confirmation')
          const lastWindow = record.plan.schedule.windows.at(-1)
          if (!lastWindow) throw new Error('Missing synthetic scheduled windows')
          state.admission = { id: state.review.id, admittedAt: now, endsAt: lastWindow.windowEnd,
            revokedAt: null, reason: null, sides: ['left'] }
          state.state = 'admitted'
        }
        if (action === 'cancel' || action === 'recover') {
          if (!state.admission || payload.admissionId !== state.admission.id) throw new Error('Invalid synthetic cancellation')
          state.admission.revokedAt = now
          state.admission.reason = 'Explicit browser fixture cancellation'
          state.state = 'revoked'
          if (action === 'recover') {
            const application = state.applications.find(value => value.id === payload.applicationId)
            if (!application) throw new Error('Invalid synthetic recovery')
            application.outcome = 'resolved'
            application.resolution = { observedAt: now, resolvedAt: now, targetF: 70 }
          }
        }
        states.set(id, state)
        const result = experimentExecutionStatusSchema.parse({ ...state, generatedAt: now, planStatus: record.status, review: action === 'preview' ? state.review : null })
        response = Response.json(result)
      }
      else response = experimentResponse(request, original.method() === 'POST' ? original.postDataJSON() : undefined, service, access, () => now)
    }
    catch (error) {
      response = experimentErrorResponse(error)
    }
    const body = await response.text()
    await controls.beforeReply()
    if (controls.lostConfirmation && original.url().endsWith('/confirm'))
      return route.abort('failed')
    if (controls.lostExecution && original.url().endsWith(controls.lostExecution)) return route.abort('failed')
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

for (const width of [390, 1024]) {
  test(`explicit control review, authorization and Stop remain usable at ${width}px`, async ({ page }, testInfo) => {
    const data = await fixture(page, width === 1024)
    try {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 })
      await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light', reducedMotion: 'reduce' })
      await review(page, width === 1024)
      await panel(page).getByRole('button', { name: 'Save comparison plan' }).click()
      await expect(panel(page).getByRole('heading', { name: 'Saved, not running', exact: true })).toBeVisible()
      expect(data.writes.some(path => path.endsWith('/execution/confirm'))).toBe(false)
      if (width === 390) await page.addStyleTag({ content: 'html{font-size:24px}' })
      await panel(page).getByRole('button', { name: 'Review overnight control', exact: true }).click()
      const controlReview = panel(page).getByRole('region', { name: 'Review overnight control' })
      await expect(controlReview).toBeFocused()
      await expect(controlReview).toContainText('Left half')
      await expect(controlReview).toContainText('70°F')
      await expect(controlReview).toContainText('69°F')
      await expect(controlReview).toContainText('105°F')
      await expect(controlReview).toContainText('7:00 AM with 20s vibration')
      await expect(controlReview).toContainText('expires in 60 seconds')
      await controlReview.screenshot({ path: testInfo.outputPath(`execution-review-${width}.png`) })
      if (width === 390) {
        await controlReview.getByRole('heading', { name: 'Allow these scheduled temperatures?' }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: testInfo.outputPath('execution-review-phone-start.png') })
        const allow = controlReview.getByRole('button', { name: 'Allow scheduled comparison' })
        await allow.scrollIntoViewIfNeeded()
        await expect(allow).toBeInViewport()
        expect(await allow.evaluate((element) => {
          const box = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        })).toBe(true)
        await page.screenshot({ path: testInfo.outputPath('execution-review-phone-actions.png') })
      }
      await panel(page).getByRole('button', { name: 'Keep plan only' }).click()
      await expect(panel(page).getByRole('heading', { name: 'Saved, not running', exact: true })).toBeFocused()
      await panel(page).getByRole('button', { name: 'Review overnight control', exact: true }).click()
      await panel(page).getByRole('button', { name: 'Allow scheduled comparison' }).click()
      await expect(panel(page).getByRole('heading', { name: 'Scheduled to compare' })).toBeFocused()
      await expect(panel(page)).toContainText('Wake warming stays on its existing schedule')
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await panel(page).screenshot({ path: testInfo.outputPath(`execution-authorized-${width}.png`) })
      await panel(page).getByRole('button', { name: 'Stop comparison', exact: true }).click()
      await expect(panel(page).getByRole('heading', { name: 'Comparison stopped', exact: true })).toBeVisible()
      await expect(panel(page).getByRole('heading', { name: 'Overnight control ended' })).toBeVisible()
      expect(data.writes.slice(-2).map(path => path.split('/').at(-1))).toEqual(['stop', 'cancel'])
      if (width === 1024) expect(data.writes.every(path => path.startsWith('/api/v1/me/comfort-experiments/'))).toBe(true)
    }
    finally { data.close() }
  })
}

test('control review expiry restores focus and does not permit stale confirmation', async ({ page }, testInfo) => {
  const data = await fixture(page)
  try {
    await review(page)
    await panel(page).getByRole('button', { name: 'Save comparison plan' }).click()
    await panel(page).getByRole('button', { name: 'Review overnight control', exact: true }).click()
    await expect(panel(page).getByRole('region', { name: 'Review overnight control' })).toBeFocused()
    await page.clock.setFixedTime(new Date(createdAt + 60001))
    await expect(panel(page)).toContainText('The control review expired')
    await expect(panel(page).getByRole('button', { name: 'Allow scheduled comparison' })).toHaveCount(0)
    await expect(panel(page).getByRole('heading', { name: 'Saved, not running', exact: true })).toBeFocused()
    expect(data.writes.some(path => path.endsWith('/execution/confirm'))).toBe(false)
    await panel(page).screenshot({ path: testInfo.outputPath('execution-expired.png') })
  }
  finally { data.close() }
})

test('missing qualification explains the next step and preserves Stop and the saved plan', async ({ page }, testInfo) => {
  const data = await fixture(page)
  try {
    await review(page)
    await panel(page).getByRole('button', { name: 'Save comparison plan' }).click()
    data.ready = false
    await panel(page).getByRole('button', { name: 'Review overnight control', exact: true }).click()
    await expect(panel(page).getByRole('alert')).toContainText('attended control checks')
    await expect(panel(page).getByRole('heading', { name: 'Your saved comparison' })).toBeVisible()
    await expect(panel(page).getByRole('button', { name: 'Stop comparison', exact: true })).toBeEnabled()
    await expect(panel(page).getByRole('button', { name: 'Allow scheduled comparison' })).toHaveCount(0)
    await panel(page).screenshot({ path: testInfo.outputPath('execution-not-ready.png') })
  }
  finally { data.close() }
})

test('lost execution confirmation and cancellation recover without replaying writes', async ({ page }, testInfo) => {
  const data = await fixture(page)
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await review(page)
    await panel(page).getByRole('button', { name: 'Save comparison plan' }).click()
    await panel(page).getByRole('button', { name: 'Review overnight control', exact: true }).click()
    data.lostExecution = '/execution/confirm'
    await panel(page).getByRole('button', { name: 'Allow scheduled comparison' }).click()
    await expect(panel(page).getByRole('alert')).toContainText('uncertain')
    await expect(panel(page).getByRole('region', { name: 'Saved comparison' })).toHaveCount(0)
    await panel(page).getByRole('button', { name: 'Check saved result' }).click()
    await expect(panel(page).getByRole('heading', { name: 'Scheduled to compare' })).toBeVisible()
    expect(data.writes.filter(path => path.endsWith('/execution/confirm'))).toHaveLength(1)
    data.lostExecution = '/execution/cancel'
    await panel(page).getByRole('button', { name: 'Stop comparison', exact: true }).click()
    await expect(panel(page).getByRole('alert')).toContainText('cancellation is not yet confirmed')
    await panel(page).screenshot({ path: testInfo.outputPath('execution-partial-stop.png') })
    await panel(page).getByRole('button', { name: 'Check saved result' }).click()
    await expect(panel(page).getByRole('heading', { name: 'Comparison stopped', exact: true })).toBeVisible()
    await expect(panel(page).getByRole('heading', { name: 'Overnight control ended' })).toBeVisible()
    expect(data.writes.filter(path => path.endsWith('/execution/cancel'))).toHaveLength(1)
  }
  finally { data.close() }
})

test('an uncertain firmware command is checked explicitly without claiming physical delivery', async ({ page }, testInfo) => {
  const data = await fixture(page)
  try {
    await review(page)
    await panel(page).getByRole('button', { name: 'Save comparison plan' }).click()
    await panel(page).getByRole('button', { name: 'Review overnight control', exact: true }).click()
    await panel(page).getByRole('button', { name: 'Allow scheduled comparison' }).click()
    await expect(panel(page).getByRole('heading', { name: 'Scheduled to compare' })).toBeVisible()
    await data.unknownAttempt()
    await panel(page).getByRole('button', { name: 'Refresh comparisons' }).click()
    await panel(page).getByRole('button', { name: /^Open comparison starting/ }).click()
    await expect(panel(page).getByRole('heading', { name: 'Left command needs checking' })).toBeVisible()
    await panel(page).getByRole('button', { name: 'Check Left target and end control' }).click()
    await expect(panel(page)).toContainText('No temperature command was replayed')
    await panel(page).getByText('Latest control receipts', { exact: true }).click()
    await expect(panel(page)).toContainText('Later firmware target: 70°F')
    await expect(panel(page)).toContainText('The original outcome remains unconfirmed')
    await panel(page).screenshot({ path: testInfo.outputPath('execution-recovered.png') })
    expect(data.writes.filter(path => path.endsWith('/execution/recover'))).toHaveLength(1)
  }
  finally { data.close() }
})

test('partial Stop keeps cancellation available after the plan is already closed', async ({ page }, testInfo) => {
  const data = await fixture(page)
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await review(page)
    await panel(page).getByRole('button', { name: 'Save comparison plan' }).click()
    await panel(page).getByRole('button', { name: 'Review overnight control', exact: true }).click()
    await panel(page).getByRole('button', { name: 'Allow scheduled comparison' }).click()
    data.lostExecution = '/stop'
    await panel(page).getByRole('button', { name: 'Stop comparison', exact: true }).click()
    await panel(page).getByRole('button', { name: 'Check saved result' }).click()
    await expect(panel(page).getByRole('heading', { name: 'Finish stopping this comparison' })).toBeVisible()
    await expect(panel(page)).toContainText('cancellation of its retained control permission is not yet confirmed')
    await expect(panel(page).getByRole('heading', { name: 'Scheduled to compare' })).toHaveCount(0)
    await panel(page).screenshot({ path: testInfo.outputPath('execution-plan-closed.png') })
    data.lostExecution = ''
    await panel(page).getByRole('button', { name: 'Finish stopping control' }).click()
    await expect(panel(page).getByRole('heading', { name: 'Comparison stopped', exact: true })).toBeVisible()
    await expect(panel(page).getByRole('heading', { name: 'Overnight control ended' })).toBeVisible()
    expect(data.writes.filter(path => path.endsWith('/execution/cancel'))).toHaveLength(1)
  }
  finally { data.close() }
})

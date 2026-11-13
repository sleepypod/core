import { expect, test, type Page } from '@playwright/test'
import { mockPersonal } from './personal-fixture'
import { temporaryReviewFixture } from '../../src/household/web/tests/temporaryFixture'
import { approveTemporaryReviewSchema, cancelTemporaryReviewSchema, temporaryProposalSchema, type TemporaryReview } from '../../src/household/temporary/contract'
import { householdSessionSchema } from '../../src/household/contract'
import controls from '../../src/household/fixtures/personal-controls-v1.json' with { type: 'json' }

async function mockTemporary(page: Page, assigned = false) {
  const personal = await mockPersonal(page)
  Object.assign(personal.session.capabilities, { temporaryArrangementReview: true })
  if (assigned) {
    personal.session.arrangement.mode = 'assigned'
    personal.session.self.assignment = 'right'
    personal.session.self.zones = ['right']
    await page.route('**/api/v1/me/bed', route => route.fulfill({ json: { ...controls.assignedBed,
      scope: { ...controls.assignedBed.scope, ...controls.soloBed.scope, sleeperId: personal.session.selfSleeperId },
      zones: controls.assignedBed.zones.map(zone => ({ ...zone, side: 'right' })),
      routing: { temperature: ['right'], power: ['right'], vibrationCancellation: ['right'], scheduledVibration: ['right'], routines: 'right' },
      observation: { ...controls.assignedBed.observation, observedAt: Date.now() } } }))
  }
  const fixture = { ...personal, review: null as TemporaryReview | null, loseReply: false, failRead: false, requests: [] as unknown[] }
  await page.route('**/api/v1/household/temporary-arrangement**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    expect(request.headers()['x-sleepypod-sleeper-id']).toBe(personal.session.selfSleeperId)
    expect(request.headers().authorization).toBeUndefined()
    if (request.method() === 'POST') {
      const body = request.postDataJSON()
      fixture.requests.push({ path, body })
      if (path.endsWith('/approve')) {
        approveTemporaryReviewSchema.parse(body)
        if (fixture.review) Object.assign(fixture.review, { self: { ...fixture.review.self, approved: true }, canApprove: false, state: 'approved_for_separate_activation' })
      }
      else if (path.endsWith('/cancel')) {
        cancelTemporaryReviewSchema.parse(body)
        if (fixture.review) Object.assign(fixture.review, { canApprove: false, canCancel: false, state: 'cancelled' })
      }
      else {
        const input = temporaryProposalSchema.parse(body)
        fixture.review = temporaryReviewFixture(householdSessionSchema.parse(personal.session), input.requestId, Date.now(), input.kind, input.kind === 'guest' ? input.residentSide : 'left')
        fixture.review.intendedEnd = input.endsAt
        if (assigned) {
          fixture.review.self.assignmentAtReview = 'right'
          fixture.review.others = [{ displayName: 'Example partner', proposedSide: input.kind === 'side_swap' ? 'right' : null, approved: false, approvalRequired: true }]
        }
      }
      if (fixture.loseReply) return route.abort('failed')
      return route.fulfill({ json: fixture.review })
    }
    if (fixture.failRead) return route.fulfill({ status: 503, json: {} })
    if (path === '/api/v1/household/temporary-arrangement') return route.fulfill({ json: { version: 1, review: fixture.review } })
    return route.fulfill({ status: fixture.review ? 200 : 404, json: fixture.review ?? {} })
  })
  return fixture
}
const panel = (page: Page) => page.getByRole('article', { name: 'Plan a temporary change' })
async function open(page: Page) {
  await page.goto('/household/index.html')
  await panel(page).getByRole('button', { name: 'Check temporary plans' }).click()
  await expect(panel(page)).toContainText('No temporary review is saved')
  await panel(page).scrollIntoViewIfNeeded()
}
async function prepare(page: Page) {
  await panel(page).getByLabel('I understand that a guest interval would withhold personal recordings for everyone.').check()
  await panel(page).getByRole('button', { name: 'Prepare review', exact: true }).click()
}
async function capture(page: Page, name: string) {
  await panel(page).screenshot({ path: test.info().outputPath(`${name}.png`) })
  await page.screenshot({ path: test.info().outputPath(`${name}-context.png`) })
}

test('private guest review works across desktop, phone and large-text tablet without activation', async ({ page }) => {
  const fixture = await mockTemporary(page), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await open(page)
  await expect(panel(page).getByRole('button', { name: 'Prepare review', exact: true })).toBeDisabled()
  await expect(panel(page).getByRole('option', { name: 'Swap our sides' })).toHaveCount(0)
  await capture(page, 'temporary-desktop-empty')
  await prepare(page)
  await expect(panel(page)).toContainText('Waiting for independent approvals')
  await expect(panel(page)).toContainText('Review only.')
  await expect(panel(page)).toContainText('Personal recording withheld')
  await capture(page, 'temporary-desktop-review')
  await panel(page).getByText('Review your nights and wake alarms', { exact: true }).click()
  await panel(page).getByText('Sunday night', { exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await capture(page, 'temporary-phone-week')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  const approval = panel(page).getByRole('group', { name: 'Your independent approval' })
  for (const checkbox of await approval.getByRole('checkbox').all()) await checkbox.check()
  await approval.getByRole('button', { name: 'Save my approval' }).click()
  await expect(panel(page)).toContainText('Approvals saved · bed unchanged')
  await capture(page, 'temporary-phone-approved')
  await page.addStyleTag({ content: ':root { font-size:24px }' })
  await capture(page, 'temporary-phone-large')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 1024, height: 1100 })
  await page.emulateMedia({ colorScheme: 'light' })
  await capture(page, 'temporary-tablet-large')
  await panel(page).getByRole('button', { name: 'Cancel temporary review' }).click()
  await expect(panel(page)).toContainText('Review cancelled · bed unchanged')
  expect(fixture.requests).toHaveLength(3)
  expect(fixture.posts).toHaveLength(0)
  expect(errors).toEqual([])
})

test('a lost response is reconciled with a read and cannot send the proposal again', async ({ page }) => {
  const fixture = await mockTemporary(page)
  fixture.loseReply = true
  await open(page)
  await prepare(page)
  await expect(panel(page).getByRole('alert')).toContainText('not confirmed')
  await expect(panel(page).getByRole('button', { name: 'Prepare review', exact: true })).toHaveCount(0)
  await capture(page, 'temporary-uncertain')
  await panel(page).getByRole('button', { name: 'Check saved review result' }).click()
  await expect(panel(page)).toContainText('Your private review is saved')
  expect(fixture.requests).toHaveLength(1)
})

test('unavailable or changed source never offers approval, while a stale saved review can be cancelled', async ({ page }) => {
  const fixture = await mockTemporary(page)
  await open(page)
  await prepare(page)
  fixture.failRead = true
  await panel(page).getByRole('button', { name: 'Check temporary plans' }).click()
  await expect(panel(page).getByRole('alert')).toContainText('unavailable')
  await expect(panel(page).getByRole('button', { name: 'Save my approval' })).toBeDisabled()
  await capture(page, 'temporary-unavailable')
  fixture.failRead = false
  if (!fixture.review) throw new Error('Missing fixture')
  Object.assign(fixture.review, { state: 'stale', canApprove: false })
  await panel(page).getByRole('button', { name: 'Check temporary plans' }).click()
  await expect(panel(page)).toContainText('Settings changed')
  await expect(panel(page).getByRole('button', { name: 'Cancel temporary review' })).toBeEnabled()
  await capture(page, 'temporary-stale')
  await panel(page).getByRole('button', { name: 'Cancel temporary review' }).click()
  await expect(panel(page)).toContainText('Review cancelled · bed unchanged')
  expect(fixture.requests).toHaveLength(2)
})

test('keyboard review approval is explicit and expired plans offer no approval', async ({ page }) => {
  const fixture = await mockTemporary(page)
  await open(page)
  await panel(page).getByLabel('I understand that a guest interval would withhold personal recordings for everyone.').focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('Tab')
  await expect(panel(page).getByRole('button', { name: 'Prepare review', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(panel(page)).toContainText('Waiting for independent approvals')
  if (!fixture.review) throw new Error('Missing fixture')
  Object.assign(fixture.review, { state: 'expired', canApprove: false, reviewExpiresAt: Date.now() - 1 })
  await panel(page).getByRole('button', { name: 'Check temporary plans' }).click()
  await expect(panel(page).getByRole('button', { name: 'Save my approval' })).toHaveCount(0)
  await capture(page, 'temporary-expired')
  expect(fixture.requests).toHaveLength(1)
})

test('assigned sleepers can prepare a side swap while seeing only their own routine', async ({ page }) => {
  const fixture = await mockTemporary(page, true)
  await open(page)
  await panel(page).getByRole('combobox', { name: 'Change to review', exact: true }).selectOption('side_swap')
  await expect(panel(page).getByRole('button', { name: 'Prepare review', exact: true })).toBeEnabled()
  await panel(page).getByRole('button', { name: 'Prepare review', exact: true }).click()
  await expect(panel(page)).toContainText('Example partner')
  await expect(panel(page)).not.toContainText('Personal recording withheld')
  await expect(panel(page)).toContainText('new recordings would follow the reviewed side assignments')
  await expect(panel(page).getByRole('button', { name: 'Save my approval' })).toBeDisabled()
  expect(fixture.requests).toHaveLength(1)
  expect(fixture.posts).toHaveLength(0)
})

test('stale freshness preserves draft choices and gives approval an adjacent read-only refresh', async ({ page }) => {
  const fixture = await mockTemporary(page)
  await page.clock.install()
  await open(page)
  await panel(page).getByRole('combobox', { name: 'My proposed side', exact: true }).selectOption('left')
  await page.clock.runFor(31_000)
  await expect(panel(page).getByRole('combobox', { name: 'My proposed side', exact: true })).toHaveValue('left')
  await expect(panel(page).getByRole('button', { name: 'Prepare review', exact: true })).toBeDisabled()
  await panel(page).getByRole('button', { name: 'Refresh before preparing' }).click()
  await prepare(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.clock.runFor(31_000)
  const refresh = panel(page).getByRole('button', { name: 'Refresh before deciding' })
  await refresh.focus()
  await capture(page, 'temporary-phone-refresh')
  await page.keyboard.press('Enter')
  await expect(panel(page).getByRole('group', { name: 'Your independent approval' }).getByRole('checkbox').first()).toBeEnabled()
  await expect(panel(page).getByRole('button', { name: 'Save my approval' })).toBeDisabled()
  expect(fixture.requests).toHaveLength(1)
})

import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { mockPersonal } from './personal-fixture'
import { quietWriteSchema } from '../../src/household/quietContract'

async function mockQuiet(page: Page) {
  const personal = await mockPersonal(page)
  Object.assign(personal.session.capabilities, { householdQuiet: true })
  const fixture = { ...personal, until: null as number | null, revision: null as string | null,
    otherUntil: null as number | null, failRead: false, loseReply: false, requests: [] as unknown[],
    receipts: new Map<string, unknown>() }
  const envelope = () => ({ version: 1, generatedAt: Date.now(), scope: {
    podId: personal.session.podId, householdId: personal.session.householdId, accountId: personal.session.accountId,
    sleeperId: personal.session.selfSleeperId, sessionRevision: personal.session.sessionRevision,
    assignmentRevision: personal.session.assignmentRevision, householdRevision: personal.session.householdRevision } })
  await page.route('**/api/v1/me/quiet**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    expect(request.headers()['x-sleepypod-sleeper-id']).toBe(personal.session.selfSleeperId)
    expect(request.headers().authorization).toBeUndefined()
    if (request.method() === 'POST') {
      const input = quietWriteSchema.parse(request.postDataJSON())
      fixture.requests.push(input)
      if (input.expectedRevision !== fixture.revision) return route.fulfill({ status: 409, json: {} })
      fixture.revision = randomUUID()
      fixture.until = input.until
      const receipt = { requestId: input.requestId, revision: fixture.revision, savedAt: Date.now(), until: input.until }
      fixture.receipts.set(input.requestId, receipt)
      if (fixture.loseReply) return route.abort('failed')
      return route.fulfill({ json: { ...envelope(), receipt } })
    }
    if (fixture.failRead) return route.fulfill({ status: 503, json: {} })
    if (path.includes('/requests/')) return route.fulfill({ json: { ...envelope(), receipt: fixture.receipts.get(path.split('/').at(-1) ?? '') ?? null } })
    const until = fixture.until !== null && fixture.until > Date.now() ? fixture.until : null
    const ends = [until, fixture.otherUntil].filter((value): value is number => value !== null && value > Date.now())
    return route.fulfill({ json: { ...envelope(), mine: { revision: fixture.revision, until },
      shared: { paused: ends.length > 0, until: ends.length ? Math.max(...ends) : null } } })
  })
  return fixture
}
const panel = (page: Page) => page.getByRole('article', { name: 'Someone is resting' })
async function open(page: Page) {
  await page.goto('/household/index.html')
  await expect(panel(page).getByRole('button', { name: 'Start quiet time', exact: true })).toBeEnabled()
  await panel(page).scrollIntoViewIfNeeded()
}
async function capture(page: Page, name: string) {
  await panel(page).screenshot({ path: test.info().outputPath(`${name}.png`) })
}

test('quiet time preserves partner requests across desktop, phone and large-text tablet controls', async ({ page }) => {
  const fixture = await mockQuiet(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await open(page)
  await capture(page, 'quiet-desktop-idle')
  await page.screenshot({ path: test.info().outputPath('quiet-desktop-context.png') })
  await page.screenshot({ path: test.info().outputPath('quiet-desktop-workspace.png'), fullPage: true })
  await panel(page).getByLabel('Keep shared actions quiet for').selectOption('60')
  await panel(page).getByRole('button', { name: 'Start quiet time', exact: true }).click()
  await expect(panel(page).getByRole('status')).toContainText('saved on the Pod')
  await expect(panel(page)).toContainText('Quiet time active')
  fixture.otherUntil = Date.now() + 7_200_000
  await panel(page).getByRole('button', { name: 'Refresh quiet status' }).click()
  await expect(panel(page).getByRole('button', { name: 'End my quiet request' })).toBeEnabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await capture(page, 'quiet-phone-active')
  await page.screenshot({ path: test.info().outputPath('quiet-phone-context.png') })
  await panel(page).getByRole('button', { name: 'End my quiet request' }).click()
  await expect(panel(page).getByRole('status')).toContainText('Any other person’s request stays in effect')
  await expect(panel(page)).toContainText('Quiet time active')
  await expect(panel(page)).toContainText('You have no active quiet request')
  await expect(panel(page).getByRole('button', { name: 'End my quiet request' })).toHaveCount(0)
  await panel(page).getByText('What quiet time pauses', { exact: true }).click()
  await capture(page, 'quiet-phone-partner')
  await page.addStyleTag({ content: ':root{font-size:24px}' })
  await capture(page, 'quiet-phone-large')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 1024, height: 1100 })
  await page.emulateMedia({ colorScheme: 'light' })
  await capture(page, 'quiet-tablet-large')
  expect(fixture.requests).toHaveLength(2)
  expect(fixture.posts).toHaveLength(0)
  expect(errors).toEqual([])
})

test('lost replies stay visible through polling and reconcile without another write', async ({ page }) => {
  const fixture = await mockQuiet(page)
  fixture.loseReply = true
  await open(page)
  await panel(page).getByRole('button', { name: 'Start quiet time', exact: true }).click()
  await expect(panel(page).getByRole('alert')).toContainText('not confirmed')
  await panel(page).getByRole('button', { name: 'Refresh quiet status' }).click()
  await expect(panel(page).getByRole('alert')).toContainText('not confirmed')
  await expect(panel(page).getByRole('button', { name: 'Update my quiet time' })).toBeDisabled()
  await capture(page, 'quiet-uncertain')
  await panel(page).getByRole('button', { name: 'Check saved quiet result' }).click()
  await expect(panel(page).getByRole('status')).toContainText('saved on the Pod')
  expect(fixture.requests).toHaveLength(1)
})

test('unavailable state never looks unpaused and refreshing cannot write', async ({ page }) => {
  const fixture = await mockQuiet(page)
  fixture.otherUntil = Date.now() + 7_200_000
  await open(page)
  fixture.failRead = true
  await panel(page).getByRole('button', { name: 'Refresh quiet status' }).click()
  await expect(panel(page)).toContainText('Quiet status unavailable')
  await expect(panel(page)).not.toContainText('No quiet requests active')
  await expect(panel(page).getByRole('button', { name: 'Start quiet time', exact: true })).toBeDisabled()
  await capture(page, 'quiet-unavailable')
  fixture.failRead = false
  await panel(page).getByRole('button', { name: 'Refresh quiet status' }).click()
  await expect(panel(page)).toContainText('Quiet time active')
  expect(fixture.requests).toHaveLength(0)
})

test('keyboard users can request and end quiet without a pointer', async ({ page }) => {
  const fixture = await mockQuiet(page)
  await open(page)
  await panel(page).getByLabel('Keep shared actions quiet for').focus()
  await page.keyboard.press('Tab')
  await expect(panel(page).getByRole('button', { name: 'Start quiet time', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(panel(page).getByRole('button', { name: 'End my quiet request' })).toBeEnabled()
  await panel(page).getByRole('button', { name: 'End my quiet request' }).focus()
  await capture(page, 'quiet-keyboard')
  await page.keyboard.press('Enter')
  await expect(panel(page)).toContainText('No quiet requests active')
  expect(fixture.requests).toHaveLength(2)
})

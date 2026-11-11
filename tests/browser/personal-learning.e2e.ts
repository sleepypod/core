import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { householdSessionSchema } from '../../src/household/contract'
import { learningFixture } from '../../src/household/web/tests/learningFixture'
import { mockPersonal } from './personal-fixture'

async function mockLearning(page: Page) {
  const personal = await mockPersonal(page)
  Object.assign(personal.session.capabilities, { personalLearningArchive: true })
  const examples = learningFixture(householdSessionSchema.parse(personal.session))
  const fixture = { ...personal, examples, status: 200, beforeReply: async () => {} }
  await page.route('**/api/v1/me/learning/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    expect(request.method()).toBe('GET')
    expect(request.headers()['x-sleepypod-sleeper-id']).toBe(personal.session.selfSleeperId)
    expect(request.headers().authorization).toBeUndefined()
    await fixture.beforeReply()
    await route.fulfill({ status: fixture.status, json: path.endsWith('/archives')
      ? examples.archives
      : path.endsWith('/records') ? examples.records : examples.detail })
  })
  return fixture
}
const panel = (page: Page) => page.locator('article[aria-label="Your saved learning"]')
async function openLibrary(page: Page) {
  await page.goto('/household/index.html')
  await panel(page).getByRole('button', { name: 'Open my library' }).click()
  await panel(page).getByRole('button', { name: 'Browse saved records' }).click()
  await panel(page).getByRole('button', { name: /^Read Journal entry/ }).click()
  await expect(panel(page).getByRole('region', { name: 'Selected saved record' })).toContainText('Felt comfortable after an earlier bedtime.')
}

test('saved learning shows readable notes and downloads their exact original source, on phone and tablet', async ({ page }) => {
  const fixture = await mockLearning(page), errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openLibrary(page)
  const reading = panel(page).getByRole('region', { name: 'Selected saved record' })
  await expect(reading).toContainText('Felt comfortable after an earlier bedtime.')
  await expect(reading).toContainText('4 of 5')
  await expect(reading).toContainText('Comfortable')
  await expect(reading).not.toContainText('"local_date"')
  await expect(reading).toBeFocused()
  await page.setViewportSize({ width: 1024, height: 1100 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: test.info().outputPath('library-tablet-full-light.png'), fullPage: true })
  await panel(page).screenshot({ path: test.info().outputPath('library-tablet-light.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addStyleTag({ content: ':root{font-size:24px}' })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: test.info().outputPath('library-phone-context-dark.png') })
  await panel(page).screenshot({ path: test.info().outputPath('library-phone-dark-large.png') })
  await reading.getByText('Source and original file', { exact: true }).click()
  await expect(reading).toContainText('Saved from Left.')
  await panel(page).screenshot({ path: test.info().outputPath('library-phone-source-dark-large.png') })
  const downloading = page.waitForEvent('download')
  await reading.getByRole('button', { name: 'Download original record' }).click()
  const downloaded = await downloading
  const location = await downloaded.path()
  expect(location).not.toBeNull()
  expect(await readFile(location ?? '', 'utf8')).toBe(fixture.examples.detail.payload)
  await reading.getByRole('button', { name: 'Close record' }).click()
  await expect(panel(page).getByRole('button', { name: /^Read Journal entry/ })).toBeFocused()
  expect(fixture.posts).toEqual([])
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
})

test('an empty or unavailable library explains its scope and failed reads withdraw old notes', async ({ page }) => {
  const fixture = await mockLearning(page)
  await openLibrary(page)
  fixture.status = 503
  await panel(page).getByRole('button', { name: 'Reload library' }).click()
  await expect(panel(page).getByRole('alert')).toContainText('Reload')
  await expect(panel(page)).not.toContainText('Felt comfortable')
  await panel(page).screenshot({ path: test.info().outputPath('library-error.png') })
  fixture.status = 200
  fixture.examples.archives.archives = []
  await panel(page).getByRole('button', { name: 'Open my library' }).click()
  await expect(panel(page)).toContainText('No preserved library yet')
  await expect(panel(page)).toContainText('does not mean your current sleep recordings are missing')
  await panel(page).screenshot({ path: test.info().outputPath('library-empty.png') })
  Object.assign(fixture.session.capabilities, { personalLearningArchive: false })
  await panel(page).getByRole('button', { name: 'Reload library' }).click()
  await expect(panel(page).getByRole('button', { name: 'Check library availability' })).toBeVisible()
  expect(fixture.posts).toEqual([])
})

test('backgrounding clears notes and a slow library read never disables Stop', async ({ page }) => {
  const fixture = await mockLearning(page)
  await openLibrary(page)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(panel(page)).not.toContainText('Felt comfortable')
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  let finish: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  fixture.beforeReply = () => pending
  await panel(page).getByRole('button', { name: 'Open my library' }).click()
  await expect(panel(page).getByRole('button', { name: 'Reading saved learning…' })).toBeDisabled()
  await page.getByRole('button', { name: 'Stop temperature', exact: true }).click()
  await expect.poll(() => fixture.posts.some(post => post.body.action && (post.body.action as { kind: string }).kind === 'power')).toBe(true)
  await panel(page).getByRole('button', { name: 'Hide library' }).count().then(count => expect(count).toBe(0))
  finish()
  await expect(panel(page).getByRole('button', { name: 'Reload library' })).toBeEnabled()
})

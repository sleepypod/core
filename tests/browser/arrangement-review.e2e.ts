import { test, expect, type Page } from '@playwright/test'
import preparation from '../../src/household/fixtures/preparation-v1.json' with { type: 'json' }
import controls from '../../src/household/fixtures/personal-controls-v1.json' with { type: 'json' }
import examples from '../../src/household/fixtures/arrangement-review-v1.json' with { type: 'json' }

// Display/transport acceptance only; real authenticated service transactions have
// separate SQLite-backed tests. Every API request below is intercepted.
async function arrange(page: Page, role: 'owner' | 'member', loseApproval = false) {
  const session = { ...structuredClone(preparation[`${role}Session`]), capabilities: { ...preparation[`${role}Session`].capabilities,
    personalControls: role === 'owner', arrangementReview: true } }
  const example = structuredClone(examples[`${role}Review`])
  example.createdAt = Date.now() - 1000
  example.expiresAt = Date.now() + 3_600_000
  let saved: typeof example | null = role === 'member' ? example : null
  const posts: Array<{ path: string, body: Record<string, unknown> }> = []
  const unexpected: string[] = []
  let lost = false
  await page.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    const body = request.method() === 'GET' ? undefined : request.postDataJSON()
    const json = (value: unknown) => route.fulfill({ json: value })
    if (path === '/api/v1/household/session') return json(session)
    if (path === '/api/v1/me/preferences') return json({ ...preparation.preferences, sleeperId: session.selfSleeperId, preferences: example.self.preferences })
    if (path === '/api/v1/household/devices') return json(preparation.devices)
    if (path === '/api/v1/household/invitations') return json({ invitations: [] })
    if (path === '/api/v1/me/routines') return json({ ...preparation.routines, sleeperId: session.selfSleeperId })
    if (path === '/api/v1/me/bed') return json({ ...controls.soloBed,
      scope: { ...controls.soloBed.scope, sleeperId: session.selfSleeperId },
      ...(role === 'member' ? { availability: 'unassigned', zones: [], routing: { temperature: [], power: [], vibrationCancellation: [], scheduledVibration: [], routines: null } } : {}),
      observation: { ...controls.soloBed.observation, observedAt: Date.now() } })
    if (path === '/api/v1/household/arrangement' && request.method() === 'GET') return json({ version: 1, review: saved })
    if (request.method() === 'POST') {
      posts.push({ path, body })
      if (path === '/api/v1/household/arrangement') {
        saved = { ...example, reviewId: body.requestId }
        return json(saved)
      }
      if (path === '/api/v1/household/arrangement/approve' && saved) {
        saved = { ...saved, self: { ...saved.self, approved: true }, canApprove: false }
        if (loseApproval && !lost) {
          lost = true
          return route.abort('failed')
        }
        return json(saved)
      }
      if (path === '/api/v1/household/arrangement/cancel' && saved) {
        saved = { ...saved, state: 'cancelled', canApprove: false }
        return json(saved)
      }
    }
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 404, json: {} })
  })
  return { posts, unexpected }
}

test('owner reviews preserved week, approves explicitly and recovers by GET after a lost reply', async ({ page }) => {
  const fixture = await arrange(page, 'owner', true)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/household/index.html')
  const panel = page.locator('article[aria-label="Shared side review"]')
  await panel.getByRole('button', { name: 'Check current side review' }).click()
  await expect(panel.getByLabel('My future side')).toHaveValue('right')
  await expect(panel.getByRole('button', { name: 'Prepare shared side review' })).toBeDisabled()
  await panel.getByLabel('Keep my current operating week', { exact: false }).check()
  await panel.getByRole('button', { name: 'Prepare shared side review' }).click()
  await expect(panel.getByLabel('Proposed sides only')).toContainText('Example owner')
  await panel.getByText('Sunday night', { exact: true }).click()
  await expect(panel.getByLabel('Your proposed full week')).toContainText('105°F')
  const approve = panel.getByRole('button', { name: 'Approve my side and routine' })
  await panel.getByLabel('Right is my intended side.').check()
  await panel.getByLabel('I reviewed my temperatures, nights and wake alarms.').check()
  await expect(approve).toBeDisabled()
  await panel.getByLabel('I understand that switching the bed needs a separate activation.').check()
  await approve.click()
  await expect.poll(() => fixture.posts.length).toBe(2)
  await expect(page.getByRole('alert')).toContainText('response could not be confirmed')
  await expect(panel.getByRole('button', { name: 'Cancel side review' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Stop temperature', exact: true })).toBeEnabled()
  expect(fixture.posts).toHaveLength(2)
  await page.reload()
  await panel.getByRole('button', { name: 'Check current side review' }).click()
  await expect(panel.getByLabel('Proposed sides only')).toContainText('Approval saved')
  expect(fixture.posts).toHaveLength(2)
  await panel.getByRole('button', { name: 'Cancel side review' }).click()
  await expect(panel).toContainText('This review was cancelled.')
  expect(fixture.posts.map(value => value.path)).toEqual(['/api/v1/household/arrangement', '/api/v1/household/arrangement/approve', '/api/v1/household/arrangement/cancel'])
  expect(fixture.unexpected).toEqual([])
  expect(errors).toEqual([])
})

test('member sees only their draft with readable phone and tablet side-review layouts', async ({ page }) => {
  const fixture = await arrange(page, 'member')
  await page.goto('/household/index.html')
  const panel = page.locator('article[aria-label="Shared side review"]')
  await panel.getByRole('button', { name: 'Check current side review' }).click()
  await expect(panel).toContainText('Preferred temperature: 78°F')
  await expect(panel).not.toContainText('105°F')
  await expect(panel.getByRole('button', { name: 'Prepare shared side review' })).toHaveCount(0)
  await panel.getByLabel('Left is my intended side.').check()
  await panel.getByLabel('I reviewed my temperatures, nights and wake alarms.').check()
  await panel.getByLabel('I understand that switching the bed needs a separate activation.').check()
  await panel.getByRole('button', { name: 'Approve my side and routine' }).click()
  await expect(panel).toContainText('Switching to two sleepers is not available in this release.')
  for (const size of [{ width: 390, height: 844 }, { width: 1024, height: 1366 }]) {
    await page.setViewportSize(size)
    await page.emulateMedia({ colorScheme: size.width === 390 ? 'dark' : 'light', reducedMotion: 'reduce' })
    await page.addStyleTag({ content: ':root{font-size:24px}' })
    await panel.scrollIntoViewIfNeeded()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width)
    await page.screenshot({ path: test.info().outputPath(`arrangement-${size.width}.png`) })
    await panel.getByLabel('Proposed sides only').screenshot({ path: test.info().outputPath(`proposed-sides-${size.width}.png`) })
  }
  expect(fixture.posts).toHaveLength(1)
  expect(fixture.unexpected).toEqual([])
})

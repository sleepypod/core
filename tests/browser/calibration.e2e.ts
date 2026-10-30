import { expect, test } from './ownerTest'
import Database from 'better-sqlite3'

function revisions() {
  const path = process.env.DATABASE_URL
  if (!path || !process.env.SLEEPYPOD_BROWSER_FIXTURE) throw new Error('Missing isolated browser fixture')
  const db = new Database(path, { readonly: true })
  try {
    return db.prepare('SELECT id, side, overrides, requester FROM biometric_profile_revisions ORDER BY created_at_ms, id').all() as { id: string, side: string, overrides: string, requester: string }[]
  }
  finally { db.close() }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/en/settings?section=biometric-calibration')
  await page.getByRole('navigation', { name: 'Calibration views' }).getByRole('button', { name: 'Profiles', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Review candidate', exact: true })).toBeVisible()
})

test('save a reviewed candidate through the API and reload its persisted revision', async ({ page }) => {
  const before = revisions()
  await page.getByLabel('heart_rate.trackingToleranceBpm', { exact: true }).fill('16')
  await page.getByRole('button', { name: 'Review candidate', exact: true }).click()
  await expect(page.getByText('Schema checks passed.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Save candidate without applying', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Candidate saved:' })).toBeVisible()
  const added = revisions().filter(row => !before.some(previous => previous.id === row.id))
  expect(added).toHaveLength(1)
  expect(added[0]).toMatchObject({ side: 'left', requester: 'web-calibration' })
  expect(JSON.parse(added[0].overrides)).toContainEqual({ path: 'heart_rate.trackingToleranceBpm', value: 16 })
  await page.reload()
  await page.getByRole('navigation', { name: 'Calibration views' }).getByRole('button', { name: 'Profiles', exact: true }).click()
  await expect(page.getByText(added[0].id, { exact: true })).toBeVisible()
})

test('invalid candidate is rejected by the server without saving a revision', async ({ page }) => {
  const before = revisions()
  await page.getByLabel('heart_rate.trackingToleranceBpm', { exact: true }).fill('31')
  const response = page.waitForResponse(response => response.url().includes('biometricTuning.resolveProfile') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Review candidate', exact: true }).click()
  // tRPC's streaming batch transport returns HTTP 200 with per-call errors.
  expect((await response).ok()).toBe(true)
  await expect(page.getByText('Invalid biometric parameter: heart_rate.trackingToleranceBpm', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save candidate without applying', exact: true })).toHaveCount(0)
  expect(revisions()).toEqual(before)
})

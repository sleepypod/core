import { test, expect } from './ownerTest'
import type { Page, TestInfo, Locator } from '@playwright/test'

async function capture(page: Page, target: Locator, name: string, testInfo: TestInfo) {
  await target.evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: testInfo.outputPath(name), animations: 'disabled' })
}

const headers = () => ({ Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` })
const base = { restfulness: 4, comfort: 'warm', caffeine: true, alcohol: false, exercise: true, notes: 'Synthetic context check-in' }

test('detailed journal handles clock folds, drafts, missingness and older client edits', async ({ page, request }, testInfo) => {
  await page.goto('/en/sleep?view=journal')
  await page.getByLabel('Wake date', { exact: true }).fill('2026-11-01')
  await expect(page.getByRole('region', { name: 'Morning check-in' })).toContainText('2026-11-01')
  await expect(page.getByLabel('Caffeine status', { exact: true })).toHaveValue('not_logged')
  await page.getByLabel('Caffeine status', { exact: true }).selectOption('yes')
  await page.getByLabel('Total caffeine (mg)', { exact: true }).fill('120')
  await page.getByLabel('Last caffeine', { exact: true }).fill('2026-10-31T14:00')
  await page.getByText('Bedtime, meal and stress context', { exact: true }).click()
  await page.getByLabel('Reported bedtime', { exact: true }).fill('2026-11-01T01:30')
  await expect(page.getByRole('button', { name: 'Save check-in', exact: true })).toBeDisabled()
  await expect(page.getByRole('region', { name: 'Morning check-in' }).getByRole('alert')).toContainText('occurs twice')
  await capture(page, page.getByLabel('Reported bedtime', { exact: true }), 'journal-clock-choice.png', testInfo)
  await page.getByLabel('Reported bedtime clock occurrence', { exact: true }).selectOption(String(Date.parse('2026-11-01T09:30Z')))
  await page.getByLabel('Last meal', { exact: true }).fill('2026-10-31T21:30')
  await page.getByLabel('Stress compared with your usual day', { exact: true }).selectOption('higher')
  await page.getByLabel('Alcohol status', { exact: true }).selectOption('none')
  await page.getByRole('tab', { name: 'Right side', exact: true }).click()
  await expect(page.getByLabel('Caffeine status', { exact: true })).toHaveValue('not_logged')
  await page.getByRole('tab', { name: 'Left side', exact: true }).click()
  await expect(page.getByLabel('Total caffeine (mg)', { exact: true })).toHaveValue('120')
  await page.getByRole('button', { name: 'Save check-in', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Morning check-in' }).getByRole('status')).toContainText('saved on your Pod')
  const url = '/api/v1/journal?side=left&date=2026-11-01'
  const saved = await (await request.get(url, { headers: headers() })).json()
  expect(saved.contextVersion).toBe(1)
  expect(saved.selected.record.fields.context).toMatchObject({ bedtimeAt: Date.parse('2026-11-01T09:30Z'), caffeine: { amount: 120 }, alcohol: { status: 'none' }, exercise: { status: 'not_logged' }, stress: 'higher' })
  const { context, ...legacy } = saved.selected.record.fields
  expect((await request.post('/api/v1/journal', { headers: headers(), data: { side: 'left', date: '2026-11-01', expectedRevision: saved.selected.revision, fields: { ...legacy, notes: 'An older app edited only notes' } } })).status()).toBe(200)
  expect((await (await request.get(url, { headers: headers() })).json()).selected.record.fields.context).toEqual(context)
  await page.reload()
  await page.getByLabel('Wake date', { exact: true }).fill('2026-11-01')
  await expect(page.getByLabel('Total caffeine (mg)', { exact: true })).toHaveValue('120')
  await page.getByText('Bedtime, meal and stress context', { exact: true }).click()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('journal-context-desktop.png') })
  await capture(page, page.getByText('Bedtime, meal and stress context', { exact: true }), 'journal-context-desktop-details.png', testInfo)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('journal-context-mobile.png') })
  await capture(page, page.getByText('Bedtime, meal and stress context', { exact: true }), 'journal-context-mobile-details.png', testInfo)
  await capture(page, page.getByLabel('Private notes', { exact: true }), 'journal-context-mobile-save.png', testInfo)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByLabel('Caffeine status', { exact: true }).selectOption('none')
  await page.getByRole('button', { name: 'Save check-in', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Morning check-in' }).getByRole('status')).toContainText('saved on your Pod')
  expect((await (await request.get(url, { headers: headers() })).json()).selected.record.fields.context.caffeine).toEqual({ status: 'none', unit: 'milligrams' })
})

test('habit discoveries show independent group counts and descriptive limits', async ({ page, request }, testInfo) => {
  for (let index = 1; index <= 10; index++) {
    const date = `2024-06-${String(index).padStart(2, '0')}`
    const bedtimeAt = Date.parse(`${date}T05:00Z`)
    const near = index <= 5
    const context = { version: 1, bedtimeAt, stress: near ? 'higher' : 'usual',
      caffeine: { status: 'yes', unit: 'milligrams', amount: near ? 200 : 100, lastAt: bedtimeAt - (near ? 2 : 8) * 3600_000 },
      alcohol: { status: 'not_logged', unit: 'usStandardDrinks' },
      exercise: { status: 'yes', unit: 'minutes', lastAt: bedtimeAt - (near ? 1 : 5) * 3600_000 } }
    expect((await request.post('/api/v1/journal', { headers: headers(), data: { side: 'right', date, expectedRevision: null, fields: { ...base, comfort: near ? 'warm' : 'comfortable', context } } })).status()).toBe(200)
  }
  await page.goto('/en/sleep?view=journal')
  await page.getByRole('tab', { name: 'Right side', exact: true }).click()
  await page.getByLabel('Wake date', { exact: true }).fill('2024-06-10')
  const patterns = page.getByRole('region', { name: 'Journal patterns' })
  await expect(patterns).toContainText('Within 3 hours: too warm on 5 of 5 dates.')
  await expect(patterns).toContainText('More than 3 hours before: too warm on 0 of 5 dates.')
  await expect(patterns).toContainText('These findings do not change the bed.')
  await page.getByText('Comparison definitions and counts', { exact: true }).click()
  await capture(page, patterns, 'journal-discoveries-desktop.png', testInfo)
  await page.setViewportSize({ width: 390, height: 844 })
  await capture(page, patterns, 'journal-discoveries-mobile.png', testInfo)
  await capture(page, page.getByText('Comparison definitions and counts', { exact: true }), 'journal-discoveries-mobile-counts.png', testInfo)
  await capture(page, page.getByText(/Exploratory associations in your reported/), 'journal-discoveries-mobile-limits.png', testInfo)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await capture(page, patterns, 'journal-discoveries-dark-mobile.png', testInfo)
})

test('a server without context capability retains the legacy journal form', async ({ page }) => {
  await page.route('**/api/trpc/journal.get**', async (route) => {
    const response = await route.fetch()
    let removed = false
    const stripCapability = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripCapability)
      if (!value || typeof value !== 'object') return value
      const item = { ...value } as Record<string, unknown>
      if (item.apiVersion === 1 && item.selected) {
        delete item.contextVersion
        delete item.contextPatterns
        removed = true
      }
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, stripCapability(nested)]))
    }
    const body = (await response.text()).split('\n').map(line => line ? JSON.stringify(stripCapability(JSON.parse(line))) : line).join('\n')
    expect(removed).toBe(true)
    await route.fulfill({ response, body })
  })
  await page.goto('/en/sleep?view=journal')
  await expect(page.getByLabel(/caffeine.*during the previous day/i)).toBeVisible()
  await expect(page.getByLabel('Caffeine status', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save check-in', exact: true })).toBeEnabled()
})

test('a changed Pod zone requires an explicit draft clock choice', async ({ page, request }, testInfo) => {
  const date = '2025-07-10'
  const entry = `/api/v1/journal?side=left&date=${date}`
  await page.goto('/en/sleep?view=journal')
  await page.getByLabel('Wake date', { exact: true }).fill(date)
  await expect(page.getByRole('region', { name: 'Morning check-in' })).toContainText(date)
  await page.getByLabel('Caffeine status', { exact: true }).selectOption('yes')
  await page.getByLabel('Last caffeine', { exact: true }).fill('2025-07-09T14:00')
  expect((await request.patch('/api/settings/device', { headers: headers(), data: { timezone: 'America/New_York' } })).status()).toBe(200)
  try {
    // A settings change must be caught even before this browser has refreshed.
    await page.getByRole('button', { name: 'Save check-in', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Morning check-in' }).getByRole('status')).toContainText('Save not confirmed')
    expect((await (await request.get(entry, { headers: headers() })).json()).selected.record).toBeNull()
    await page.getByRole('button', { name: 'Refresh saved entry', exact: true }).click()
    const conflict = page.getByRole('alert').filter({ hasText: 'The entry’s time zone changed' })
    await expect(conflict).toContainText('Your draft still uses America/Los_Angeles')
    await expect(page.getByLabel('Last caffeine', { exact: true })).toHaveValue('2025-07-09T14:00')
    await expect(page.getByRole('button', { name: 'Save check-in', exact: true })).toBeDisabled()
    await capture(page, conflict, 'journal-zone-conflict-desktop.png', testInfo)
    await page.setViewportSize({ width: 390, height: 844 })
    await capture(page, conflict, 'journal-zone-conflict-mobile.png', testInfo)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: 'Keep draft in new time zone', exact: true }).click()
    await expect(page.getByLabel('Last caffeine', { exact: true })).toHaveValue('2025-07-09T14:00')
    await page.getByRole('button', { name: 'Save check-in', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Morning check-in' }).getByRole('status')).toContainText('saved on your Pod')
    const saved = (await (await request.get(entry, { headers: headers() })).json()).selected.record
    expect(saved.timeZone).toBe('America/New_York')
    expect(saved.fields.context.caffeine.lastAt).toBe(Date.parse('2025-07-09T18:00Z'))
  }
  finally {
    expect((await request.patch('/api/settings/device', { headers: headers(), data: { timezone: 'America/Los_Angeles' } })).status()).toBe(200)
  }
})

test('equal observed warm rates use neutral comparison language', async ({ page, request }, testInfo) => {
  for (let index = 1; index <= 10; index++) {
    const date = `2024-06-${String(index).padStart(2, '0')}`
    const context = { version: 1, stress: index <= 5 ? 'higher' : 'usual',
      caffeine: { status: 'not_logged', unit: 'milligrams' },
      alcohol: { status: 'not_logged', unit: 'usStandardDrinks' },
      exercise: { status: 'not_logged', unit: 'minutes' } }
    expect((await request.post('/api/v1/journal', { headers: headers(), data: { side: 'left', date, expectedRevision: null,
      fields: { ...base, caffeine: false, exercise: false, comfort: 'comfortable', context } } })).status()).toBe(200)
  }
  await page.goto('/en/sleep?view=journal')
  await page.getByLabel('Wake date', { exact: true }).fill('2024-06-10')
  const patterns = page.getByRole('region', { name: 'Journal patterns' })
  await expect(patterns).toContainText('No difference at this precision (0 percentage points)')
  await expect(patterns).not.toContainText('0 percentage points higher')
  await page.setViewportSize({ width: 390, height: 844 })
  await capture(page, patterns, 'journal-equal-rates-mobile.png', testInfo)
})

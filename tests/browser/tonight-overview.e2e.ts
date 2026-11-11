import { test, expect } from './ownerTest'

test.use({ serviceWorkers: 'block' })
for (const width of [390, 1440]) {
  test(`Tonight keeps the plan and bed accessible in both layouts at ${width}`, async ({ page }, testInfo) => {
    const mutations: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST') mutations.push(request.url())
    })
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/en')
    await expect(page.getByRole('heading', { name: 'Tonight', exact: true })).toBeVisible()
    const overview = page.getByRole('region', { name: 'Tonight overview' })
    await expect(overview.getByText('Personal Autopilot', { exact: true })).toBeVisible()
    await expect(overview.getByText('No alarm scheduled')).toBeVisible()
    await expect(page.getByTestId('stage-loading')).toBeHidden({ timeout: 30000 })
    const stage = page.getByTestId('temp-stage')
    await expect(stage).toBeVisible()
    await stage.scrollIntoViewIfNeeded()
    await stage.screenshot({ path: testInfo.outputPath(`tonight-stage-${width}.png`) })
    await overview.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`tonight-${width}.png`) })
    await page.getByRole('button', { name: 'Cards', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Tonight overview' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'All off', exact: true })).toBeVisible()
    await expect(page.getByText('Comfort limits and recording checks', { exact: true })).toBeAttached()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`tonight-cards-${width}.png`), fullPage: true })
    expect(mutations).toEqual([])
  })
}

test('Tonight withdraws an unavailable plan instead of retaining an apparent active mode', async ({ page }) => {
  await page.goto('/en')
  const overview = page.getByRole('region', { name: 'Tonight overview' })
  await expect(overview.getByText('No alarm scheduled')).toBeVisible()
  await page.route('**/api/trpc/**', route => /comfort.get|nextAlarm.get|comfortLimit.get/.test(route.request().url()) ? route.abort() : route.continue())
  await overview.getByRole('button', { name: 'Refresh tonight’s plan' }).click()
  await expect(overview.getByTestId('tonight-comfort-mode')).toHaveText('Not checked')
  await expect(overview.getByText('No alarm scheduled')).toHaveCount(0)
})

test('a wake-plan deep link opens its named side and allows a later side change', async ({ page }) => {
  await page.goto('/en/schedule?side=right')
  const side = page.getByRole('tablist', { name: 'Side', exact: true })
  await expect(side.getByRole('tab', { name: 'Right', exact: true })).toHaveAttribute('aria-selected', 'true')
  await side.getByRole('tab', { name: 'Left', exact: true }).click()
  await expect(side.getByRole('tab', { name: 'Left', exact: true })).toHaveAttribute('aria-selected', 'true')
})

import { test, expect } from './ownerTest'

test.use({ serviceWorkers: 'block' })
for (const width of [390, 1440]) {
  test(`learning distinguishes three purposes and preserves selected side at ${width}px`, async ({ page }, testInfo) => {
    const mutations: string[] = []
    page.on('request', (request) => {
      if (/trainThermalModel|setModelActive|selectModel|comfort\.configure|comfort\.mode/.test(request.url())) mutations.push(request.url())
    })
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/en/autopilot?view=learning&side=right')
    const journey = page.getByRole('region', { name: 'Learning journey' })
    await expect(journey.getByRole('article')).toHaveCount(3)
    await expect(journey.getByText('Private on your iPhone', { exact: true })).toBeVisible()
    await expect(journey.getByRole('progressbar')).toBeVisible()
    await expect(journey.getByRole('tab', { name: 'Right' })).toHaveAttribute('aria-selected', 'true')
    for (const card of await journey.getByRole('article').all()) {
      const bounds = await card.boundingBox()
      expect(bounds?.x).toBeGreaterThanOrEqual(0)
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width)
    }
    await journey.screenshot({ path: testInfo.outputPath(`learning-${width}.png`) })
    await journey.getByRole('button', { name: 'Review temperature learning' }).click()
    await expect(page).toHaveURL(/side=right#personal-comfort$/)
    await expect(page.getByRole('tablist', { name: 'Personal comfort side' }).getByRole('tab', { name: 'Right' }))
      .toHaveAttribute('aria-selected', 'true')
    expect(mutations).toEqual([])
  })
}

test('a failed refresh withdraws previously available learning progress', async ({ page }) => {
  await page.goto('/en/autopilot?view=learning')
  const journey = page.getByRole('region', { name: 'Learning journey' })
  await expect(journey.getByRole('progressbar')).toBeVisible()
  await page.route('**/api/trpc/**', route => route.request().url().includes('comfort.thermalModel') ? route.abort() : route.continue())
  await journey.getByRole('button', { name: 'Refresh model checks' }).click()
  await expect(journey.getByRole('article', { name: 'Temperature learning' }).getByText('Needs a current read')).toBeVisible()
  await expect(journey.getByRole('progressbar')).toHaveCount(0)
  await expect(journey.getByRole('button', { name: 'Refresh model checks' })).toBeEnabled()
})

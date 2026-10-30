import { writeFile } from 'node:fs/promises'
import { expect, test } from './ownerTest'

test('SleepyPod phone navigation reaches secondary controls and owner sign-out', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'WebGLRenderingContext', { value: undefined })
  })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/en/schedule')
  const navigation = page.getByRole('navigation', { name: 'Main', exact: true })
  await expect(navigation.getByRole('link', { name: 'Schedule', exact: true })).toBeVisible()
  await expect(navigation.getByRole('link', { name: 'Autopilot', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('desktop-schedule.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  const tabs = page.locator('nav[aria-label="Main"]:visible')
  await expect(tabs.getByRole('link')).toHaveText(['Temp', 'Schedule', 'Sleep'])
  await expect(tabs.getByRole('link', { name: 'Schedule', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('link', { name: /^Settings/ }).filter({ visible: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  for (const name of ['Autopilot', 'Home', 'System']) await expect(page.getByRole('main').getByRole('link', { name, exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: test.info().outputPath('phone-settings-light.png'), fullPage: true })

  await page.getByRole('main').getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Bedroom', exact: true })).toBeVisible()
  await page.getByText('Existing single-source MQTT mappings', { exact: true }).click()
  await expect(page.getByText('Sensor mapping and setup', { exact: true })).toBeVisible()
  await expect(page.getByText('MQTT not connected', { exact: true })).toBeVisible()
  await page.goto('/en/more')
  await expect(page).toHaveURL(/\/en\/settings$/)

  await tabs.getByRole('link', { name: 'Temp', exact: true }).click()
  const stage = page.getByTestId('temp-stage')
  await expect(stage).toBeVisible()
  await expect(page.getByTestId('stage-fallback').locator(':scope > .text-fg')).toHaveCSS('color', 'rgb(17, 17, 19)')
  await expect(stage.getByRole('link', { name: 'Settings', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('phone-temp-stage.png') })
  await stage.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: test.info().outputPath('phone-settings-dark.png'), fullPage: true })
  await page.getByRole('button', { name: 'Browser connection', exact: true }).click()
  await page.getByRole('button', { name: 'Disconnect this browser', exact: true }).click()
  await expect(page.getByLabel('Connection key', { exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toHaveCount(0)
})

// Fixed times cover both plot edges regardless of the runner's timezone.
test.describe('enlarged text near timeline edges', () => {
  test.use({ timezoneId: 'UTC' })
  for (const clockTime of ['08:55', '18:05']) {
    for (const viewportWidth of [320, 305]) {
      test(`SleepyPod tabs remain usable at enlarged text on a ${viewportWidth}px phone at ${clockTime}`, async ({ page }) => {
        await page.addInitScript(() => {
          Object.defineProperty(window, 'WebGLRenderingContext', { value: undefined })
        })
        await page.setViewportSize({ width: viewportWidth, height: 680 })
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
        await page.clock.setFixedTime(new Date(`2026-10-26T${clockTime}:00Z`))
        await page.goto('/en/settings')
        await page.addStyleTag({ content: 'html { font-size: 200%; } [data-testid="temp-stage"] { scrollbar-gutter: stable; }' })
        const navigation = page.locator('nav[aria-label="Main"]:visible')
        await expect(navigation.getByRole('link')).toHaveText(['Temp', 'Schedule', 'Sleep'])
        await expect(navigation).toHaveCSS('font-size', '22px')
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth)
        for (const name of ['Temp', 'Schedule', 'Sleep']) {
          const bounds = await navigation.getByRole('link', { name, exact: true }).boundingBox()
          expect(bounds?.width).toBeGreaterThanOrEqual(44)
          expect(bounds?.height).toBeGreaterThanOrEqual(44)
        }
        await page.screenshot({ path: test.info().outputPath(`phone-settings-large-text-${viewportWidth}.png`), fullPage: true, animations: 'disabled' })
        await navigation.getByRole('link', { name: 'Schedule', exact: true }).focus()
        await page.keyboard.press('Tab')
        await expect(navigation.getByRole('link', { name: 'Sleep', exact: true })).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(navigation.getByRole('link', { name: 'Sleep', exact: true })).toHaveAttribute('aria-current', 'page')
        await navigation.getByRole('link', { name: 'Temp', exact: true }).click()
        const stage = page.getByTestId('temp-stage')
        await expect(stage).toBeVisible()
        await expect(page.getByTestId('stage-fallback')).toBeVisible()
        await expect(stage.getByRole('link', { name: 'Settings', exact: true })).toBeVisible()
        await expect.poll(async () => {
          const bed = await stage.boundingBox()
          const bar = await navigation.boundingBox()
          return bed && bar ? Math.abs(bed.y + bed.height - bar.y) : Number.POSITIVE_INFINITY
        }).toBeLessThanOrEqual(1)
        const toolbar = await page.getByTestId('stage-toolbar').boundingBox()
        const fallback = await page.getByTestId('stage-fallback').boundingBox()
        const timeline = await page.getByTestId('stage-timeline').boundingBox()
        expect(toolbar && fallback && timeline).toBeTruthy()
        if (!toolbar || !fallback || !timeline) throw new Error('Fallback layout is missing')
        expect(fallback.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height)
        expect(timeline.y).toBeGreaterThanOrEqual(fallback.y + fallback.height)
        const layout = await stage.evaluate((root) => {
          const bounds = root.getBoundingClientRect()
          return {
            width: root.clientWidth, scrollWidth: root.scrollWidth,
            overflow: [...root.querySelectorAll('*')].flatMap((element) => {
              const rect = element.getBoundingClientRect()
              const style = getComputedStyle(element)
              return rect.width > 0 && style.visibility !== 'hidden' && style.opacity !== '0' && (rect.right > bounds.left + root.clientWidth + 1 || rect.left < bounds.left - 1)
                ? [{ tag: element.tagName, testId: element.getAttribute('data-testid'), className: element.getAttribute('class'), text: element.textContent?.slice(0, 100), left: rect.left, right: rect.right }]
                : []
            }),
          }
        })
        if (layout.scrollWidth - layout.width > 1) await writeFile(test.info().outputPath('stage-layout.json'), JSON.stringify(layout, null, 2))
        await expect.poll(() => stage.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
        await page.getByTestId('stage-fallback').getByRole('group', { name: 'Right (right)' }).scrollIntoViewIfNeeded()
        await page.getByTestId('stage-timeline').scrollIntoViewIfNeeded()
        await expect(page.getByTestId('stage-timeline')).toBeInViewport()
        const lane = page.getByTestId('stage-lane')
        const laneBounds = await lane.boundingBox()
        if (!laneBounds) throw new Error('Timeline lane is missing')
        const nowLabel = await page.getByTestId('stage-now-label').boundingBox()
        if (!nowLabel) throw new Error('Current-time label is missing')
        expect(nowLabel.x).toBeGreaterThanOrEqual(laneBounds.x - 1)
        expect(nowLabel.x + nowLabel.width).toBeLessThanOrEqual(laneBounds.x + laneBounds.width + 1)
        for (const horizontalPosition of [1, laneBounds.width - 1]) {
          await lane.click({ position: { x: horizontalPosition, y: 10 } })
          const previewLabel = await page.getByTestId('stage-preview-label').boundingBox()
          if (!previewLabel) throw new Error('Preview label is missing')
          expect(previewLabel.x).toBeGreaterThanOrEqual(laneBounds.x - 1)
          expect(previewLabel.x + previewLabel.width).toBeLessThanOrEqual(laneBounds.x + laneBounds.width + 1)
          await expect.poll(() => stage.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
        }
        await stage.evaluate(element => element.scrollTo(0, 0))
        await page.screenshot({ path: test.info().outputPath(`phone-bed-large-text-${viewportWidth}.png`), animations: 'disabled' })
        await stage.getByRole('link', { name: 'Settings', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      })
    }
  }
})

test('3D bed renders without an internet dependency', async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1(?::|\/))/, route => route.abort())
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/en')
  await expect(page.getByTestId('stage-canvas').locator('canvas')).toBeVisible()
  await expect(page.getByTestId('stage-fallback')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('phone-bed-offline.png') })
})

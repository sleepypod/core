import { expect, test, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { mockPersonal } from './personal-fixture'
import { test as ownerTest } from './ownerTest'

async function captureGuide(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(name), fullPage: true })
}

test('audio guide teaches the whole handoff without account or media requests', async ({ page }) => {
  const apiRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url())
  })
  await page.goto('/guide/bedtime-audio.html')
  await expect(page.getByRole('heading', { name: 'Start with the sound you want.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Previous step' })).toBeDisabled()
  await captureGuide(page, 'audio-guide-desktop-prepare.png')
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('heading', { name: 'Give Start and Pause their own names.' })).toBeFocused()
  await page.getByText('Can the Shortcut use Sleepypod’s selected settings?', { exact: true }).click()
  await expect(page.getByText('Changing a value in Sleepypod does not edit your Shortcut.', { exact: false })).toBeVisible()
  await captureGuide(page, 'audio-guide-desktop-shortcuts.png')
  await page.getByRole('button', { name: 'Next step' }).click()
  await expect(page.getByRole('link', { name: 'Open Bedtime audio in the iOS app' })).toHaveAttribute('href', 'sleepypod-bedtime://open')
  await captureGuide(page, 'audio-guide-desktop-review.png')
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByLabel('Try an example result').selectOption('pause')
  await expect(page.locator('#example-response')).toContainText('does not confirm it stopped')
  await expect(page.getByRole('button', { name: 'Next step' })).toBeDisabled()
  await expect(page.getByRole('status')).toHaveText('Step 4 of 4')
  await captureGuide(page, 'audio-guide-desktop-result.png')
  expect(apiRequests).toEqual([])
})

test('phone guide keeps large text, unknown results and manual stop readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.goto('/guide/bedtime-audio.html')
  await page.addStyleTag({ content: ':root{font-size:24px}' })
  await page.getByRole('link', { name: '4. Check the result' }).click()
  await page.getByLabel('Try an example result').selectOption('unknown')
  await expect(page.locator('#example-response')).toContainText('has not been resent')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await captureGuide(page, 'audio-guide-phone-dark-large-result.png')
  await page.getByRole('link', { name: '3. Review in Sleepypod' }).click()
  await expect(page.getByRole('heading', { name: 'Need the sound to stop?' })).toBeVisible()
  await captureGuide(page, 'audio-guide-phone-dark-large-review.png')
})

test('tablet guide supports keyboard steps and reading without JavaScript', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1024, height: 1366 })
  await page.goto('/guide/bedtime-audio.html')
  await page.getByRole('link', { name: '2. Make two Shortcuts' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Give Start and Pause their own names.' })).toBeFocused()
  await captureGuide(page, 'audio-guide-tablet-keyboard.png')
  const plain = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1024, height: 1366 } })
  try {
    const reading = await plain.newPage()
    await reading.goto('http://127.0.0.1:3218/guide/bedtime-audio.html')
    await expect(reading.locator('section[data-step]:visible')).toHaveCount(4)
    await expect(reading.getByRole('button', { name: 'Next step' })).not.toBeVisible()
    await expect(reading.getByLabel('Try an example result')).not.toBeVisible()
    await expect(reading.locator('#example-response')).not.toBeVisible()
    await expect(reading.getByRole('heading', { name: 'Need the sound to stop?' })).toBeVisible()
    await reading.locator('#results-title').scrollIntoViewIfNeeded()
    await reading.screenshot({ path: test.info().outputPath('audio-guide-tablet-no-javascript.png') })
  }
  finally { await plain.close() }
})

test('personal account links to the guide without sending a command or an account key', async ({ page }) => {
  const account = await mockPersonal(page)
  await page.goto('/household/index.html')
  const link = page.getByRole('link', { name: 'Set up Endel bedtime audio' })
  await expect(link).toHaveAttribute('href', '/guide/bedtime-audio.html')
  await link.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('audio-guide-personal-entry.png') })
  await link.click()
  await expect(page).toHaveURL('http://127.0.0.1:3218/guide/bedtime-audio.html')
  expect(account.posts).toEqual([])
})

ownerTest('owner Home links to the same audio guide', async ({ page }) => {
  await page.goto('/en/home')
  await page.getByRole('link', { name: 'Set up Endel bedtime audio' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('audio-guide-owner-entry.png') })
  await page.getByRole('link', { name: 'Set up Endel bedtime audio' }).click()
  await expect(page.getByRole('heading', { name: 'Endel, ready for bed.' })).toBeVisible()
})

test('actual light and dark text colors meet body contrast requirements', async ({ page }) => {
  const measurements: unknown[] = []
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.goto('/guide/bedtime-audio.html')
    const pairs = await page.evaluate(() => ['header a', '.scope', '#prepare li', '.primary'].map((selector) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`Missing contrast target ${selector}`)
      let ancestor: Element | null = element
      let background = 'rgba(0, 0, 0, 0)'
      while (ancestor && (background === 'rgba(0, 0, 0, 0)' || background === 'transparent')) {
        background = getComputedStyle(ancestor).backgroundColor
        ancestor = ancestor.parentElement
      }
      return { selector, color: getComputedStyle(element).color, background }
    }))
    for (const pair of pairs) {
      const foreground = luminance(pair.color)
      const background = luminance(pair.background)
      const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
      measurements.push({ colorScheme, ...pair, ratio })
      expect(ratio, `${colorScheme} ${pair.selector}`).toBeGreaterThanOrEqual(4.5)
    }
  }
  const receipt = test.info().outputPath('computed-contrast.json')
  await writeFile(receipt, JSON.stringify(measurements, null, 2))
  await test.info().attach('computed-contrast', { path: receipt, contentType: 'application/json' })
})

function luminance(color: string) {
  const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  if (!values || values.length !== 3) throw new Error(`Unexpected CSS color ${color}`)
  const linear = values.map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

import { writeFile } from 'node:fs/promises'
import { test, expect } from './ownerTest'
test.use({ serviceWorkers: 'block' })
const headers = () => ({ Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` })
const read = '/api/v1/alarm/next?side=left'
const reviewPath = '/api/v1/alarm/later-preview'
const applyPath = '/api/v1/alarm/later-apply'

function contrastRatio(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map(value => value / 255)
    return channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0)
  }
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

test('later wake REST requires authentication and revalidates the displayed plan', async ({ request, playwright }) => {
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  for (const path of [reviewPath, applyPath]) expect((await anonymous.post(path, { data: {} })).status()).toBe(401)
  await anonymous.dispose()
  const dayOfWeek = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }).format(Date.now() + 86_400_000).toLowerCase()
  const created = await request.post('/api/schedules/alarm', { headers: headers(), data: { side: 'left', dayOfWeek, time: '07:00', vibrationIntensity: 50, duration: 20, alarmTemperature: 105 } })
  expect(created.status()).toBe(200)
  const row = await created.json()
  try {
    const before = await (await request.get(read, { headers: headers() })).json()
    const response = await request.post(reviewPath, { headers: headers(), data: { side: 'left', time: '09:00', expectedAt: before.alarm.at, expectedRevision: before.revision } })
    expect(response.status()).toBe(200)
    expect(response.headers()['cache-control']).toContain('no-store')
    const preview = await response.json()
    expect(await (await request.get(read, { headers: headers() })).json()).toEqual(before)
    const changed = { ...preview, proposed: { ...preview.proposed, targetF: 70 } }
    expect((await request.post(applyPath, { headers: headers(), data: { preview: changed } })).status()).toBe(409)
    const applied = await request.post(applyPath, { headers: headers(), data: { preview } })
    expect(applied.status()).toBe(200)
    expect(await applied.json()).toMatchObject({ alarm: { at: preview.proposed.at }, warming: { startsAt: preview.proposed.warmingStartsAt }, schedulerUpdated: true })
    expect((await request.post(applyPath, { headers: headers(), data: { preview } })).status()).toBe(409)
    const schedules = await (await request.get('/api/schedules?side=left', { headers: headers() })).json()
    expect(schedules.alarm.find((alarm: { id: number }) => alarm.id === row.id)).toEqual(row)
  }
  finally { expect((await request.delete('/api/schedules/alarm', { headers: headers(), params: { id: row.id } })).status()).toBe(200) }
})

for (const width of [390, 1280]) {
  test(`later wake review, expiry, unknown receipt and restored routine at ${width}px`, async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light', reducedMotion: 'reduce' })
    const dayOfWeek = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }).format(Date.now() + 86_400_000).toLowerCase()
    const created = await request.post('/api/schedules/alarm', { headers: headers(), data: { side: 'left', dayOfWeek, time: '07:00', vibrationIntensity: 50, duration: 20, alarmTemperature: 105 } })
    expect(created.status()).toBe(200)
    const row = await created.json()
    try {
      await page.goto('/en')
      await page.getByRole('button', { name: 'Cards', exact: true }).click()
      const card = page.getByRole('region', { name: 'Next alarm' })
      await card.getByRole('button', { name: 'Wake later once', exact: true }).click()
      const review = card.getByRole('region', { name: 'Later wake review' })
      await review.getByLabel('Later wake time').focus()
      const focusColors = await review.getByLabel('Later wake time').evaluate((element) => {
        const style = getComputedStyle(element)
        return { foreground: style.outlineColor, background: style.backgroundColor }
      })
      const focusContrast = contrastRatio(focusColors.foreground, focusColors.background)
      expect(focusContrast).toBeGreaterThanOrEqual(3)
      await page.screenshot({ fullPage: true, animations: 'disabled', path: testInfo.outputPath('later-draft-focus.png') })
      await review.getByRole('button', { name: 'Preview later wake' }).click()
      await expect(review).toContainText('Choose a later time')
      await expect(review.getByRole('alert')).toContainText('Choose a later time')
      await expect(review.getByLabel('Later wake time')).toHaveAttribute('aria-invalid', 'true')
      expect(await review.getByLabel('Later wake time').getAttribute('aria-describedby')).toContain(await review.getByRole('alert').getAttribute('id'))
      await page.screenshot({ fullPage: true, animations: 'disabled', path: testInfo.outputPath('later-invalid.png') })
      await review.getByLabel('Later wake time').fill('09:00')
      await review.getByRole('button', { name: 'Preview later wake' }).click()
      await expect(review).toContainText('8:30 AM toward 105°F')
      await expect(review).toContainText('9:00 AM for 20 seconds')
      await expect(review).toContainText('Phone alarms, lights, shades and audio are unchanged')
      expect((await (await request.get(read, { headers: headers() })).json()).alarm.time).toBe('07:00')
      await expect(review.getByRole('button', { name: 'Save this later wake' })).toBeEnabled()
      await page.screenshot({ fullPage: true, animations: 'disabled', path: testInfo.outputPath('later-preview.png') })
      // Only the browser clock advances; the isolated controller remains the authority.
      await page.clock.install()
      await page.clock.fastForward(91_000)
      await expect(review).toContainText('Preview expired')
      await expect(review.getByRole('alert')).toContainText('Use Refresh saved alarm below')
      await expect(review).not.toContainText('saved alarm changed')
      await expect(card.getByRole('button', { name: 'Refresh saved alarm' })).toBeEnabled()
      const expiryColor = await review.getByRole('status').evaluate(element => getComputedStyle(element).color)
      const expiryContrast = contrastRatio(expiryColor, focusColors.background)
      expect(expiryContrast).toBeGreaterThanOrEqual(4.5)
      const contrastPath = testInfo.outputPath('later-wake-contrast.json')
      await writeFile(contrastPath, JSON.stringify({ width, focus: { ...focusColors, ratio: focusContrast }, expiry: { foreground: expiryColor, background: focusColors.background, ratio: expiryContrast } }, null, 2))
      await testInfo.attach('later-wake-contrast.json', { path: contrastPath, contentType: 'application/json' })
      await page.screenshot({ fullPage: true, animations: 'disabled', path: testInfo.outputPath('later-expired.png') })
      await page.clock.setSystemTime(Date.now())
      await page.clock.resume()
      await page.reload()
      await card.getByRole('button', { name: 'Wake later once', exact: true }).click()
      await review.getByLabel('Later wake time').fill('09:00')
      await review.getByRole('button', { name: 'Preview later wake' }).click()
      await expect(review.getByRole('button', { name: 'Save this later wake' })).toBeEnabled()
      await page.route('**/api/trpc/nextAlarm.applyLater**', async (route) => {
        await route.fetch()
        await route.abort('failed')
      }, { times: 1 })
      await review.getByRole('button', { name: 'Save this later wake' }).click()
      await expect(review).toContainText('It may already have been saved')
      await expect(review.getByRole('alert')).toContainText('It may already have been saved')
      await expect(review).not.toContainText('saved alarm is unavailable')
      await page.screenshot({ fullPage: true, animations: 'disabled', path: testInfo.outputPath('later-unknown.png') })
      expect((await (await request.get(read, { headers: headers() })).json()).alarm.time).toBe('09:00')
      await card.getByRole('button', { name: 'Refresh saved alarm' }).click()
      await expect(review).toContainText('saved alarm changed')
      await expect(review).not.toContainText('It may already have been saved')
      await expect(review.getByRole('alert')).toContainText('saved alarm changed')
      await page.screenshot({ fullPage: true, animations: 'disabled', path: testInfo.outputPath('later-changed.png') })
      await review.getByRole('button', { name: 'Close review' }).click()
      await card.getByRole('button', { name: 'Restore routine alarm' }).click()
      await expect(card.getByRole('status')).toContainText('saved on your Pod')
      await expect(card).toContainText('Vibration at 7:00 AM for 20 seconds')
      await page.screenshot({ fullPage: true, animations: 'disabled', path: testInfo.outputPath('later-restored.png') })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
    finally { expect((await request.delete('/api/schedules/alarm', { headers: headers(), params: { id: row.id } })).status()).toBe(200) }
  })
}

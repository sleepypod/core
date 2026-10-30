import { test, expect } from './ownerTest'
const headers = () => ({ Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` })
const read = '/api/v1/alarm/next?side=left'
const change = '/api/v1/alarm/override'

test('next-alarm REST requires authentication and preserves weekly rows through skip/time/restore', async ({ request, playwright }) => {
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  expect((await anonymous.get(read)).status()).toBe(401)
  expect((await anonymous.post(change, { data: { side: 'left', action: 'skip' } })).status()).toBe(401)
  expect((await anonymous.get('/api/trpc/nextAlarm.get?input=%7B%22json%22%3A%7B%22side%22%3A%22left%22%7D%7D')).status()).toBe(401)
  await anonymous.dispose()
  const dayOfWeek = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }).format(Date.now() + 86_400_000).toLowerCase()
  const created = await request.post('/api/schedules/alarm', { headers: headers(), data: { side: 'left', dayOfWeek, time: '23:59', vibrationIntensity: 50, duration: 30, alarmTemperature: 80 } })
  expect(created.status()).toBe(200)
  const row = await created.json()
  try {
    const response = await request.get(read, { headers: headers() })
    expect(response.headers()['cache-control']).toContain('no-store')
    const before = await response.json()
    const skip = { side: 'left', action: 'skip', expectedRevision: before.revision, expectedAt: before.alarm.at }
    const skipped = await request.post(change, { headers: headers(), data: skip })
    expect(skipped.status()).toBe(200)
    const saved = await skipped.json()
    expect(saved.state).toBe('skipped')
    expect(saved.schedulerUpdated).toBe(true)
    expect((await request.post(change, { headers: headers(), data: skip })).status()).toBe(409)
    const moved = await request.post(change, { headers: headers(), data: { side: 'left', action: 'time', expectedRevision: saved.revision, expectedAt: saved.alarm.at, time: '23:58' } })
    expect(moved.status()).toBe(200)
    const updated = await moved.json()
    expect(updated.alarm.time).toBe('23:58')
    expect(updated.alarm.originalAt).toBe(before.alarm.at)
    const restored = await request.post(change, { headers: headers(), data: { side: 'left', action: 'restore', expectedRevision: updated.revision, expectedExpiresAt: updated.change.expiresAt } })
    expect(restored.status()).toBe(200)
    expect((await restored.json()).alarm.at).toBe(before.alarm.at)
    const schedules = await (await request.get('/api/schedules?side=left', { headers: headers() })).json()
    expect(schedules.alarm.find((alarm: { id: number }) => alarm.id === row.id)).toEqual(row)
  }
  finally {
    const deleted = await request.delete('/api/schedules/alarm', { headers: headers(), params: { id: row.id } })
    expect(deleted.status(), await deleted.text()).toBe(200)
  }
})

test('Temp shows one-time controls on desktop and phone and retains drafts after a lost response', async ({ page, request }, testInfo) => {
  const dayOfWeek = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }).format(Date.now() + 86_400_000).toLowerCase()
  const created = await request.post('/api/schedules/alarm', { headers: headers(), data: { side: 'left', dayOfWeek, time: '23:59', vibrationIntensity: 50, duration: 30, alarmTemperature: 80 } })
  expect(created.status()).toBe(200)
  const row = await created.json()
  try {
    await page.goto('/en')
    await page.getByRole('button', { name: 'Cards', exact: true }).click()
    const card = page.getByRole('region', { name: 'Next alarm' })
    await expect(card.getByRole('button', { name: 'Skip this alarm' })).toBeEnabled()
    await card.getByRole('button', { name: 'Change this time' }).click()
    await card.getByLabel('One-time wake time').fill('23:58')
    await page.route('**/api/trpc/nextAlarm.change**', async (route) => {
      await route.fetch()
      await route.abort('failed')
    }, { times: 1 })
    await card.getByRole('button', { name: 'Save one-time alarm' }).click()
    await expect(card.getByRole('status')).toContainText('Change not confirmed')
    await expect(card.getByLabel('One-time wake time')).toHaveValue('23:58')
    const stored = await (await request.get(read, { headers: headers() })).json()
    expect(stored.alarm.time).toBe('23:58')
    await card.getByRole('button', { name: 'Refresh saved alarm' }).click()
    await expect(card.getByText(/saved alarm changed/)).toBeVisible()
    await expect(card.getByRole('button', { name: 'Save one-time alarm' })).toBeDisabled()
    await card.getByRole('button', { name: 'Cancel', exact: true }).click()
    await card.getByRole('button', { name: 'Restore routine alarm' }).click()
    await expect(card.getByRole('status')).toContainText('saved on your Pod')
    await card.getByRole('button', { name: 'Skip this alarm' }).click()
    await expect(card).toContainText('skipped once')
    await page.screenshot({ path: testInfo.outputPath('next-alarm-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('next-alarm-phone.png'), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await card.getByRole('button', { name: 'Restore routine alarm' }).click()
    await expect(card).not.toContainText('skipped once')
  }
  finally {
    const deleted = await request.delete('/api/schedules/alarm', { headers: headers(), params: { id: row.id } })
    expect(deleted.status(), await deleted.text()).toBe(200)
  }
})

import { test, expect } from './ownerTest'
import type { BedtimeDraft, RoutineSnapshot } from '../../src/lib/bedtimeRoutines'

const draft: BedtimeDraft = {
  power: { onTime: '22:00', offTime: '07:00', onTemperature: 75, enabled: false, endAction: 'turn_off' },
  temperatures: [], alarm: null, notes: 'Browser fixture',
}
const headers = () => ({ Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` })

test('authenticated overnight routine editing persists and protects concurrent changes', async ({ page, request, playwright }, testInfo) => {
  // Exercise the real authentication boundary separately from the signed browser fixture.
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  expect((await anonymous.get('/api/v1/routines?side=left')).status()).toBe(401)
  await anonymous.dispose()

  const initial = await request.post('/api/v1/routines', { headers: headers(), data: { side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: draft }] } })
  expect(initial.status(), await initial.text()).toBe(200)
  const original = (await initial.json()).routines[0] as RoutineSnapshot
  expect(original.draft).toEqual(draft)
  const schema = await request.get('/api/openapi.json', { headers: headers() })
  expect(schema.status()).toBe(200)
  expect((await schema.json()).paths['/v1/routines']).toHaveProperty('post')

  await page.goto('/en/schedule')
  await page.getByRole('button', { name: 'Edit Sat', exact: true }).click()
  await expect(page.getByLabel('Power on', { exact: true })).toHaveValue('22:00')
  await expect(page.getByRole('switch', { name: 'Routine enabled', exact: true })).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('button', { name: 'saturday night' }).click()
  await page.getByRole('button', { name: 'monday night' }).click()
  await page.getByRole('button', { name: 'Save routine', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit Mon', exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Edit Mon', exact: true }).click()
  await expect(page.getByLabel('End time', { exact: true })).toHaveValue('07:00')
  await page.getByRole('switch', { name: 'Wake alarm enabled', exact: true }).click()
  await page.getByRole('button', { name: 'Increase Snooze duration', exact: true }).click()
  await page.getByRole('combobox', { name: 'Snooze taper', exact: true }).selectOption('40')
  await page.getByRole('button', { name: 'Save routine', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit Mon', exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Edit Mon', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Snooze taper', exact: true })).toHaveValue('40')
  await page.getByRole('textbox', { name: 'Notes', exact: true }).fill('Retain this unsaved draft')

  const current = await request.get('/api/v1/routines?side=left', { headers: headers() })
  const monday = (await current.json()).routines[0] as RoutineSnapshot
  expect(monday.dayOfWeek).toBe('monday')
  expect(monday.draft.power.enabled).toBe(false)
  expect(monday.draft.alarm).toMatchObject({ enabled: true, snoozeDuration: 360, snoozeTaper: 40 })
  const legacyAlarm = { ...monday.draft.alarm }
  delete legacyAlarm.snoozeDuration
  delete legacyAlarm.snoozeTaper
  const incompatible = await request.post('/api/v1/routines', { headers: headers(), data: { side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: monday.revision, replacement: { ...monday.draft, alarm: legacyAlarm } }] } })
  expect(incompatible.status()).toBe(412)
  const external = await request.post('/api/v1/routines', { headers: headers(), data: { side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: monday.revision, replacement: { ...monday.draft, notes: 'Other client saved' } }] } })
  expect(external.status()).toBe(200)
  await page.getByRole('button', { name: 'Save routine', exact: true }).click()
  await expect(page.getByText(/The monday routine changed/)).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Retain this unsaved draft')
  await page.screenshot({ path: testInfo.outputPath('routine-conflict-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.getByRole('button', { name: 'Edit Mon', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Other client saved')
  await expect(page.getByRole('combobox', { name: 'Snooze taper', exact: true })).toHaveValue('40')
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth }))
  expect(width.scroll).toBeLessThanOrEqual(width.viewport)
  await page.screenshot({ path: testInfo.outputPath('routine-mobile.png'), fullPage: true })

  const stale = await request.post('/api/v1/routines', { headers: headers(), data: { side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: monday.revision, replacement: null }] } })
  expect(stale.status()).toBe(409)
  const final = await request.get('/api/v1/routines?side=left', { headers: headers() })
  expect((await final.json()).routines[0].draft.notes).toBe('Other client saved')
})

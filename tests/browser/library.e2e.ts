import { test, expect } from './ownerTest'

test('library activation reviews day moves and preserves overnight ownership', async ({ page, request, playwright }, testInfo) => {
  const headers = { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }
  const template = { name: 'Week', bedtime: '23:58', wake: '23:59', points: { '23:58': 74, '23:59': 76 }, notes: '', endAction: 'turn_off', days: { left: [], right: ['wednesday', 'thursday'] }, active: false }
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3218', storageState: { cookies: [], origins: [] } })
  expect((await anonymous.put('/api/curve-templates', { data: template })).status()).toBe(401)
  await anonymous.dispose()
  const capabilities = await (await request.get('/api/v1/capabilities', { headers })).json()
  expect(capabilities.features.curveLibrary).toMatchObject({ implemented: true, runtime: 'ready' })

  const created = await request.put('/api/curve-templates', { headers, data: template })
  expect(created.status(), await created.text()).toBe(200)
  const week = (await created.json()).curve
  const other = await request.put('/api/curve-templates', { headers, data: { ...template, name: 'Holiday', days: { left: [], right: ['wednesday'] } } })
  expect(other.status()).toBe(200)
  const holiday = (await other.json()).curve
  const activated = await request.post('/api/curve-templates/active', { headers, data: { id: week.id, active: true } })
  expect(activated.status()).toBe(200)
  expect((await activated.json()).schedulerApplied).toBe(true)

  await page.goto('/en/schedule')
  await page.getByRole('tab', { name: 'Right', exact: true }).click()
  await page.getByRole('switch', { name: 'Turn on Holiday', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Wed moves from Week')
  await page.getByRole('button', { name: 'Move & turn on', exact: true }).click()
  await expect(page.getByRole('switch', { name: 'Turn off Holiday', exact: true })).toBeVisible()
  const claimed = await (await request.get('/api/curve-templates', { headers })).json()
  expect(claimed.find((curve: { id: number }) => curve.id === week.id).days.right).toEqual(['thursday'])
  expect(claimed.find((curve: { id: number }) => curve.id === holiday.id).days.right).toEqual(['wednesday'])

  await page.getByRole('button', { name: 'Edit Holiday', exact: true }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Travel night')
  await page.getByRole('button', { name: 'Save curve', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit Travel night', exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Edit Travel night', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Travel night')
  await page.setViewportSize({ width: 390, height: 844 })
  // The chart's ResizeObserver settles after the viewport change.
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: testInfo.outputPath('library-mobile.png'), fullPage: true })

  for (const name of ['Week', 'Travel night']) {
    const deleted = await request.delete('/api/curve-templates', { headers, params: { name } })
    expect(deleted.status(), await deleted.text()).toBe(200)
    expect(await deleted.json()).toEqual({ deleted: true, schedulerApplied: true })
  }
  const bedtime = { power: { onTime: '22:00', offTime: '07:00', onTemperature: 75, enabled: false, endAction: 'turn_off' }, temperatures: [], alarm: null, notes: 'Owned overnight fixture' }
  const savedNight = await request.post('/api/v1/routines', { headers, data: { side: 'right', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: bedtime }] } })
  expect(savedNight.status(), await savedNight.text()).toBe(200)
  const before = await savedNight.json()
  const refused = await request.put('/api/curve-templates', { headers, data: { ...template, active: true } })
  expect(refused.status()).toBe(412)
  const current = await (await request.get('/api/v1/routines?side=right', { headers })).json()
  expect(current.routines).toEqual(before.routines)
  const cleanup = await request.post('/api/v1/routines', { headers, data: { side: 'right', changes: [{ dayOfWeek: 'saturday', expectedRevision: before.routines[0].revision, replacement: null }] } })
  expect(cleanup.status()).toBe(200)
})

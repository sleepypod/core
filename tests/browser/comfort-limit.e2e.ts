import { test, expect } from './ownerTest'

test.use({ serviceWorkers: 'block' })
const endpoint = '/api/v1/temperature/comfort-limit'
const headers = () => ({ Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` })

test('comfort limit requires owner authentication and rejects stale or invalid saves', async ({ request, playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } })
  try {
    expect((await anonymous.get(`${endpoint}?side=left`)).status()).toBe(401)
  }
  finally { await anonymous.dispose() }
  const response = await request.get(`${endpoint}?side=left`, { headers: headers() })
  expect(response.ok()).toBeTruthy()
  expect(response.headers()['cache-control']).toContain('no-store')
  const initial = await response.json()
  const change = { side: 'left', expectedSourceSide: initial.sourceSide, expectedRevision: initial.revision,
    config: { enabled: true, minF: 68, maxF: 72 } }
  const saved = await request.put(endpoint, { headers: headers(), data: change })
  expect(saved.status()).toBe(200)
  expect((await saved.json()).config).toEqual(change.config)
  expect((await request.put(endpoint, { headers: headers(), data: change })).status()).toBe(409)
  expect((await request.put(endpoint, { headers: headers(), data: { ...change, config: { enabled: true, minF: 80, maxF: 70 } } })).status()).toBe(400)
  const restored = await request.put(endpoint, { headers: headers(), data: { ...change, expectedRevision: initial.revision + 1, config: initial.config } })
  expect(restored.ok()).toBeTruthy()
})

for (const width of [390, 1440]) {
  test(`comfort editor is legible and saves a reviewed range at ${width}px`, async ({ page, request }, testInfo) => {
    const initial = await (await request.get(`${endpoint}?side=left`, { headers: headers() })).json()
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/en')
    await page.getByRole('button', { name: 'Comfort limits', exact: true }).click()
    const card = page.getByRole('region', { name: 'Overnight comfort limit' })
    await expect(card.getByRole('button', { name: 'Edit comfort range' })).toBeVisible()
    await card.getByRole('button', { name: 'Edit comfort range' }).click()
    await card.getByRole('checkbox').check()
    await card.getByLabel('Minimum (°F)').fill('69')
    await card.getByLabel('Maximum (°F)').fill('72')
    const save = card.getByRole('button', { name: 'Save comfort range' })
    const contrast = await save.evaluate((button) => {
      const style = getComputedStyle(button)
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)?.slice(0, 3).map((value) => {
          const scaled = Number(value) / 255
          return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
        })
        if (!channels || channels.length !== 3) throw new Error('Expected an opaque RGB button color')
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }
      const foreground = luminance(style.color), background = luminance(style.backgroundColor)
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
    })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
    await card.screenshot({ path: testInfo.outputPath(`comfort-limit-${width}.png`) })
    const bounds = await card.boundingBox()
    expect(bounds?.x).toBeGreaterThanOrEqual(0)
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width)
    await card.getByRole('button', { name: 'Save comfort range' }).click()
    await expect(card.getByText('69–72°F automatic range')).toBeVisible()
    const current = await (await request.get(`${endpoint}?side=left`, { headers: headers() })).json()
    expect((await request.put(endpoint, { headers: headers(), data: { side: 'left', expectedSourceSide: current.sourceSide, expectedRevision: current.revision, config: initial.config } })).ok()).toBeTruthy()
  })
}

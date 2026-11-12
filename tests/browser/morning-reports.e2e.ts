import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from './ownerTest'
import fixture from '../../src/reports/tests/fixtures/native-report-v1.json' with { type: 'json' }
import { mockPersonal } from './personal-fixture'

test.use({ serviceWorkers: 'block' })

async function share(page: Page, text?: string, comparison?: unknown, source?: string) {
  const document = structuredClone(fixture)
  document.report.id = randomUUID()
  if (text !== undefined) document.report.text = text
  if (source !== undefined) document.report.source = source
  if (comparison !== undefined) document.report.comparison = comparison as typeof document.report.comparison
  const session = await page.request.get('/api/auth/session')
  const headers = { origin: new URL(session.url()).origin }
  const response = await page.request.put(`/api/v1/reports/${document.report.id}`, { headers, data: { expectedRevision: null, document } })
  expect(response.ok(), await response.text()).toBe(true)
  const copy = await response.json()
  let withdrawn = false
  return { document, copy, async remove() {
    if (withdrawn) return
    const removed = await page.request.delete(`/api/v1/reports/${document.report.id}`, { headers, data: { expectedRevision: copy.receipt.revision } })
    expect(removed.ok()).toBe(true)
    withdrawn = true
  } }
}

for (const width of [390, 834, 1440]) {
  test(`reads a real shared brief, chart gaps and evidence at ${width}`, async ({ page }, testInfo) => {
    const shared = await share(page, fixture.report.text + '\n\n### One experiment to consider\n**Keep your current plan** while collecting three morning comfort notes. [health.sleep]\n\n### Details\n- The comparison includes a missing day.\n- Preserve your wake alarm.')
    try {
      const writes: string[] = []
      page.on('request', (request) => {
        if (request.method() !== 'GET') writes.push(request.url())
      })
      await page.setViewportSize({ width, height: 1000 })
      await page.goto('/en/sleep?view=reports')
      const report = page.getByRole('region', { name: 'Your morning brief' })
      await expect(report.getByRole('heading', { name: 'Latest recorded sleep' })).toBeVisible()
      await expect(report.getByText('13/14 days', { exact: true })).toBeVisible()
      await expect(report.getByText('60 minutes more', { exact: false })).toBeVisible()
      await expect(report.locator('svg rect')).toHaveCount(13)
      // Check the displayed text size, not just its unscaled SVG font declaration.
      await expect.poll(async () => report.locator('svg text').evaluateAll(labels => labels.every((label) => {
        const text = label as SVGTextElement
        const scale = text.getScreenCTM()?.d ?? 0
        const displayedSize = Number.parseFloat(getComputedStyle(text).fontSize) * Math.abs(scale)
        const bounds = text.getBoundingClientRect(), chart = text.ownerSVGElement?.getBoundingClientRect()
        return chart !== undefined && displayedSize >= 12 && displayedSize <= 14
          && bounds.left >= chart.left && bounds.right <= chart.right
          && bounds.top >= chart.top && bounds.bottom <= chart.bottom
      }))).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`brief-resting-${width}.png`) })
      await report.getByText('Read each recorded day', { exact: true }).click()
      await expect(report.getByText('Unknown', { exact: true })).toBeVisible()
      await report.getByText('Full interpretation and evidence', { exact: true }).click()
      await expect(report.locator('.report-prose strong').first()).toContainText('Keep your current plan')
      await report.locator('.report-experiment summary').click()
      await expect(report.locator('.report-experiment')).toContainText('Synthetic source-specific sleep estimates')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: testInfo.outputPath(`brief-${width}.png`), fullPage: true })
      expect(writes).toEqual([])
    }
    finally { await shared.remove() }
  })
}

test('report text cannot load remote resources or execute HTML; invalid comparison is withheld', async ({ page }, testInfo) => {
  const shared = await share(page, '## Saved meaning\n**Bold highlight** and *emphasis*. <img src="https://untrusted.invalid/pixel"> [link](https://untrusted.invalid/) ![photo](https://untrusted.invalid/pixel)\n\n| Meaning | Value |\n| --- | --- |\n| Coverage | Unknown |', { metric: 'bed_presence' })
  const remote: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('untrusted.invalid')) remote.push(request.url())
  })
  try {
    await page.goto('/en/sleep?view=reports')
    const report = page.getByRole('region', { name: 'Your morning brief' })
    await expect(report.getByText('The saved chart data could not be validated.', { exact: false })).toBeVisible()
    await report.getByText('Full interpretation and evidence', { exact: true }).click()
    await expect(report.locator('strong').filter({ hasText: 'Bold highlight' })).toBeVisible()
    await expect(report.locator('a,img,script')).toHaveCount(0)
    await expect(report.getByRole('table')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('invalid-chart-literal-prose.png'), fullPage: true })
    expect(remote).toEqual([])
  }
  finally { await shared.remove() }
})

test('dark mobile reader supports loading, long sources, keyboard focus and a withdrawn selection', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('sleepypod-pref-theme', 'dark'))
  const older = await share(page)
  const newer = await share(page, '## Newer interpretation\nThis is a distinct synthetic report.', undefined,
    'Synthetic Watch · a deliberately long source name to verify readable wrapping in the report picker and source badge')
  let release: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/reports', async (route) => {
    await ready
    await route.continue()
  })
  try {
    await page.goto('/en/sleep?view=reports')
    const report = page.getByRole('region', { name: 'Your morning brief' })
    await expect(report.getByRole('status')).toContainText('Checking your account')
    await expect(report.getByRole('button', { name: 'Opening reports…' })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('dark-loading.png') })
    release()
    const picker = report.getByLabel('Saved report', { exact: true })
    await picker.selectOption(newer.document.report.id)
    await expect(picker).toHaveValue(newer.document.report.id)
    await picker.focus()
    await expect(picker).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('dark-selection.png') })
    // macOS headless Chromium also ignores arrow selection on a plain HTML select.
    // Check native select changes through Playwright, and keyboard activation on the refresh button.
    await picker.selectOption(older.document.report.id)
    await expect(picker).toHaveValue(older.document.report.id)
    await newer.remove()
    await older.remove()
    const refresh = report.getByRole('button', { name: 'Refresh reports' })
    await refresh.focus()
    await refresh.press('Enter')
    await expect(report.getByText('This web copy was withdrawn.', { exact: false })).toBeVisible()
    await page.reload()
    await expect(report.getByText('No reports have been shared with this account.', { exact: false })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('dark-empty.png') })
  }
  finally {
    release()
    await page.unroute('**/api/v1/reports')
    await older.remove()
    await newer.remove()
  }
})

test('the remaining report can be selected after withdrawing one of two copies', async ({ page }) => {
  const first = await share(page), second = await share(page)
  try {
    await page.goto('/en/sleep?view=reports')
    const report = page.getByRole('region', { name: 'Your morning brief' })
    const picker = report.getByLabel('Saved report', { exact: true })
    await picker.selectOption(first.document.report.id)
    await first.remove()
    await report.getByRole('button', { name: 'Refresh reports' }).click()
    await expect(report.getByText('This web copy was withdrawn.', { exact: false })).toBeVisible()
    await picker.selectOption(second.document.report.id)
    await expect(report.getByRole('heading', { name: 'Latest recorded sleep' })).toBeVisible()
    await expect(report.getByText('This web copy was withdrawn.', { exact: false })).toHaveCount(0)
  }
  finally {
    await first.remove()
    await second.remove()
  }
})

test('withdrawal, connection failure and account events remove the displayed report', async ({ page }, testInfo) => {
  const shared = await share(page)
  await page.goto('/en/sleep?view=reports')
  const report = page.getByRole('region', { name: 'Your morning brief' })
  await expect(report.getByRole('heading', { name: 'Latest recorded sleep' })).toBeVisible()
  await shared.remove()
  await report.getByRole('button', { name: 'Refresh reports' }).click()
  await expect(report.getByText('This web copy was withdrawn.', { exact: false })).toBeVisible()
  await expect(report.locator('.report-reading')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('withdrawn.png'), fullPage: true })
  await page.route('**/api/v1/reports**', route => route.abort())
  await report.getByRole('button', { name: 'Refresh reports' }).click()
  await expect(report.getByRole('alert')).toContainText('could not be verified')
  await page.screenshot({ path: testInfo.outputPath('unavailable.png'), fullPage: true })
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await expect(report.getByRole('alert')).toHaveCount(0)
})

test('personal reports use the personal account and never request the owner library', async ({ page }, testInfo) => {
  const sample = await mockPersonal(page)
  sample.session.capabilities = { ...sample.session.capabilities, personalReports: true } as typeof sample.session.capabilities
  await page.route('**/api/v1/me/reports', route => route.fulfill({ json: { version: 1, generatedAt: Date.now(), reports: [], scope: {
    podId: sample.session.podId, householdId: sample.session.householdId, accountId: sample.session.accountId, sleeperId: sample.session.selfSleeperId,
    sessionRevision: sample.session.sessionRevision, householdRevision: sample.session.householdRevision, assignmentRevision: sample.session.assignmentRevision,
  } } }))
  await page.goto('/household/index.html')
  const report = page.getByRole('region', { name: 'Your morning brief' })
  await report.getByRole('button', { name: 'Open shared reports' }).click()
  await expect(report.getByText('Owner reports are kept separate.', { exact: false })).toBeVisible()
  await report.evaluate(node => node.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: testInfo.outputPath('personal-empty.png') })
  expect(sample.unexpected.filter(path => path.includes('reports'))).toEqual([])
})

test('personal report content clears when its household revision changes', async ({ page }, testInfo) => {
  const sample = await mockPersonal(page)
  sample.session.capabilities = { ...sample.session.capabilities, personalReports: true } as typeof sample.session.capabilities
  const report = structuredClone(fixture.report), now = Date.now()
  report.id = report.id.toLowerCase()
  const scope = { podId: sample.session.podId, householdId: sample.session.householdId, accountId: sample.session.accountId,
    sleeperId: sample.session.selfSleeperId, sessionRevision: sample.session.sessionRevision,
    householdRevision: sample.session.householdRevision, assignmentRevision: sample.session.assignmentRevision }
  const receipt = { id: report.id, revision: randomUUID(), deleted: false, createdAt: report.createdAt, receivedAt: now, updatedAt: now }
  const envelope = { version: 1, generatedAt: now, scope }
  await page.route('**/api/v1/me/reports', route => route.fulfill({ json: { ...envelope,
    reports: [{ ...receipt, provider: report.provider, model: report.model, source: report.source }] } }))
  await page.route(`**/api/v1/me/reports/${report.id}`, route => route.fulfill({ json: { ...envelope, receipt, report } }))
  await page.goto('/household/index.html')
  const reader = page.getByRole('region', { name: 'Your morning brief' })
  await reader.getByRole('button', { name: 'Open shared reports' }).click()
  await expect(reader.getByRole('heading', { name: 'Latest recorded sleep' })).toBeVisible()
  await reader.evaluate(node => node.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: testInfo.outputPath('personal-report.png') })
  sample.session.householdRevision += 1
  await reader.getByRole('button', { name: 'Refresh reports' }).click()
  await expect(reader.getByRole('alert')).toContainText('could not be verified')
  await expect(reader.locator('.report-reading')).toHaveCount(0)
  expect(sample.unexpected.filter(path => path.includes('reports'))).toEqual([])
})

import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from './ownerTest'
import fixture from '../../src/reports/tests/fixtures/native-report-v1.json' with { type: 'json' }
import { parseMorningReport } from '../../src/reports/morning'
import { mockPersonal } from './personal-fixture'

test.use({ serviceWorkers: 'block' })
const answerText = '**The saved coverage is limited.** Unknown days are not zero sleep. [health.coverage]'
const reply = { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: answerText }] }], usage: { input_tokens: 60, output_tokens: 20 } }

async function ownerReport(page: Page) {
  const document = structuredClone(fixture)
  document.report.id = randomUUID()
  const response = await page.request.put(`/api/v1/reports/${document.report.id}`, { headers: { origin: 'http://127.0.0.1:3218' }, data: { expectedRevision: null, document } })
  expect(response.ok()).toBe(true)
  return { document, copy: await response.json(), async remove() {
    const current = await page.request.get(`/api/v1/reports/${document.report.id}`)
    const removed = await page.request.delete(`/api/v1/reports/${document.report.id}`, { headers: { origin: 'http://127.0.0.1:3218' }, data: { expectedRevision: (await current.json()).receipt.revision } })
    expect(removed.ok()).toBe(true)
  } }
}
async function prepare(page: Page) {
  const questions = page.getByRole('region', { name: 'Ask about this report' })
  await questions.getByLabel('Answer with', { exact: true }).selectOption('openai')
  await questions.getByLabel('Model ID', { exact: true }).fill('synthetic-selected-model')
  await questions.getByLabel('Your provider API key', { exact: true }).fill('synthetic-key-never-real')
  await questions.getByLabel('Your question', { exact: true }).fill('What does the saved coverage tell me?')
  await questions.getByRole('button', { name: 'Review question', exact: true }).click()
  await expect(questions.getByRole('heading', { name: 'Review before sending' })).toBeVisible()
  return questions
}
async function ask(page: Page) {
  const questions = await prepare(page)
  await expect(questions.getByRole('button', { name: 'Ask this question', exact: true })).toBeDisabled()
  await questions.getByRole('checkbox', { name: 'Send this question and these facts to the selected model.' }).check()
  await questions.getByRole('button', { name: 'Ask this question', exact: true }).click()
  return questions
}

for (const width of [390, 834, 1440]) {
  test(`reviews old evidence and explicitly saves a browser answer at ${width}`, async ({ page }, testInfo) => {
    const sample = await ownerReport(page)
    const modelCalls: object[] = [], writes: object[] = []
    await page.route('https://api.openai.com/v1/responses', async (route) => {
      modelCalls.push(route.request().postDataJSON())
      await route.fulfill({ json: reply })
    })
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/api/v1/reports/')) writes.push(request.postDataJSON())
    })
    try {
      await page.setViewportSize({ width, height: 1000 })
      if (width === 834) await page.addInitScript(() => localStorage.setItem('sleepypod-pref-theme', 'dark'))
      await page.goto('/en/sleep?view=reports')
      const questions = await prepare(page)
      expect(modelCalls).toEqual([])
      expect(writes).toEqual([])
      await questions.evaluate(node => node.scrollIntoView({ block: 'start' }))
      await page.screenshot({ path: testInfo.outputPath(`question-review-${width}.png`), fullPage: true })
      await questions.getByRole('checkbox', { name: 'Send this question and these facts to the selected model.' }).check()
      await questions.getByRole('button', { name: 'Ask this question', exact: true }).click()
      await expect(questions.locator('strong')).toContainText('The saved coverage is limited.')
      expect(modelCalls).toHaveLength(1)
      expect(JSON.stringify(modelCalls)).toContain(sample.document.report.facts[0].text)
      expect(JSON.stringify(modelCalls)).not.toContain(sample.document.report.text)
      expect(JSON.stringify(modelCalls)).not.toContain('synthetic-key-never-real')
      expect(writes).toEqual([])
      await expect(questions.getByRole('button', { name: 'Save answer to report', exact: true })).toBeDisabled()
      await questions.evaluate(node => node.scrollIntoView({ block: 'start' }))
      await page.screenshot({ path: testInfo.outputPath(`answer-review-${width}.png`), fullPage: true })
      await questions.getByRole('checkbox', { name: 'Save this question and answer with the report on my Pod.' }).check()
      await questions.getByRole('button', { name: 'Save answer to report', exact: true }).click()
      await expect(questions.getByRole('status')).toContainText('Answer saved')
      expect(writes).toHaveLength(1)
      expect(JSON.stringify(writes)).not.toContain('synthetic-key-never-real')
      const saved = await page.request.get(`/api/v1/reports/${sample.document.report.id}`)
      expect((await saved.json()).report.followUps.at(-1).text).toBe(answerText)
      await page.reload()
      await expect(page.locator('.report-answers').getByRole('heading', { name: 'What does the saved coverage tell me?' })).toBeVisible()
      await page.getByLabel('Answer with', { exact: true }).selectOption('openai')
      await expect(page.getByLabel('Your provider API key', { exact: true })).toHaveValue('')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
    finally { await sample.remove() }
  })
}

test('lost upload reply is recovered by reading; no duplicate upload or model call', async ({ page }, testInfo) => {
  const sample = await ownerReport(page)
  let modelCalls = 0, writes = 0, recovering = false
  let releaseRead: () => void = () => {}
  const delayedRead = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  await page.route('https://api.openai.com/v1/responses', async (route) => {
    modelCalls += 1
    await route.fulfill({ json: reply })
  })
  await page.route(`**/api/v1/reports/${sample.document.report.id}`, async (route) => {
    if (route.request().method() !== 'PUT') {
      if (recovering) await delayedRead
      return route.continue()
    }
    writes += 1
    const result = await route.fetch()
    expect(result.ok()).toBe(true)
    await route.abort('failed')
  })
  try {
    await page.goto('/en/sleep?view=reports')
    const questions = await ask(page)
    await questions.getByRole('checkbox', { name: 'Save this question and answer with the report on my Pod.' }).check()
    await questions.getByRole('button', { name: 'Save answer to report', exact: true }).click()
    await expect(questions.getByRole('alert')).toContainText('unconfirmed')
    await expect(questions.getByRole('button', { name: 'Save answer to report', exact: true })).toHaveCount(0)
    await questions.evaluate(node => node.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: testInfo.outputPath('answer-uncertain.png'), fullPage: true })
    recovering = true
    await questions.getByRole('button', { name: 'Check saved result', exact: true }).click()
    await expect(questions.getByRole('status')).toContainText('Checking saved result')
    await expect(questions.getByRole('button', { name: 'Check saved result', exact: true })).toHaveCount(0)
    await expect(questions.locator('.report-answer')).toContainText('The saved coverage is limited.')
    await page.screenshot({ path: testInfo.outputPath('answer-recovery-pending.png'), fullPage: true })
    releaseRead()
    await expect(questions.getByRole('status')).toContainText('Answer saved')
    expect(writes).toBe(1)
    expect(modelCalls).toBe(1)
  }
  finally {
    releaseRead()
    await sample.remove()
  }
})

test('cancelled provider answer never reappears; failed requests require a new review', async ({ page }, testInfo) => {
  const sample = await ownerReport(page)
  let calls = 0
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('https://api.openai.com/v1/responses', async (route) => {
    calls += 1
    if (calls === 1) await pending
    await route.fulfill(calls === 1 ? { json: reply } : { status: 401, json: { error: { message: 'Private provider error' } } }).catch(() => {})
  })
  try {
    await page.goto('/en/sleep?view=reports')
    const questions = await ask(page)
    await expect(questions.getByRole('status')).toContainText('Waiting')
    await expect.poll(() => calls).toBe(1)
    await questions.getByRole('button', { name: 'Cancel request' }).click()
    release()
    await expect(questions.getByText('Request cancelled.', { exact: false })).toBeVisible()
    await expect(questions.locator('.report-answer')).toHaveCount(0)
    await ask(page)
    await expect(questions.getByRole('alert')).toContainText('The provider rejected access')
    await expect(questions.getByRole('alert')).toContainText('Check your key, model access and browser-access policy')
    await expect(questions).not.toContainText('Private provider error')
    await questions.evaluate(node => node.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: testInfo.outputPath('answer-provider-error.png'), fullPage: true })
    expect(calls).toBe(2)
  }
  finally {
    release()
    await sample.remove()
  }
})

test('provider usage limits explain account recovery without exposing the response body', async ({ page }, testInfo) => {
  const sample = await ownerReport(page)
  await page.route('https://api.openai.com/v1/responses', route => route.fulfill({ status: 429, json: { error: 'Private billing detail' } }))
  try {
    await page.goto('/en/sleep?view=reports')
    const questions = await ask(page)
    await expect(questions.getByRole('alert')).toContainText('The provider reached a usage limit. Check your provider account')
    await expect(questions).not.toContainText('Private billing detail')
    await page.screenshot({ path: testInfo.outputPath('answer-usage-limit.png'), fullPage: true })
  }
  finally { await sample.remove() }
})

test('keyboard focus follows review, cancellation, answer and separate saving', async ({ page }, testInfo) => {
  const sample = await ownerReport(page)
  let calls = 0, release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('https://api.openai.com/v1/responses', async (route) => {
    calls += 1
    if (calls === 1) await pending
    await route.fulfill({ json: reply }).catch(() => {})
  })
  const questions = page.getByRole('region', { name: 'Ask about this report' })
  const tabTo = async (locator: ReturnType<Page['locator']>) => {
    for (let attempts = 0; attempts < 20; attempts++) {
      if (await locator.evaluate(node => node === document.activeElement)) break
      await page.keyboard.press('Tab')
    }
    await expect(locator).toBeFocused()
  }
  const send = async () => {
    await tabTo(questions.getByRole('checkbox', { name: 'Send this question and these facts to the selected model.' }))
    await page.keyboard.press('Space')
    await page.keyboard.press('Tab')
    await expect(questions.getByRole('button', { name: 'Ask this question', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
  }
  try {
    await page.goto('/en/sleep?view=reports')
    await questions.getByLabel('Answer with', { exact: true }).focus()
    await page.keyboard.press('o')
    await page.keyboard.press('Enter')
    await expect(questions.getByLabel('Answer with', { exact: true })).toHaveValue('openai')
    // Linux Chromium can leave the native select popup open after Enter; close it before checking document tab order.
    await page.keyboard.press('Escape')
    await expect(questions.getByLabel('Answer with', { exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(questions.getByLabel('Model ID', { exact: true })).toBeFocused()
    await page.keyboard.type('synthetic-selected-model')
    await page.keyboard.press('Tab')
    await page.keyboard.type('synthetic-key-never-real')
    await page.keyboard.press('Tab')
    await page.keyboard.type('What does the saved coverage tell me?')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(questions.getByRole('heading', { name: 'Review before sending' })).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath('question-keyboard-focus.png'), fullPage: true })
    await send()
    await expect.poll(() => calls).toBe(1)
    await expect(questions.getByRole('status')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(questions.getByRole('button', { name: 'Cancel request' })).toBeFocused()
    await page.keyboard.press('Enter')
    release()
    await expect(questions.getByRole('status')).toBeFocused()
    await tabTo(questions.getByLabel('Your provider API key', { exact: true }))
    await page.keyboard.type('synthetic-key-never-real')
    await tabTo(questions.getByRole('button', { name: 'Review question', exact: true }))
    await page.keyboard.press('Enter')
    await expect(questions.getByRole('heading', { name: 'Review before sending' })).toBeFocused()
    await send()
    await expect(questions.locator('.report-answer h4')).toBeFocused()
    await tabTo(questions.getByRole('checkbox', { name: 'Save this question and answer with the report on my Pod.' }))
    await page.keyboard.press('Space')
    await page.keyboard.press('Tab')
    await expect(questions.getByRole('button', { name: 'Save answer to report', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(questions.getByRole('status')).toContainText('Answer saved')
    await expect(questions.getByRole('status')).toBeFocused()
  }
  finally {
    release()
    await sample.remove()
  }
})

test('personal question saves through the sleeper route and never through the owner', async ({ page }, testInfo) => {
  const sample = await mockPersonal(page)
  sample.session.capabilities = { ...sample.session.capabilities, personalReports: true } as typeof sample.session.capabilities
  const scope = { podId: sample.session.podId, householdId: sample.session.householdId, accountId: sample.session.accountId,
    sleeperId: sample.session.selfSleeperId, sessionRevision: sample.session.sessionRevision,
    householdRevision: sample.session.householdRevision, assignmentRevision: sample.session.assignmentRevision }
  let report = parseMorningReport(JSON.stringify(fixture), Date.now())
  report.id = report.id.toLowerCase()
  let revision = randomUUID(), writes = 0
  const receipt = (timestamp: number) => ({ id: report.id, revision, deleted: false, createdAt: report.createdAt, receivedAt: report.createdAt, updatedAt: timestamp })
  await page.route('**/api/v1/me/reports', (route) => {
    const timestamp = Date.now()
    return route.fulfill({ json: { version: 1, generatedAt: timestamp, scope, reports: [{ ...receipt(timestamp), provider: report.provider, model: report.model, source: report.source }] } })
  })
  await page.route(`**/api/v1/me/reports/${report.id}`, async (route) => {
    expect(route.request().headers()['x-sleepypod-sleeper-id']).toBe(scope.sleeperId)
    if (route.request().method() === 'PUT') {
      expect(route.request().postDataJSON().expectedRevision).toBe(revision)
      report = route.request().postDataJSON().document.report
      revision = randomUUID()
      writes += 1
    }
    const timestamp = Date.now()
    await route.fulfill({ json: { version: 1, generatedAt: timestamp, scope, receipt: receipt(timestamp), report } })
  })
  await page.route('https://api.openai.com/v1/responses', route => route.fulfill({ json: reply }))
  await page.goto('/household/index.html')
  await page.getByRole('button', { name: 'Open shared reports' }).click()
  const questions = await ask(page)
  await questions.getByRole('checkbox', { name: 'Save this question and answer with the report on my Pod.' }).check()
  await questions.getByRole('button', { name: 'Save answer to report', exact: true }).click()
  await expect(questions.getByRole('status')).toContainText('Answer saved')
  expect(writes).toBe(1)
  expect(sample.unexpected.filter(path => path.includes('reports'))).toEqual([])
  await questions.evaluate(node => node.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: testInfo.outputPath('personal-answer-saved.png') })
})

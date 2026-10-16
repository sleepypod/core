import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'

const fixture = async (action: 'replay' | 'adopt') => {
  await promisify(execFile)('pnpm', ['exec', 'tsx', 'tests/browser/fixture.ts', action], { timeout: 45_000, maxBuffer: 65536 })
}
function configuration() {
  const path = process.env.DATABASE_URL
  if (!path || !process.env.SLEEPYPOD_BROWSER_FIXTURE) throw new Error('Isolated fixture required')
  const db = new Database(path, { readonly: true })
  try {
    return db.prepare('SELECT side, desired_revision_id, generation FROM biometric_profile_bindings ORDER BY side').all() as { side: string, desired_revision_id: string | null, generation: number }[]
  }
  finally { db.close() }
}
async function view(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Calibration views' }).getByRole('button', { name, exact: true }).click()
}

test('import, freeze, replay, review, manually apply, acknowledge, and roll back', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/en/settings?section=biometric-calibration')
  await view(page, 'References')
  await page.getByLabel('Sleeper identifier', { exact: true }).fill('browser-sleeper')
  await page.getByLabel('Reference source', { exact: true }).fill('browser-reference')
  await page.getByLabel('Reference records', { exact: true }).fill('recordKey,metric,value,unit,timestamp,start,end\nhr-1,heart_rate,62,bpm,2026-10-10T23:00:00Z,,\nstage-1,sleep_stages,light,stage,,2026-10-10T23:00:00Z,2026-10-10T23:10:00Z')
  await page.getByRole('button', { name: 'Preview import', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Import preview' })).toContainText('Accepted: 2; rejected: 0')
  await page.getByRole('button', { name: 'Save previewed import', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Reference import saved:' })).toBeVisible()

  await view(page, 'Profiles')
  await page.getByLabel('heart_rate.trackingToleranceBpm', { exact: true }).fill('17')
  await page.getByRole('button', { name: 'Review candidate', exact: true }).click()
  await page.getByRole('button', { name: 'Save candidate without applying', exact: true }).click()
  const saved = page.getByRole('status').filter({ hasText: 'Candidate saved:' })
  await expect(saved).toBeVisible()
  const candidateId = (await saved.innerText()).replace('Candidate saved: ', '').trim()
  expect(candidateId).toMatch(/^[a-f0-9-]{36}$/)
  const baseline = configuration()

  await view(page, 'Backtests')
  await page.getByRole('button', { name: 'Inspect session 1', exact: true }).click()
  await page.getByLabel('Include this session', { exact: true }).check()
  await page.getByLabel('Dataset sleeper identifier', { exact: true }).fill('browser-sleeper')
  await page.getByLabel('browser-reference · browser-sleeper · revision 1', { exact: true }).check()
  await page.getByRole('button', { name: 'Freeze selected inputs', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Dataset saved:' })).toBeVisible()
  await page.getByRole('button', { name: 'Inspect dataset', exact: true }).click()
  await page.getByRole('combobox', { name: 'Evaluation mode', exact: true }).selectOption('stage_replay')
  await page.getByLabel('Assumed calibration quality (0–1)', { exact: true }).fill('0')
  await page.getByRole('button', { name: 'Save evaluation protocol', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Experiment saved:' })).toBeVisible()
  await page.getByRole('button', { name: 'Prepare backtest', exact: true }).click()
  await page.getByRole('radio', { name: new RegExp(candidateId) }).check()
  await page.getByRole('button', { name: 'Queue backtest', exact: true }).click()
  await expect(page.getByText('Waiting for a worker and resource admission.', { exact: false })).toBeVisible()
  await fixture('replay')
  await page.getByRole('button', { name: 'Review report', exact: true }).click({ timeout: 15_000 })
  const scoreTables = page.getByRole('table', { name: 'Pooled common-support stage scores', exact: true })
  await expect(scoreTables).toHaveCount(3)
  for (const table of await scoreTables.all()) await expect(table).not.toContainText('Not scored')
  await expect(page.getByRole('region', { name: 'Evaluation report' })).toContainText('Insufficient evidence for validated improvement')
  expect(configuration()).toEqual(baseline)
  await page.getByRole('region', { name: 'Evaluation report' }).screenshot({ path: test.info().outputPath('evaluation-report.png') })

  await view(page, 'Profiles')
  const candidate = page.getByRole('listitem').filter({ has: page.getByText(candidateId, { exact: true }) })
  await candidate.getByRole('button', { name: 'Inspect candidate changes', exact: true }).click()
  await candidate.getByRole('button', { name: 'Compare with saved profile', exact: true }).click()
  await candidate.getByLabel('I intend to apply this exact revision without validation evidence.', { exact: true }).check()
  await candidate.getByRole('button', { name: 'Apply unvalidated revision', exact: true }).click()
  await expect(candidate.getByText('Waiting for delivery', { exact: true })).toBeVisible()
  await fixture('adopt')
  await expect(candidate.getByText('Applied', { exact: true })).toBeVisible({ timeout: 15_000 })
  expect(configuration()).toContainEqual({ side: 'left', desired_revision_id: candidateId, generation: 1 })

  await view(page, 'Overview')
  await page.getByRole('button', { name: 'Restore previous', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Restore the previous profile' })
  await expect(review).toContainText('heart_rate.trackingToleranceBpm')
  await review.getByRole('button', { name: 'Restore and request', exact: true }).click()
  const recovery = page.getByRole('group', { name: 'Profile lifecycle' })
  await expect(recovery.locator('[data-segment="requested"]')).toContainText('waiting')
  await fixture('adopt')
  await expect(recovery.locator('[data-segment="requested"]')).toContainText('acknowledged', { timeout: 15_000 })
  await expect(recovery.locator('[data-segment="processor"]')).toContainText('running saved')
  expect(configuration()).toContainEqual({ side: 'left', desired_revision_id: null, generation: 2 })
  expect(configuration().filter(row => row.side === 'right')).toEqual(baseline.filter(row => row.side === 'right'))
  await recovery.screenshot({ path: test.info().outputPath('rollback-receipt.png') })
})

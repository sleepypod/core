import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { test, expect } from './ownerTest'

test.use({ timezoneId: 'UTC' })

test('Tonight and Sleep retain every fragment and leave gaps unclassified', async ({ page, request }, testInfo) => {
  const root = process.env.SLEEPYPOD_BROWSER_FIXTURE
  const databasePath = process.env.BIOMETRICS_DATABASE_URL
  assert(root && databasePath && dirname(resolve(databasePath)) === resolve(root), 'Isolated fixture required')
  const database = new Database(databasePath, { fileMustExist: true })
  const start = new Date()
  start.setUTCDate(start.getUTCDate() - 2)
  start.setUTCHours(22, 0, 0, 0)
  const startSeconds = start.getTime() / 1000
  const hour = 3600
  const windows = [[0, 2], [3, 5], [6, 8]].map(([from, through]) => ({ start: startSeconds + from * hour, end: startSeconds + through * hour }))
  const recordIds: number[] = []
  const vitalIds: number[] = []
  try {
    const record = database.prepare('INSERT INTO sleep_records (side, entered_bed_at, left_bed_at, sleep_duration_seconds, times_exited_bed, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    const vital = database.prepare('INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES (?, ?, ?, ?, ?)')
    database.transaction(() => {
      recordIds.push(Number(record.run('left', startSeconds - 86400, startSeconds - 86400 + 8 * hour, 8 * hour, 0, startSeconds).lastInsertRowid))
      for (const window of windows) {
        recordIds.push(Number(record.run('left', window.start, window.end, window.end - window.start, 1, startSeconds).lastInsertRowid))
        for (let timestamp = window.start; timestamp < window.end; timestamp += 60) {
          vitalIds.push(Number(vital.run('left', timestamp, 60, 40, 14).lastInsertRowid))
        }
      }
      // Empty-bed data in the unknown gap must not become stages or average vitals.
      vitalIds.push(Number(vital.run('left', startSeconds + 2.5 * hour, 120, 1, 30).lastInsertRowid))
    })()
    const recordsBefore = database.prepare('SELECT * FROM sleep_records ORDER BY id').all()
    const vitalsBefore = database.prepare('SELECT * FROM vitals ORDER BY id').all()
    const response = await request.get('/api/biometrics/sleep-stages', {
      headers: { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }, params: { side: 'left', timeZone: 'UTC' },
    })
    expect(response.status()).toBe(200)
    const result = await response.json()
    expect(result.recording).toMatchObject({ recordIds: recordIds.slice(1), durationMs: 6 * hour * 1000, gapsMs: 2 * hour * 1000, exits: 3 })
    expect(result.epochs.length).toBeGreaterThan(0)
    for (const epoch of result.epochs) {
      expect(windows.some(window => epoch.start >= window.start * 1000 && epoch.start + epoch.duration <= window.end * 1000)).toBe(true)
      expect(epoch.heartRate).toBe(60)
    }
    expect(result.totalSleepMs).toBe(result.epochs.reduce((total: number, epoch: { stage: string, duration: number }) => total + (epoch.stage === 'wake' ? 0 : epoch.duration), 0))

    await page.goto('/en')
    await page.getByRole('button', { name: 'Cards', exact: true }).click()
    const tonight = page.locator('a[href="/en/sleep"]').filter({ hasText: 'Last night' })
    await expect(tonight).toContainText('6h')
    await expect(tonight).toContainText('3 segments')
    await tonight.click()
    await expect(page.getByText('Recorded bed time', { exact: true }).locator('..')).toContainText('6h 0m')
    await expect(page.getByText(/3 recording segments · 2h 0m between segments/)).toBeVisible()
    const heartPaths = page.getByTestId('recorded-heart-rate').locator('path')
    await expect(heartPaths).toHaveCount(3)
    for (const path of await heartPaths.all()) await expect(path).toHaveAttribute('fill', 'none')
    await page.screenshot({ path: testInfo.outputPath('complete-night-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByText(/3 recording segments · 2h 0m between segments/)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('complete-night-mobile.png'), fullPage: true })
    expect(database.prepare('SELECT * FROM sleep_records ORDER BY id').all()).toEqual(recordsBefore)
    expect(database.prepare('SELECT * FROM vitals ORDER BY id').all()).toEqual(vitalsBefore)
  }
  finally {
    database.transaction(() => {
      for (const id of vitalIds) database.prepare('DELETE FROM vitals WHERE id = ?').run(id)
      for (const id of recordIds) database.prepare('DELETE FROM sleep_records WHERE id = ?').run(id)
    })()
    database.close()
  }
})

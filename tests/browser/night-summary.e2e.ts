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
  await page.clock.install({ time: new Date('2026-11-07T12:00:00Z') })
  const start = new Date('2026-11-05T22:00:00Z')
  const startSeconds = start.getTime() / 1000
  const hour = 3600
  const windows = [[0, 2], [3, 5], [6, 8]].map(([from, through]) => ({ start: startSeconds + from * hour, end: startSeconds + through * hour }))
  const recordIds: number[] = []
  const vitalIds: number[] = []
  const movementIds: number[] = []
  try {
    const record = database.prepare('INSERT INTO sleep_records (side, entered_bed_at, left_bed_at, sleep_duration_seconds, times_exited_bed, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    const vital = database.prepare('INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES (?, ?, ?, ?, ?)')
    const movement = database.prepare('INSERT INTO movement (side, timestamp, total_movement) VALUES (?, ?, ?)')
    database.transaction(() => {
      recordIds.push(Number(record.run('left', startSeconds - 86400, startSeconds - 86400 + 8 * hour, 8 * hour, 0, startSeconds).lastInsertRowid))
      for (const window of windows) {
        recordIds.push(Number(record.run('left', window.start, window.end, window.end - window.start, 1, startSeconds).lastInsertRowid))
        for (let timestamp = window.start; timestamp < window.end; timestamp += 60) {
          vitalIds.push(Number(vital.run('left', timestamp, 60, 40, 14).lastInsertRowid))
          movementIds.push(Number(movement.run('left', timestamp, window === windows[2] && timestamp < window.start + 20 * 60 ? 10000 : 0).lastInsertRowid))
        }
      }
      // Empty-bed data in the unknown gap must not become stages or average vitals.
      vitalIds.push(Number(vital.run('left', startSeconds + 2.5 * hour, 120, 1, 30).lastInsertRowid))
      movementIds.push(Number(movement.run('left', startSeconds + 2.5 * hour, 10000).lastInsertRowid))
    })()
    const recordsBefore = database.prepare('SELECT * FROM sleep_records ORDER BY id').all()
    const vitalsBefore = database.prepare('SELECT * FROM vitals ORDER BY id').all()
    const movementBefore = database.prepare('SELECT * FROM movement ORDER BY id').all()
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
    expect(result.totalSleepMs).toBeGreaterThan(0)
    expect(result.totalSleepMs).toBeLessThan(result.recording.durationMs)
    const fragment = await request.get('/api/biometrics/sleep-stages', {
      headers: { Authorization: `Bearer ${process.env.SLEEPYPOD_AUTH_TOKEN}` }, params: { side: 'left', sleepRecordId: recordIds[recordIds.length - 1] },
    })
    expect((await fragment.json()).qualityScore).not.toBe(result.qualityScore)

    await page.goto('/en')
    await page.getByRole('button', { name: 'Cards', exact: true }).click()
    const tonight = page.locator('a[href="/en/sleep"]').filter({ hasText: 'Latest night' })
    await expect(tonight).toHaveCount(1)
    await expect(tonight).toContainText('6h')
    await expect(tonight).toContainText('3 segments')
    await tonight.click()
    await expect(page.getByText('Recorded bed time', { exact: true }).locator('..')).toContainText('6h 0m')
    await expect(page.getByText(/3 recording segments · 2h 0m between segments/)).toBeVisible()
    const heartPaths = page.getByTestId('recorded-heart-rate').locator('path')
    await expect(heartPaths).toHaveCount(3)
    for (const path of await heartPaths.all()) await expect(path).toHaveAttribute('fill', 'none')
    await page.screenshot({ path: testInfo.outputPath('complete-night-desktop.png'), fullPage: true })
    const estimatedMinutes = Math.round(result.totalSleepMs / 60000)
    const estimated = `${Math.floor(estimatedMinutes / 60)}h ${estimatedMinutes % 60}m`
    await expect(page.getByText('Estimated sleep · recorded segments', { exact: true }).locator('..')).toContainText(estimated)
    await expect(page.getByTestId('night-card').getByText(String(result.qualityScore), { exact: true })).toHaveCount(2)
    const stageGeometry = () => page.locator('[data-testid="night-hypnogram"]:visible span.absolute[style*="background"]').evaluateAll(elements => elements.map((element) => {
      const style = (element as HTMLElement).style
      return { left: style.left, width: style.width, color: style.background }
    }))
    const nightGeometry = await stageGeometry()
    expect(nightGeometry.length).toBeGreaterThan(1)
    await page.getByRole('tab', { name: 'Week', exact: true }).click()
    const detail = page.getByTestId('week-night-detail')
    await expect(detail).toContainText(`10:00 PM → 6:00 AM · 6h 0m recorded · quality ${result.qualityScore}`)
    await expect(detail).toContainText(`Estimated sleep · recorded segments: ${estimated}`)
    await expect(detail).toContainText('3 recording segments · 2h 0m between segments')
    await expect(page.getByRole('button', { name: new RegExp(`Thu 5.*Q ${result.qualityScore}`) })).toBeVisible()
    expect(await stageGeometry()).toEqual(nightGeometry)
    await expect(page.getByText('Asleep', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Time still', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Movement during recorded periods')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('complete-week-desktop.png'), fullPage: true })
    await page.getByRole('tab', { name: 'Month', exact: true }).click()
    await expect(page.getByTestId('day-2026-11-05')).toContainText('6h 0m')
    await expect(page.getByText('Avg recorded time').first().locator('..')).toContainText('7.0h')
    await expect(page.getByText('Average recorded time by week')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('complete-month-desktop.png'), fullPage: true })
    await page.getByRole('tab', { name: 'Night', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByText(/3 recording segments · 2h 0m between segments/)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('complete-night-mobile.png'), fullPage: true })
    await page.getByRole('tab', { name: 'Week', exact: true }).click()
    await expect(detail).toContainText(`6h 0m recorded · quality ${result.qualityScore}`)
    expect(await stageGeometry()).toEqual(nightGeometry)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('complete-week-mobile.png'), fullPage: true })
    await page.getByRole('tab', { name: 'Month', exact: true }).click()
    await expect(page.getByTestId('day-2026-11-05')).toContainText('6.0')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(database.prepare('SELECT * FROM sleep_records ORDER BY id').all()).toEqual(recordsBefore)
    expect(database.prepare('SELECT * FROM vitals ORDER BY id').all()).toEqual(vitalsBefore)
    expect(database.prepare('SELECT * FROM movement ORDER BY id').all()).toEqual(movementBefore)
  }
  finally {
    database.transaction(() => {
      for (const id of vitalIds) database.prepare('DELETE FROM vitals WHERE id = ?').run(id)
      for (const id of movementIds) database.prepare('DELETE FROM movement WHERE id = ?').run(id)
      for (const id of recordIds) database.prepare('DELETE FROM sleep_records WHERE id = ?').run(id)
    })()
    database.close()
  }
})

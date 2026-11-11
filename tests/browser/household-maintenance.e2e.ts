import { test, expect, type Page } from '@playwright/test'
import { mockPersonal } from './personal-fixture'
import examples from '../../src/household/fixtures/arrangement-review-v1.json' with { type: 'json' }
import controls from '../../src/household/fixtures/personal-controls-v1.json' with { type: 'json' }
import type { ArrangementMaintenanceStatus } from '../../src/household/arrangementMaintenanceContract'

const operationId = '10000000-0000-4000-8000-000000000088'
const receiptId = '10000000-0000-4000-8000-000000000089'
const emptyBed = 'The bed is empty, the cover is connected, the reservoir is filled, and I am beside the bed.'

// All device routes are intercepted; these checks never start a physical transition.
async function maintenanceFixture(page: Page, initial: 'empty' | 'held' | 'committed' = 'committed') {
  const base = await mockPersonal(page)
  const session = base.session
  Object.assign(session.capabilities, { arrangementMaintenance: true, arrangementReview: true, activateArrangement: true })
  const review = { ...structuredClone(examples.ownerReview), sleeperId: session.selfSleeperId,
    state: 'approved_for_separate_activation', canActivate: true, canApprove: false,
    createdAt: Date.now() - 2000, expiresAt: Date.now() + 3_600_000,
    self: { ...examples.ownerReview.self, approved: true }, partner: { ...examples.ownerReview.partner, approved: true } }
  const assigned = () => {
    Object.assign(session, { assignmentRevision: 2, sessionRevision: 2 })
    Object.assign(session.arrangement, { mode: 'assigned' })
    Object.assign(session.self, { assignment: 'right', zones: ['right'] })
  }
  if (initial === 'committed') assigned()
  let operation: ArrangementMaintenanceStatus['operation'] = initial === 'empty'
    ? null
    : {
        operationId, reviewId: review.reviewId, state: initial, createdAt: Date.now() - 1000,
        committedAt: initial === 'committed' ? Date.now() - 500 : null,
        controllerRestarted: false, admission: 'held_for_this_transition', recovery: null, cancellation: null, restart: null,
      }
  let loseRestart = false
  let readGate: Promise<void> | null = null
  const posts: Array<{ path: string, body: Record<string, unknown> }> = []
  await page.route('**/api/v1/me/bed', (route) => {
    const bed = structuredClone(controls.soloBed)
    Object.assign(bed.scope, { sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision, assignmentRevision: session.assignmentRevision })
    if (session.arrangement.mode === 'assigned') {
      Object.assign(bed, { arrangement: 'assigned', zones: bed.zones.filter(zone => zone.side === 'right'),
        routing: { temperature: ['right'], power: ['right'], vibrationCancellation: ['right'], scheduledVibration: ['right'], routines: 'right' } })
    }
    bed.observation.observedAt = Date.now()
    return route.fulfill({ json: bed })
  })
  await page.route('**/api/v1/household/arrangement', route => route.fulfill({ json: { version: 1, review } }))
  await page.route('**/api/v1/household/transition**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'GET') {
      if (readGate) await readGate
      if (path.endsWith('/cancellation-preview')) return route.fulfill({ json: { operationId: operation?.operationId,
        expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision,
        observedAt: Date.now(), controlDigest: 'a'.repeat(64) } })
      return route.fulfill({ json: { version: 1, observedAt: Date.now(), expectedSessionRevision: session.sessionRevision,
        expectedAssignmentRevision: session.assignmentRevision, operation } })
    }
    const body = request.postDataJSON()
    posts.push({ path, body })
    if (path === '/api/v1/household/transition') {
      assigned()
      operation = { operationId: body.requestId, reviewId: review.reviewId, state: 'committed', createdAt: Date.now(),
        committedAt: Date.now(), controllerRestarted: false, admission: 'held_for_this_transition', recovery: null, cancellation: null, restart: null }
      return route.fulfill({ json: { receipt: { operationId: operation.operationId, reviewId: review.reviewId, state: 'committed',
        createdAt: operation.createdAt, committedAt: operation.committedAt, hardware: 'held_for_runtime_recovery', admissionRevision: 2 }, recovered: false, replayed: false } })
    }
    if (!operation) throw new Error('Missing fixture transition')
    if (path.endsWith('/restart')) {
      operation.restart = { operationId: operation.operationId, requestId: body.requestId, state: 'submitted',
        requestedAt: Date.now(), resultAt: Date.now(), hardware: 'held_for_runtime_recovery', replayAllowed: false }
      if (loseRestart) return route.abort('failed')
      return route.fulfill({ json: { receipt: operation.restart, replayed: false } })
    }
    const receipt = { operationId: operation.operationId, requestId: body.requestId, reviewId: operation.reviewId,
      completedAt: Date.now(), admissionRevision: 3, hardware: 'admission_released', physicalMovement: 'not_requested' } as const
    if (path.endsWith('/recover')) {
      operation.state = 'completed'
      operation.admission = 'open'
      operation.recovery = { ...receipt, state: 'completed', epochId: receiptId, recordingStartsAt: Date.now() }
      return route.fulfill({ json: { receipt: operation.recovery, automaticServices: 'resumed', replayed: false } })
    }
    operation.state = 'cancelled'
    operation.admission = 'open'
    operation.cancellation = { ...receipt, state: 'cancelled', controlDigest: 'a'.repeat(64), arrangement: 'solo-anywhere' }
    return route.fulfill({ json: { receipt: operation.cancellation, automaticServices: 'unavailable', replayed: false } })
  })
  return { base, session, posts,
    restarted: () => { if (operation) operation.controllerRestarted = true },
    loseRestart: () => { loseRestart = true },
    gate: (pending: Promise<void> | null) => { readGate = pending },
  }
}

test('account editors wait for the initial transition check before becoming available', async ({ page }) => {
  const fixture = await maintenanceFixture(page, 'empty')
  let finishRead!: () => void
  fixture.gate(new Promise<void>((resolve) => {
    finishRead = resolve
  }))
  await page.goto('/household/index.html')
  const panel = page.getByRole('article', { name: 'Side change maintenance' })
  await expect(panel).toBeVisible()
  await expect(page.locator('#personal-editors')).toBeHidden()
  await expect(page.locator('#personal-editors')).toHaveJSProperty('inert', true)
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply my target' })).toHaveCount(0)
  finishRead()
  fixture.gate(null)
  await expect(page.getByRole('button', { name: 'Save my preferences' })).toBeVisible()
  await expect(page.locator('#personal-editors')).toHaveJSProperty('inert', false)
  await expect(page.getByRole('button', { name: 'Apply my target' })).toBeVisible()
  expect(fixture.posts).toEqual([])
  expect(fixture.base.posts).toEqual([])
})

test('saved transition closes old controls, survives a lost restart, and reopens only the assigned side', async ({ page }) => {
  const fixture = await maintenanceFixture(page)
  fixture.loseRestart()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/household/index.html')
  const panel = page.getByRole('article', { name: 'Side change maintenance' })
  await expect(panel.getByRole('heading', { name: 'Finish your side change' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply my target' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save my preferences' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Sign out here' })).toBeEnabled()
  expect(fixture.posts).toEqual([])
  const restart = panel.getByRole('button', { name: 'Request controller restart' })
  await expect(restart).toBeDisabled()
  await panel.getByLabel(emptyBed).check()
  await panel.getByLabel('The connection may close while the controller restarts.').check()
  await expect(restart).toBeDisabled()
  await panel.getByLabel('Bed commands stay paused until the next attended check.').check()
  await restart.click()
  await expect(panel.getByRole('alert')).toContainText('not be resent')
  await panel.getByRole('button', { name: 'Check saved transition' }).click()
  await expect(panel).toContainText('A restart request is already saved')
  await expect(restart).toHaveCount(0)
  await page.reload()
  await expect(panel).toContainText('A restart request is already saved')
  expect(fixture.posts).toHaveLength(1)
  fixture.restarted()
  await panel.getByRole('button', { name: 'Check saved transition' }).click()
  await expect(panel.getByRole('checkbox')).toHaveCount(4)
  for (const checkbox of await panel.getByRole('checkbox').all()) await checkbox.check()
  await panel.getByRole('button', { name: 'Finish recovery' }).click()
  await expect(panel).toContainText('resumed its routine services')
  await expect(page.getByRole('button', { name: 'Apply my target' })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Return to my controls' }).click()
  await expect(page.getByRole('button', { name: 'Apply my target' })).toBeVisible()
  await expect(page.locator('.bed-zone')).toHaveCount(1)
  await expect(page.locator('.bed-zone h3')).toHaveText('Right')
  await expect(page.getByRole('button', { name: 'Save my preferences' })).toBeVisible()
  expect(fixture.posts.map(value => value.path)).toEqual(['/api/v1/household/transition/restart', '/api/v1/household/transition/recover'])
  expect(fixture.base.posts).toEqual([])
  expect(fixture.base.unexpected).toEqual([])
  expect(errors).toEqual([])
})

test('activation requires both approval data and fresh attended confirmations, then retires old editors', async ({ page }) => {
  const fixture = await maintenanceFixture(page, 'empty')
  await page.goto('/household/index.html')
  await page.getByRole('button', { name: 'Check current side review' }).click()
  const panel = page.getByRole('article', { name: 'Side change maintenance' })
  const start = panel.getByRole('button', { name: 'Start reviewed side change' })
  await expect(start).toBeDisabled()
  await expect(panel.getByRole('checkbox')).toHaveCount(4)
  for (const checkbox of await panel.getByRole('checkbox').all()) await checkbox.check()
  await start.click()
  await expect(panel).toContainText('Side transition saved')
  await expect(page.getByRole('button', { name: 'Apply my target' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Create a 30-minute invitation' })).toBeHidden()
  await expect(panel.getByRole('button', { name: 'Request controller restart' })).toBeDisabled()
  expect(fixture.posts).toHaveLength(1)
  expect(fixture.posts[0].body).toMatchObject({ confirmEmptyAndAttended: true, acknowledgeHeldUntilRecovery: true,
    expectedAssignmentRevision: 1 })
})

test('held transition offers cancellation only after restart and explicitly reports unavailable routines', async ({ page }) => {
  const fixture = await maintenanceFixture(page, 'held')
  await page.goto('/household/index.html')
  const panel = page.getByRole('article', { name: 'Side change maintenance' })
  await expect(panel.getByRole('button', { name: 'Request controller restart' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Review keeping solo arrangement' })).toHaveCount(0)
  fixture.restarted()
  await panel.getByRole('button', { name: 'Check saved transition' }).click()
  await panel.getByRole('button', { name: 'Review keeping solo arrangement' }).click()
  await expect(panel.getByRole('button', { name: 'Keep solo and release pause' })).toBeDisabled()
  for (const checkbox of await panel.getByRole('checkbox').all()) await checkbox.check()
  await panel.getByRole('button', { name: 'Keep solo and release pause' }).click()
  await expect(panel).toContainText('Routine-service startup is not confirmed')
  expect(fixture.posts.map(value => value.path)).toEqual(['/api/v1/household/transition/cancel'])
  await panel.getByRole('button', { name: 'Return to my controls' }).click()
  await expect(page.locator('.bed-zone')).toHaveCount(2)
})

test('backgrounding clears confirmations, and account invalidation cannot restore a late maintenance reply', async ({ page }) => {
  const fixture = await maintenanceFixture(page)
  await page.goto('/household/index.html')
  const panel = page.getByRole('article', { name: 'Side change maintenance' })
  await panel.getByLabel(emptyBed).check()
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(panel.getByRole('checkbox')).toHaveCount(0)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await panel.getByRole('button', { name: 'Check saved transition' }).click()
  await expect(panel.getByLabel(emptyBed)).not.toBeChecked()
  let release!: () => void
  fixture.gate(new Promise<void>((resolve) => {
    release = resolve
  }))
  await panel.getByRole('button', { name: 'Check saved transition' }).click()
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'sleepypod-account-change' })))
  release()
  await expect(page.getByText('The account changed in another tab.', { exact: false })).toBeVisible()
  await expect(panel).toHaveCount(0)
  expect(fixture.posts).toEqual([])
})

test('attended recovery is readable on phone and desktop with large text and dark appearance', async ({ page }) => {
  const fixture = await maintenanceFixture(page)
  fixture.restarted()
  await page.goto('/household/index.html')
  const panel = page.getByRole('article', { name: 'Side change maintenance' })
  await expect(panel.getByRole('button', { name: 'Finish recovery' })).toBeVisible()
  await panel.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('maintenance-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.addStyleTag({ content: ':root{font-size:24px}' })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await panel.getByLabel(emptyBed).check()
  await expect(panel.getByLabel(emptyBed)).toBeChecked()
  await page.screenshot({ path: test.info().outputPath('maintenance-phone-dark-large.png'), fullPage: true })
  expect(fixture.posts).toEqual([])
})

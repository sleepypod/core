/**
 * Automations page reads: night dedupe/labels, the activity log, who controls
 * each side tonight, and the multi-night backtest range. Both DBs are
 * queue-backed `.all()` mocks (each select pops the next queued row-set in call
 * order); the engine, controller and backtester are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

function queue() {
  return {
    rows: [] as unknown[][],
    pop(): unknown[] { return this.rows.shift() ?? [] },
  }
}

const states = vi.hoisted(() => ({ primary: queue(), biometrics: queue() }))

function makeDbMock(state: ReturnType<typeof queue>) {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'orderBy', 'limit', 'leftJoin', 'values', 'set', 'returning', 'onConflictDoUpdate']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.all = vi.fn(() => state.pop())
  chain.run = vi.fn(() => undefined)
  return { chain, select: vi.fn(() => chain), insert: vi.fn(() => chain), update: vi.fn(() => chain), delete: vi.fn(() => chain) }
}

const primaryDb = vi.hoisted(() => makeDbMock(states.primary))
const biometricsDb = vi.hoisted(() => makeDbMock(states.biometrics))
const control = vi.hoisted(() => ({ status: undefined as unknown }))
const backtest = vi.hoisted(() => ({ run: vi.fn() }))

vi.mock('@/src/db', () => ({ db: primaryDb, biometricsDb }))
vi.mock('@/src/automation', () => ({ getAutomationEngineIfRunning: () => null }))
vi.mock('@/src/automation/backtest', () => ({ runBacktest: backtest.run }))
vi.mock('@/src/temperature/instance', () => ({ getTemperatureControlStatus: () => control.status }))

const { automationsRouter } = await import('@/src/server/routers/automations')
const caller = automationsRouter.createCaller({})

beforeEach(() => {
  states.primary.rows.length = 0
  states.biometrics.rows.length = 0
  control.status = undefined
  backtest.run.mockReset()
})

const rule = {
  id: 1,
  name: 'Ambient demo',
  enabled: true,
  side: null,
  priority: 0,
  dryRun: true,
  cooldownMin: 30,
  trigger: { kind: 'tick', everyMin: 1 },
  conditions: { kind: 'and', conditions: [{ kind: 'timeBetween', start: '23:00', end: '06:00' }] },
  actions: [{ kind: 'notify', message: 'x' }],
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

describe('automations.nights', () => {
  it('keeps one tab per night (the longest session) and names it by the night it started', async () => {
    states.biometrics.rows.push([
      // Two sessions the same night: 00:30 is still the previous evening's night.
      { id: 9, enteredBedAt: new Date(2026, 8, 28, 0, 30), leftBedAt: new Date(2026, 8, 28, 2, 0) },
      { id: 8, enteredBedAt: new Date(2026, 8, 27, 22, 0), leftBedAt: new Date(2026, 8, 28, 0, 10) },
      { id: 7, enteredBedAt: new Date(2026, 8, 26, 23, 0), leftBedAt: new Date(2026, 8, 27, 7, 0) },
    ])
    const out = await caller.nights({ side: 'left', limit: 5 })
    expect(out.map(n => [n.sleepRecordId, n.label, n.date])).toEqual([
      [8, 'Last night', 'Sep 27'],
      [7, 'Sat', 'Sep 26'],
    ])
  })
})

describe('automations.activity', () => {
  it('collapses same-reason skips per night and classifies outside-window runs', async () => {
    const tonight = new Date(2026, 8, 28, 18).getTime()
    const last = new Date(2026, 8, 27, 18).getTime()
    states.primary.rows.push([rule]) // automations
    states.primary.rows.push([{ tz: Intl.DateTimeFormat().resolvedOptions().timeZone }]) // timezone
    const skip = (d: Date) => ({ automationId: 1, firedAt: d, outcome: 'skipped', detail: { reason: 'condition-false' } })
    states.primary.rows.push([
      skip(new Date(2026, 8, 27, 20, 0)),
      skip(new Date(2026, 8, 27, 20, 1)),
      { automationId: 1, firedAt: new Date(2026, 8, 27, 23, 30), outcome: 'dry_run', detail: { actions: [{ kind: 'setTemperature', side: 'left', dryRun: true, temp: 76 }] } },
      skip(new Date(2026, 8, 28, 19, 0)),
    ])
    states.primary.rows.push([{ side: 'left', temperature: 81, startedAt: new Date(2026, 8, 28, 18, 31).getTime(), expiresAt: new Date(2026, 8, 28, 19, 15).getTime() }])

    const out = await caller.activity({ nightStarts: [last, tonight] })
    expect(out.nights.map(n => n.start)).toEqual([tonight, last])
    expect(out.nights[0].entries).toEqual([
      expect.objectContaining({ ruleName: 'Ambient demo', outcome: 'skipped', code: 'outside-window', count: 1 }),
    ])
    expect(out.nights[1].entries).toEqual([
      expect.objectContaining({ outcome: 'dry_run', code: 'set-temperature', temp: 76, sides: ['left'] }),
      expect.objectContaining({ outcome: 'skipped', code: 'outside-window', count: 2, start: new Date(2026, 8, 27, 20, 0).getTime(), end: new Date(2026, 8, 27, 20, 1).getTime() }),
    ])
    expect(out.holds).toEqual([expect.objectContaining({ side: 'left', temperature: 81 })])
  })
})

describe('automations.tonight', () => {
  it('reports the owner, the live hold and the last setpoint autopilot sent per side', async () => {
    const now = Date.now()
    control.status = {
      left: { source: 'manual', requestId: 'm', targetTemperature: 81, holdUntil: now + 60_000, blocked: null },
      right: { source: 'autopilot', requestId: 'r', targetTemperature: 78, holdUntil: null, blocked: null },
    }
    states.primary.rows.push([
      { side: 'left', temperature: 81, startedAt: now - 60_000, expiresAt: now + 60_000 },
      { side: 'right', temperature: 70, startedAt: now - 7_200_000, expiresAt: now - 3_600_000 },
    ])
    states.primary.rows.push([]) // run-once sessions
    states.primary.rows.push([
      { firedAt: new Date(now - 600_000), ruleName: 'Cool when restless', detail: { actions: [{ kind: 'setTemperature', side: 'right', sent: true, temp: 78 }] } },
    ])
    const out = await caller.tonight({})
    expect(out.sides.left.control?.source).toBe('manual')
    expect(out.sides.left.hold).toMatchObject({ temperature: 81 })
    expect(out.sides.right.hold).toBeNull()
    expect(out.sides.right.lastAutopilot).toMatchObject({ ruleName: 'Cool when restless', temp: 78 })
    expect(out.sides.left.lastAutopilot).toBeNull()
  })
})

describe('automations.backtestRange', () => {
  it('folds would-fire counts and the compared value range over recorded nights', async () => {
    states.primary.rows.push([{ tz: 'America/Los_Angeles' }])
    states.biometrics.rows.push([
      { id: 2, enteredBedAt: new Date(2026, 8, 27, 23), leftBedAt: new Date(2026, 8, 28, 7) },
      { id: 1, enteredBedAt: new Date(2026, 8, 26, 23), leftBedAt: new Date(2026, 8, 27, 7) },
    ])
    backtest.run
      .mockReturnValueOnce({ threshold: 200, avg: { values: [6, null, 40] }, primary: null, summary: { wouldFire: 1 } })
      .mockReturnValueOnce({ threshold: 200, avg: { values: [12, 64] }, primary: null, summary: { wouldFire: 0 } })
    const out = await caller.backtestRange({
      nights: 5,
      rule: { side: 'left', trigger: { kind: 'tick', everyMin: 1 }, conditions: { kind: 'and', conditions: [] }, actions: [{ kind: 'notify', message: 'x' }] },
    })
    expect(out).toEqual({ nights: 2, wouldFire: 1, peak: 64, low: 6, threshold: 200 })
    expect(backtest.run).toHaveBeenCalledTimes(2)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function queuedChainState() {
  return {
    queue: [] as unknown[][],
    error: undefined as unknown,
    shouldThrow: false,
    pop(): unknown[] {
      if (this.shouldThrow) {
        this.shouldThrow = false
        throw this.error
      }
      return this.queue.shift() ?? []
    },
  }
}

const states = vi.hoisted(() => ({
  primary: queuedChainState(),
  biometrics: queuedChainState(),
}))

function makeDbMock(state: ReturnType<typeof queuedChainState>) {
  const chain: Record<string, unknown> = {}
  for (const method of [
    'from', 'where', 'orderBy', 'limit', 'leftJoin', 'values', 'set', 'returning',
    'onConflictDoUpdate',
  ]) {
    chain[method] = vi.fn(() => chain)
  }
  chain.all = vi.fn(() => state.pop())
  chain.run = vi.fn(() => undefined)
  return {
    chain,
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
  }
}

const primaryDb = vi.hoisted(() => makeDbMock(states.primary))
const biometricsDb = vi.hoisted(() => makeDbMock(states.biometrics))

const engine = vi.hoisted(() => ({
  reload: vi.fn(),
  setGlobalEnabled: vi.fn(),
  current: null as null | {
    reload: (...args: unknown[]) => unknown
    setGlobalEnabled: (...args: unknown[]) => unknown
  },
  get: vi.fn(),
}))

const backtest = vi.hoisted(() => ({
  run: vi.fn(),
}))

vi.mock('@/src/db', () => ({ db: primaryDb, biometricsDb }))
vi.mock('@/src/automation', () => ({ getAutomationEngineIfRunning: engine.get }))
vi.mock('@/src/automation/backtest', () => ({ runBacktest: backtest.run }))

const { automationsRouter } = await import('@/src/server/routers/automations')
const caller = automationsRouter.createCaller({})

const trigger = { kind: 'tick' as const, everyMin: 5 }
const conditions = { kind: 'and' as const, conditions: [] }
const actions = [{ kind: 'notify' as const, message: 'Temperature adjusted' }]
const createdAt = new Date('2026-07-19T20:00:00Z')
const updatedAt = new Date('2026-07-19T21:00:00Z')

function automationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'Cool sleeping side',
    enabled: true,
    side: 'left' as const,
    priority: 12,
    dryRun: false,
    cooldownMin: 30,
    trigger,
    conditions,
    actions,
    createdAt,
    updatedAt,
    ...overrides,
  }
}

function resetDb(mock: typeof primaryDb): void {
  for (const fn of [mock.select, mock.insert, mock.update, mock.delete]) fn.mockClear()
  for (const value of Object.values(mock.chain)) {
    if (typeof value === 'function' && 'mockClear' in value) {
      (value as ReturnType<typeof vi.fn>).mockClear()
    }
  }
}

beforeEach(() => {
  for (const state of Object.values(states)) {
    state.queue.length = 0
    state.error = undefined
    state.shouldThrow = false
  }
  resetDb(primaryDb)
  resetDb(biometricsDb)
  engine.reload.mockReset().mockResolvedValue(undefined)
  engine.setGlobalEnabled.mockReset()
  engine.current = { reload: engine.reload, setGlobalEnabled: engine.setGlobalEnabled }
  engine.get.mockReset().mockImplementation(() => engine.current)
  backtest.run.mockReset().mockReturnValue({ events: [], primary: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('automations CRUD', () => {
  it('lists rules in priority order and preserves the complete AST', async () => {
    states.primary.queue.push([automationRow(), automationRow({ id: 8, side: null, name: 'Second' })])

    const result = await caller.list({})
    expect(result).toEqual([automationRow(), automationRow({ id: 8, side: null, name: 'Second' })])
    expect(primaryDb.chain.orderBy).toHaveBeenCalledWith(expect.anything(), expect.anything())
  })

  it.each([
    [new Error('sqlite busy'), 'sqlite busy'],
    ['database unavailable', 'Unknown error'],
  ])('wraps list failure %#', async (failure, message) => {
    states.primary.shouldThrow = true
    states.primary.error = failure
    await expect(caller.list({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Failed to list automations: ${message}`,
    })
  })

  it('gets one rule by id', async () => {
    states.primary.queue.push([automationRow()])
    await expect(caller.get({ id: 7 })).resolves.toEqual(automationRow())
    expect(primaryDb.chain.where).toHaveBeenCalledOnce()
  })

  it('throws NOT_FOUND for a missing rule', async () => {
    states.primary.queue.push([])
    await expect(caller.get({ id: 404 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Automation 404 not found',
    })
  })

  it('creates a rule with safe defaults, awaits reload, and returns the row', async () => {
    const row = automationRow({ enabled: true, side: null, priority: 0, dryRun: true, cooldownMin: null })
    states.primary.queue.push([row])

    await expect(caller.create({ name: row.name, trigger, conditions, actions })).resolves.toEqual(row)
    expect(primaryDb.chain.values).toHaveBeenCalledWith({
      name: row.name,
      enabled: true,
      side: null,
      priority: 0,
      dryRun: true,
      cooldownMin: null,
      trigger,
      conditions,
      actions,
    })
    expect(engine.reload).toHaveBeenCalledOnce()
  })

  it('preserves Create returned no row as an INTERNAL_SERVER_ERROR', async () => {
    states.primary.queue.push([])
    await expect(caller.create({ name: 'No row', trigger, conditions, actions })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Create returned no row',
    })
  })

  it.each([
    [new Error('insert failed'), 'insert failed'],
    [{ failed: true }, 'Unknown error'],
  ])('wraps create database failure %#', async (failure, message) => {
    states.primary.shouldThrow = true
    states.primary.error = failure
    await expect(caller.create({ name: 'Failure', trigger, conditions, actions })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Failed to create automation: ${message}`,
    })
  })

  it('updates only supplied fields and stamps updatedAt', async () => {
    const row = automationRow({ name: 'Renamed', priority: 22 })
    states.primary.queue.push([row])

    await expect(caller.update({ id: 7, name: 'Renamed', priority: 22 })).resolves.toEqual(row)
    expect(primaryDb.chain.set).toHaveBeenCalledWith({
      name: 'Renamed',
      enabled: true,
      side: null,
      priority: 22,
      dryRun: true,
      cooldownMin: null,
      updatedAt: expect.any(Date),
    })
    expect(engine.reload).toHaveBeenCalledOnce()
  })

  it('preserves update NOT_FOUND and wraps non-TRPC failures', async () => {
    states.primary.queue.push([])
    await expect(caller.update({ id: 91, name: 'Missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Automation 91 not found',
    })

    states.primary.shouldThrow = true
    states.primary.error = 'update failed'
    await expect(caller.update({ id: 7, name: 'Broken' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update automation: Unknown error',
    })
  })

  it('sets enabled exactly and reloads', async () => {
    const row = automationRow({ enabled: false })
    states.primary.queue.push([row])
    await expect(caller.setEnabled({ id: 7, enabled: false })).resolves.toEqual(row)
    expect(primaryDb.chain.set).toHaveBeenCalledWith({ enabled: false, updatedAt: expect.any(Date) })
    expect(engine.reload).toHaveBeenCalledOnce()
  })

  it('sets dry-run exactly and reloads', async () => {
    const row = automationRow({ dryRun: true })
    states.primary.queue.push([row])
    await expect(caller.setDryRun({ id: 7, dryRun: true })).resolves.toEqual(row)
    expect(primaryDb.chain.set).toHaveBeenCalledWith({ dryRun: true, updatedAt: expect.any(Date) })
    expect(engine.reload).toHaveBeenCalledOnce()
  })

  it.each(['setEnabled', 'setDryRun'] as const)('%s reports a missing row', async (procedure) => {
    states.primary.queue.push([])
    await expect(caller[procedure]({ id: 81, [procedure === 'setEnabled' ? 'enabled' : 'dryRun']: true } as never))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Automation 81 not found' })
  })

  it('deletes an existing rule, reloads, and returns literal success', async () => {
    states.primary.queue.push([automationRow()])
    await expect(caller.delete({ id: 7 })).resolves.toEqual({ success: true })
    expect(primaryDb.delete).toHaveBeenCalledOnce()
    expect(engine.reload).toHaveBeenCalledOnce()
  })

  it('reports a missing delete target', async () => {
    states.primary.queue.push([])
    await expect(caller.delete({ id: 87 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Automation 87 not found',
    })
  })

  it('logs a reload failure after persistence without failing the mutation', async () => {
    states.primary.queue.push([automationRow()])
    engine.reload.mockRejectedValueOnce(new Error('engine stopped'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(caller.setEnabled({ id: 7, enabled: true })).resolves.toEqual(automationRow())
    expect(error).toHaveBeenCalledWith('[automations] engine reload failed:', expect.any(Error))
  })

  it('works when no automation engine is running', async () => {
    states.primary.queue.push([automationRow()])
    engine.current = null
    await expect(caller.setDryRun({ id: 7, dryRun: false })).resolves.toEqual(automationRow())
    expect(engine.reload).not.toHaveBeenCalled()
  })
})

describe('automations kill switch, runs, and status', () => {
  it.each([
    [[], true],
    [[{ on: false }], false],
    [[{ on: true }], true],
  ])('reads kill-switch rows %#', async (rows, enabled) => {
    states.primary.queue.push(rows)
    await expect(caller.getKillSwitch({})).resolves.toEqual({ enabled })
  })

  it.each([true, false])('persists and applies kill-switch=%s', async (enabled) => {
    await expect(caller.setKillSwitch({ enabled })).resolves.toEqual({ enabled })
    expect(primaryDb.chain.values).toHaveBeenCalledWith({ id: 1, autopilotEnabled: enabled })
    expect(primaryDb.chain.onConflictDoUpdate).toHaveBeenCalledWith({
      target: expect.anything(),
      set: { autopilotEnabled: enabled, updatedAt: expect.any(Date) },
    })
    expect(primaryDb.chain.run).toHaveBeenCalledOnce()
    expect(engine.setGlobalEnabled).toHaveBeenCalledWith(enabled)
  })

  it('sets the kill switch without a running engine', async () => {
    engine.current = null
    await expect(caller.setKillSwitch({ enabled: false })).resolves.toEqual({ enabled: false })
    expect(primaryDb.chain.run).toHaveBeenCalledOnce()
    expect(engine.setGlobalEnabled).not.toHaveBeenCalled()
  })

  it('lists recent run rows with the default limit and no filter', async () => {
    const run = {
      id: 11,
      automationId: 7,
      ruleName: 'Cool sleeping side',
      firedAt: new Date('2026-07-20T00:00:00Z'),
      outcome: 'fired' as const,
      detail: { target: 68 },
    }
    states.primary.queue.push([run])
    await expect(caller.runs({})).resolves.toEqual([run])
    expect(primaryDb.chain.where).toHaveBeenCalledWith(undefined)
    expect(primaryDb.chain.limit).toHaveBeenCalledWith(100)
  })

  it('filters runs by automation id and accepts the upper limit boundary', async () => {
    states.primary.queue.push([])
    await expect(caller.runs({ automationId: 7, limit: 500 })).resolves.toEqual([])
    expect(primaryDb.chain.where).not.toHaveBeenCalledWith(undefined)
    expect(primaryDb.chain.limit).toHaveBeenCalledWith(500)
  })

  it.each([0, 501])('rejects run limit %i', async (limit) => {
    await expect(caller.runs({ limit })).rejects.toThrow()
  })

  it('builds live status with last outcomes, null fallbacks, and today counts', async () => {
    const second = automationRow({ id: 8, name: 'Second', side: null, cooldownMin: null })
    const firedAt = new Date('2026-07-20T00:30:00Z')
    states.primary.queue.push([{ on: false }])
    states.primary.queue.push([automationRow(), second])
    states.primary.queue.push([{ outcome: 'clamped', firedAt }])
    states.primary.queue.push([{ firedAt }, { firedAt }])
    states.primary.queue.push([])
    states.primary.queue.push([])

    await expect(caller.status({})).resolves.toEqual({
      globalEnabled: false,
      rules: [
        {
          id: 7,
          name: 'Cool sleeping side',
          enabled: true,
          dryRun: false,
          side: 'left',
          cooldownMin: 30,
          lastOutcome: 'clamped',
          lastFiredAt: firedAt,
          firesToday: 2,
        },
        {
          id: 8,
          name: 'Second',
          enabled: true,
          dryRun: false,
          side: null,
          cooldownMin: null,
          lastOutcome: null,
          lastFiredAt: null,
          firesToday: 0,
        },
      ],
    })
  })
})

describe('automations nights and historical series', () => {
  it('labels the newest night and later nights, preserving exact timestamps', async () => {
    const newest = { id: 4, enteredBedAt: new Date('2026-07-19T20:00:00Z'), leftBedAt: new Date('2026-07-20T04:00:00Z') }
    const older = { id: 3, enteredBedAt: new Date('2026-07-18T20:00:00Z'), leftBedAt: new Date('2026-07-19T04:00:00Z') }
    states.biometrics.queue.push([newest, older])

    const result = await caller.nights({ side: 'left', limit: 30 })
    expect(result).toEqual([
      {
        sleepRecordId: 4,
        label: 'Last night',
        date: 'Jul 19',
        startMs: newest.enteredBedAt.getTime(),
        endMs: newest.leftBedAt.getTime(),
      },
      {
        sleepRecordId: 3,
        label: 'Sat',
        date: 'Jul 18',
        startMs: older.enteredBedAt.getTime(),
        endMs: older.leftBedAt.getTime(),
      },
    ])
    expect(biometricsDb.chain.limit).toHaveBeenCalledWith(30)
  })

  it.each([0, 31])('rejects nights limit %i', async (limit) => {
    await expect(caller.nights({ side: 'left', limit })).rejects.toThrow()
  })

  it('loads and converts every historical signal passed to the backtester', async () => {
    const start = new Date('2026-07-19T20:00:00Z')
    const end = new Date('2026-07-20T04:00:00Z')
    const t = new Date('2026-07-19T21:00:00Z')
    states.biometrics.queue.push([{ enteredBedAt: start, leftBedAt: end }])
    states.biometrics.queue.push([{ t, v: 9 }])
    states.biometrics.queue.push([
      { t, hr: 61, hrv: 42, br: 14 },
      { t: new Date(t.getTime() + 1), hr: null, hrv: null, br: null },
    ])
    states.biometrics.queue.push([{
      t,
      amb: 2000,
      hum: 4550,
      o: 2000,
      c: 2200,
      n: 2400,
    }])
    states.biometrics.queue.push([{ t, w: 1800 }])
    states.biometrics.queue.push([{ t, lux: 3.5 }])
    states.biometrics.queue.push([{ t, level: 'low' }, { t: new Date(t.getTime() + 1), level: 'ok' }])
    states.biometrics.queue.push([{ t, max: 100, mean: 60, spread: 40 }])
    states.primary.queue.push([{ tz: 'America/New_York' }])

    await caller.backtest({
      side: 'left',
      sleepRecordId: 4,
      stepMin: 30,
      rule: { side: 'left', cooldownMin: 10, trigger, conditions, actions },
    })

    expect(backtest.run).toHaveBeenCalledOnce()
    const options = backtest.run.mock.calls[0]?.[0]
    expect(options).toMatchObject({
      timezone: 'America/New_York',
      startMs: start.getTime(),
      endMs: end.getTime(),
      stepMin: 30,
    })
    expect(options.series).toEqual({
      'left.movement': [{ t: t.getTime(), v: 9 }],
      'left.heartRate': [{ t: t.getTime(), v: 61 }],
      'left.hrv': [{ t: t.getTime(), v: 42 }],
      'left.breathingRate': [{ t: t.getTime(), v: 14 }],
      'ambient.temperature': [{ t: t.getTime(), v: 68 }],
      'ambient.humidity': [{ t: t.getTime(), v: 45.5 }],
      'left.surfaceTemp': [{ t: t.getTime(), v: 71.60000000000001 }],
      'left.surfaceTemp.spread': [{ t: t.getTime(), v: 7.200000000000003 }],
      'left.surfaceTemp.gradient': [{ t: t.getTime(), v: 7.200000000000003 }],
      'left.waterTemp': [{ t: t.getTime(), v: 64.4 }],
      'ambient.light': [{ t: t.getTime(), v: 3.5 }],
      'water.low': [{ t: t.getTime(), v: 1 }, { t: t.getTime() + 1, v: 0 }],
      'left.cap.max': [{ t: t.getTime(), v: 100 }],
      'left.cap.mean': [{ t: t.getTime(), v: 60 }],
      'left.cap.spread': [{ t: t.getTime(), v: 40 }],
    })
  })

  it('falls back from a missing requested record to the latest side record', async () => {
    const latest = { enteredBedAt: new Date('2026-07-19T20:00:00Z'), leftBedAt: new Date('2026-07-20T04:00:00Z') }
    states.biometrics.queue.push([])
    states.biometrics.queue.push([latest])
    for (let i = 0; i < 7; i++) states.biometrics.queue.push([])
    states.primary.queue.push([])

    const result = await caller.backtest({
      side: 'right',
      sleepRecordId: 99,
      rule: { side: 'right', cooldownMin: null, trigger, conditions, actions },
    })
    expect(result.ok).toBe(true)
    expect(result.night).toEqual({ label: 'Last night', date: 'Jul 19' })
    expect(backtest.run.mock.calls[0]?.[0]).toMatchObject({
      timezone: 'America/Los_Angeles',
      startMs: latest.enteredBedAt.getTime(),
      endMs: latest.leftBedAt.getTime(),
    })
  })

  it('uses an exact twelve-hour movement window when there is no sleep record', async () => {
    const latest = new Date('2026-07-20T04:00:00Z')
    const localMonth = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][latest.getMonth()]
    states.biometrics.queue.push([])
    states.biometrics.queue.push([{ t: latest }])
    for (let i = 0; i < 7; i++) states.biometrics.queue.push([])
    states.primary.queue.push([])

    const result = await caller.backtest({
      side: 'left',
      rule: { side: null, cooldownMin: null, trigger, conditions, actions },
    })
    expect(result.night).toEqual({
      label: 'Recent',
      date: `${localMonth} ${latest.getDate()}`,
    })
    expect(backtest.run.mock.calls[0]?.[0]).toMatchObject({
      startMs: latest.getTime() - 12 * 3_600_000,
      endMs: latest.getTime(),
    })
  })

  it.each([
    [new Error('history corrupt'), 'history corrupt'],
    ['history unavailable', 'Unknown error'],
  ])('wraps a backtest failure %#', async (failure, message) => {
    states.biometrics.shouldThrow = true
    states.biometrics.error = failure
    await expect(caller.backtest({
      side: 'left',
      rule: { side: null, cooldownMin: null, trigger, conditions, actions },
    })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Backtest failed: ${message}`,
    })
  })

  it.each([0, 31])('rejects backtest stepMin %i', async (stepMin) => {
    await expect(caller.backtest({
      side: 'left',
      stepMin,
      rule: { side: null, cooldownMin: null, trigger, conditions, actions },
    })).rejects.toThrow()
  })

  it('normalizes a null cap-zone payload defensively', async () => {
    const enteredBedAt = new Date('2026-07-19T20:00:00Z')
    const leftBedAt = new Date('2026-07-20T04:00:00Z')
    states.biometrics.queue.push([{ enteredBedAt, leftBedAt }])
    states.biometrics.queue.push([{ t: enteredBedAt, zones: null, peakZone: null }])
    await expect(caller.capZoneReplay({ side: 'right' })).resolves.toEqual({
      ok: true,
      night: { label: 'Last night', date: 'Jul 19' },
      frames: [{ tMs: enteredBedAt.getTime(), zones: [], peakZone: null }],
    })
  })

  it.each([9, 1001])('rejects cap-zone maxFrames %i', async (maxFrames) => {
    await expect(caller.capZoneReplay({ side: 'left', maxFrames })).rejects.toThrow()
  })
})

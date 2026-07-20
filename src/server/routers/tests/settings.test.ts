/**
 * Tests for the settings router — getAll merges defaults, updateDevice
 * persists + reloads scheduler + mirrors homekit lifecycle, updateSide
 * rejects mutually-exclusive flags + validates away window, setAlwaysOn
 * starts/stops keepalive, gesture CRUD.
 *
 * The DB transaction(cb) pattern is mocked synchronously: tx exposes
 * select/update/insert/delete chains terminating in .all() which returns
 * whatever each test queues into `txRows`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const schedulerMock = vi.hoisted(() => {
  const jm = {
    updateTimezone: vi.fn(async () => undefined),
    reloadSchedules: vi.fn(async () => undefined),
    applyCurrentLedBrightness: vi.fn(async () => undefined),
    upsertRebootJob: vi.fn(),
    upsertPrimeJob: vi.fn(),
    upsertLedNightMode: vi.fn(async () => undefined),
    upsertAwayMode: vi.fn(),
  }
  return { getJobManager: vi.fn(async () => jm), jm }
})

const keepaliveMock = vi.hoisted(() => ({
  startKeepalive: vi.fn(),
  stopKeepalive: vi.fn(),
}))

const autoOffMock = vi.hoisted(() => ({
  restartAutoOffTimers: vi.fn(),
}))

const homekitMock = vi.hoisted(() => ({
  enable: vi.fn(async () => undefined),
  disable: vi.fn(async () => undefined),
}))

// DB mock — supports both top-level db.select(…) chain (used by getAll +
// updateDevice prior-row read) AND the transaction wrapper (which receives
// a tx with .select / .update / .insert / .delete chains terminating in .all()).
const dbState = vi.hoisted(() => ({
  // Sequential queue for top-level db.select() chains
  topRowsQueue: [] as unknown[][],
  // Sequential queue for tx-scoped chains
  txRowsQueue: [] as unknown[][],
  // Sequential queue for db.update().set().where() awaitable result (lifecycle revert path)
  topUpdateQueue: [] as Array<unknown>,
  // Recorded .set(payload) arguments so tests can pin what actually gets written
  txSetCalls: [] as unknown[],
  topSetCalls: [] as unknown[],
  popTop(): unknown[] { return dbState.topRowsQueue.shift() ?? [] },
  popTx(): unknown[] { return dbState.txRowsQueue.shift() ?? [] },
}))

const dbMock = vi.hoisted(() => {
  // Top-level chain (await thenable)
  const makeTopChain = () => {
    const chain: Record<string, unknown> = {}
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(dbState.popTop()).then(resolve)
    chain.where = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.set = vi.fn((payload: unknown) => {
      dbState.topSetCalls.push(payload)
      return chain
    })
    return chain
  }

  // Tx-scoped chain (sync — terminates in .all())
  const makeTxChain = () => {
    const chain: Record<string, unknown> = {}
    chain.where = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.values = vi.fn(() => chain)
    chain.set = vi.fn((payload: unknown) => {
      dbState.txSetCalls.push(payload)
      return chain
    })
    chain.returning = vi.fn(() => chain)
    chain.all = vi.fn(() => dbState.popTx())
    chain.run = vi.fn(() => undefined)
    return chain
  }

  const select = vi.fn(() => makeTopChain())
  const update = vi.fn(() => makeTopChain())
  const transaction = vi.fn((cb: (tx: unknown) => unknown) => cb({
    select: vi.fn(() => makeTxChain()),
    update: vi.fn(() => makeTxChain()),
    insert: vi.fn(() => makeTxChain()),
    delete: vi.fn(() => makeTxChain()),
  }))

  return { select, update, transaction }
})

const pumpStallMock = vi.hoisted(() => ({
  invalidateGuardSettingsCache: vi.fn(),
}))

vi.mock('@/src/hardware/pumpStallGuard', () => pumpStallMock)
vi.mock('@/src/scheduler', () => ({ getJobManager: schedulerMock.getJobManager }))
vi.mock('@/src/services/temperatureKeepalive', () => keepaliveMock)
vi.mock('@/src/services/autoOffWatcher', () => autoOffMock)
vi.mock('@/src/homekit', () => homekitMock)
vi.mock('@/src/db', () => ({
  db: { select: dbMock.select, update: dbMock.update, transaction: dbMock.transaction },
  biometricsDb: {},
}))

const { settingsRouter } = await import('@/src/server/routers/settings')
const caller = settingsRouter.createCaller({})

beforeEach(() => {
  schedulerMock.getJobManager.mockClear()
  schedulerMock.jm.updateTimezone.mockReset().mockResolvedValue(undefined)
  schedulerMock.jm.reloadSchedules.mockReset().mockResolvedValue(undefined)
  schedulerMock.jm.applyCurrentLedBrightness.mockReset().mockResolvedValue(undefined)
  schedulerMock.jm.upsertRebootJob.mockReset()
  schedulerMock.jm.upsertPrimeJob.mockReset()
  schedulerMock.jm.upsertLedNightMode.mockReset().mockResolvedValue(undefined)
  schedulerMock.jm.upsertAwayMode.mockReset()
  keepaliveMock.startKeepalive.mockReset()
  keepaliveMock.stopKeepalive.mockReset()
  autoOffMock.restartAutoOffTimers.mockReset()
  pumpStallMock.invalidateGuardSettingsCache.mockReset()
  homekitMock.enable.mockReset().mockResolvedValue(undefined)
  homekitMock.disable.mockReset().mockResolvedValue(undefined)
  dbState.topRowsQueue.length = 0
  dbState.txRowsQueue.length = 0
  dbState.txSetCalls.length = 0
  dbState.topSetCalls.length = 0
  dbMock.select.mockClear()
  dbMock.update.mockClear()
  dbMock.transaction.mockClear()
})

describe('settings.getAll', () => {
  it('returns existing rows for device, sides, and gestures', async () => {
    const device = {
      id: 1, timezone: 'UTC', temperatureUnit: 'F',
      rebootDaily: false, rebootTime: '03:00',
      primePodDaily: false, primePodTime: '14:00',
      ledNightModeEnabled: false, ledDayBrightness: 100, ledNightBrightness: 0,
      ledNightStartTime: '22:00', ledNightEndTime: '07:00',
      globalMaxOnHours: null, homekitEnabled: false,
      pumpStallProtectionEnabled: true, pumpStallRpmThreshold: 500,
      pumpStallDwellSamples: 2, pumpStallAutoRecoveryEnabled: false,
      pumpStallRecoveryRpm: 1500, pumpStallRecoverySamples: 3,
      createdAt: new Date(0), updatedAt: new Date(0),
    }
    const sides = [
      { side: 'left', name: 'L', awayMode: false, alwaysOn: false, autoOffEnabled: false, autoOffMinutes: 30, awayStart: null, awayReturn: null, createdAt: new Date(0), updatedAt: new Date(0) },
      { side: 'right', name: 'R', awayMode: false, alwaysOn: false, autoOffEnabled: false, autoOffMinutes: 30, awayStart: null, awayReturn: null, createdAt: new Date(0), updatedAt: new Date(0) },
    ]
    const gestures: unknown[] = []
    dbState.topRowsQueue.push([device], sides, gestures)

    const result = await caller.getAll({})
    expect(result.device.timezone).toBe('UTC')
    expect(result.sides.left.name).toBe('L')
    expect(result.sides.right.name).toBe('R')
    expect(result.gestures.left).toEqual([])
  })

  it('returns synthetic defaults when device row is missing', async () => {
    dbState.topRowsQueue.push([], [], [])
    const result = await caller.getAll({})
    expect(result.device.timezone).toBe('America/Los_Angeles')
    expect(result.sides.left.side).toBe('left')
    expect(result.sides.right.side).toBe('right')
  })

  it('partitions gestures by side', async () => {
    const device = { ...baseDevice }
    const sides = [
      { side: 'left', name: 'L', awayMode: false, alwaysOn: false, autoOffEnabled: false, autoOffMinutes: 30, awayStart: null, awayReturn: null, createdAt: new Date(0), updatedAt: new Date(0) },
      { side: 'right', name: 'R', awayMode: false, alwaysOn: false, autoOffEnabled: false, autoOffMinutes: 30, awayStart: null, awayReturn: null, createdAt: new Date(0), updatedAt: new Date(0) },
    ]
    const gestures = [
      { id: 1, side: 'left', tapType: 'doubleTap', actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1, createdAt: new Date(0), updatedAt: new Date(0) },
      { id: 2, side: 'right', tapType: 'doubleTap', actionType: 'alarm', alarmBehavior: 'snooze', createdAt: new Date(0), updatedAt: new Date(0) },
    ]
    dbState.topRowsQueue.push([device], sides, gestures)
    const result = await caller.getAll({})
    expect(result.gestures.left).toHaveLength(1)
    expect(result.gestures.right).toHaveLength(1)
    expect(result.gestures.left[0].id).toBe(1)
  })

  it('wraps unexpected DB errors in TRPCError(INTERNAL_SERVER_ERROR)', async () => {
    // Make the first db.select() throw synchronously — simulates a DB outage.
    dbMock.select.mockImplementationOnce(() => {
      throw new Error('db down')
    })
    await expect(caller.getAll({})).rejects.toThrow(/Failed to fetch settings: db down/)
    // Restore default chain factory for subsequent tests.
    dbMock.select.mockImplementation(() => {
      const chain: Record<string, unknown> = {}
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(dbState.popTop()).then(resolve)
      chain.where = vi.fn(() => chain)
      chain.limit = vi.fn(() => chain)
      chain.from = vi.fn(() => chain)
      chain.set = vi.fn(() => chain)
      return chain
    })
  })
})

describe('settings.updateDevice', () => {
  it('updates timezone and triggers updateTimezone reload', async () => {
    // For 'homekitEnabled' check: not present, so no prior-row select.
    // Tx: select(current) returns 1 row, update().returning().all() returns updated row.
    const current = {
      id: 1, timezone: 'UTC', temperatureUnit: 'F',
      rebootDaily: false, rebootTime: '03:00',
      primePodDaily: false, primePodTime: '14:00',
      ledNightModeEnabled: false, ledDayBrightness: 100, ledNightBrightness: 0,
      ledNightStartTime: '22:00', ledNightEndTime: '07:00',
      globalMaxOnHours: null, homekitEnabled: false,
      pumpStallProtectionEnabled: true, pumpStallRpmThreshold: 500,
      pumpStallDwellSamples: 2, pumpStallAutoRecoveryEnabled: false,
      pumpStallRecoveryRpm: 1500, pumpStallRecoverySamples: 3,
      createdAt: new Date(0), updatedAt: new Date(0),
    }
    const updated = { ...current, timezone: 'America/New_York', updatedAt: new Date(1) }
    dbState.txRowsQueue.push([current], [updated])

    const result = await caller.updateDevice({ timezone: 'America/New_York' })
    expect(result.timezone).toBe('America/New_York')
    expect(schedulerMock.jm.updateTimezone).toHaveBeenCalledWith('America/New_York')
    expect(schedulerMock.jm.reloadSchedules).not.toHaveBeenCalled()
  })

  it('upserts the prime job incrementally for non-timezone scheduling fields', async () => {
    const current = {
      id: 1, timezone: 'UTC', temperatureUnit: 'F',
      rebootDaily: false, rebootTime: '03:00',
      primePodDaily: false, primePodTime: '14:00',
      ledNightModeEnabled: false, ledDayBrightness: 100, ledNightBrightness: 0,
      ledNightStartTime: '22:00', ledNightEndTime: '07:00',
      globalMaxOnHours: null, homekitEnabled: false,
      pumpStallProtectionEnabled: true, pumpStallRpmThreshold: 500,
      pumpStallDwellSamples: 2, pumpStallAutoRecoveryEnabled: false,
      pumpStallRecoveryRpm: 1500, pumpStallRecoverySamples: 3,
      createdAt: new Date(0), updatedAt: new Date(0),
    }
    const updated = { ...current, primePodDaily: true, primePodTime: '15:00' }
    dbState.txRowsQueue.push([current], [updated])
    // applySettingsSchedulerChanges re-reads the row post-commit so the upsert
    // sees merged state instead of just the diff.
    dbState.topRowsQueue.push([updated])

    await caller.updateDevice({ primePodDaily: true, primePodTime: '15:00' })
    expect(schedulerMock.jm.upsertPrimeJob).toHaveBeenCalledTimes(1)
    expect(schedulerMock.jm.upsertPrimeJob).toHaveBeenCalledWith(true, '15:00')
    expect(schedulerMock.jm.reloadSchedules).not.toHaveBeenCalled()
  })

  it('upserts the reboot job incrementally when rebootDaily/rebootTime change', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, rebootDaily: true, rebootTime: '04:00' }
    dbState.txRowsQueue.push([current], [updated])
    dbState.topRowsQueue.push([updated])

    await caller.updateDevice({ rebootDaily: true, rebootTime: '04:00' })
    expect(schedulerMock.jm.upsertRebootJob).toHaveBeenCalledTimes(1)
    expect(schedulerMock.jm.upsertRebootJob).toHaveBeenCalledWith(true, '04:00')
    expect(schedulerMock.jm.reloadSchedules).not.toHaveBeenCalled()
  })

  it('fires immediate LED apply when ledDayBrightness changes', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, ledDayBrightness: 42 }
    dbState.txRowsQueue.push([current], [updated])

    await caller.updateDevice({ ledDayBrightness: 42 })
    expect(schedulerMock.jm.applyCurrentLedBrightness).toHaveBeenCalledTimes(1)
    // Brightness changes must NOT rebuild the scheduler — reloadSchedules
    // re-creates every temperature cron job and makes the slider feel slow.
    // Night-mode crons read brightness from the DB at fire time instead.
    expect(schedulerMock.jm.reloadSchedules).not.toHaveBeenCalled()
    // Brightness-only changes must also NOT cancel-and-recreate the LED cron
    // jobs (timing didn't change). upsertLedNightMode would do exactly that,
    // plus emit a redundant SET_SETTINGS write on top of applyCurrentLedBrightness.
    expect(schedulerMock.jm.upsertLedNightMode).not.toHaveBeenCalled()
  })

  it('fires immediate LED apply when ledNightBrightness changes', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, ledNightBrightness: 5 }
    dbState.txRowsQueue.push([current], [updated])

    await caller.updateDevice({ ledNightBrightness: 5 })
    expect(schedulerMock.jm.applyCurrentLedBrightness).toHaveBeenCalledTimes(1)
    expect(schedulerMock.jm.reloadSchedules).not.toHaveBeenCalled()
    expect(schedulerMock.jm.upsertLedNightMode).not.toHaveBeenCalled()
  })

  it('fires immediate LED apply when ledNightModeEnabled toggles', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, ledNightModeEnabled: true }
    dbState.txRowsQueue.push([current], [updated])
    dbState.topRowsQueue.push([updated])

    // Toggling night mode must also push an immediate apply — disabling it
    // while in the night window otherwise leaves the LED dim until the user
    // manually nudges the day slider.
    await caller.updateDevice({ ledNightModeEnabled: true })
    expect(schedulerMock.jm.applyCurrentLedBrightness).toHaveBeenCalledTimes(1)
    expect(schedulerMock.jm.upsertLedNightMode).toHaveBeenCalledTimes(1)
    expect(schedulerMock.jm.reloadSchedules).not.toHaveBeenCalled()
  })

  it('does NOT fire immediate LED apply for non-LED scheduling fields', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, primePodDaily: true, primePodTime: '14:00' }
    dbState.txRowsQueue.push([current], [updated])

    await caller.updateDevice({ primePodDaily: true, primePodTime: '14:00' })
    expect(schedulerMock.jm.applyCurrentLedBrightness).not.toHaveBeenCalled()
  })

  it('invalidates the pump stall guard cache when a pump_stall_* field changes', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, pumpStallRpmThreshold: 700 }
    dbState.txRowsQueue.push([current], [updated])

    await caller.updateDevice({ pumpStallRpmThreshold: 700 })
    expect(pumpStallMock.invalidateGuardSettingsCache).toHaveBeenCalledTimes(1)
  })

  it('does NOT invalidate the pump stall cache for unrelated fields', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, primePodDaily: true, primePodTime: '14:00' }
    dbState.txRowsQueue.push([current], [updated])

    await caller.updateDevice({ primePodDaily: true, primePodTime: '14:00' })
    expect(pumpStallMock.invalidateGuardSettingsCache).not.toHaveBeenCalled()
  })

  it('logs but does not fail when applyCurrentLedBrightness rejects', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, ledDayBrightness: 80 }
    dbState.txRowsQueue.push([current], [updated])
    schedulerMock.jm.applyCurrentLedBrightness.mockRejectedValueOnce(new Error('hw down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await caller.updateDevice({ ledDayBrightness: 80 })
    expect(errorSpy).toHaveBeenCalledWith('LED brightness immediate apply failed:', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('rejects rebootDaily=true without a rebootTime', async () => {
    const current = {
      id: 1, timezone: 'UTC', temperatureUnit: 'F',
      rebootDaily: false, rebootTime: null,
      primePodDaily: false, primePodTime: '14:00',
      ledNightModeEnabled: false, ledDayBrightness: 100, ledNightBrightness: 0,
      ledNightStartTime: '22:00', ledNightEndTime: '07:00',
      globalMaxOnHours: null, homekitEnabled: false,
      pumpStallProtectionEnabled: true, pumpStallRpmThreshold: 500,
      pumpStallDwellSamples: 2, pumpStallAutoRecoveryEnabled: false,
      pumpStallRecoveryRpm: 1500, pumpStallRecoverySamples: 3,
      createdAt: new Date(0), updatedAt: new Date(0),
    }
    dbState.txRowsQueue.push([current])

    await expect(caller.updateDevice({ rebootDaily: true })).rejects.toThrow(/rebootTime is required/)
  })

  it('mirrors homekit.enable() and rolls back DB on lifecycle failure', async () => {
    // Top-level select for prior homekitEnabled
    dbState.topRowsQueue.push([{ homekitEnabled: false }])
    // Top-level update().set().where() for revert (await thenable resolves to anything)

    const current = {
      id: 1, timezone: 'UTC', temperatureUnit: 'F',
      rebootDaily: false, rebootTime: null,
      primePodDaily: false, primePodTime: null,
      ledNightModeEnabled: false, ledDayBrightness: 100, ledNightBrightness: 0,
      ledNightStartTime: '22:00', ledNightEndTime: '07:00',
      globalMaxOnHours: null, homekitEnabled: false,
      pumpStallProtectionEnabled: true, pumpStallRpmThreshold: 500,
      pumpStallDwellSamples: 2, pumpStallAutoRecoveryEnabled: false,
      pumpStallRecoveryRpm: 1500, pumpStallRecoverySamples: 3,
      createdAt: new Date(0), updatedAt: new Date(0),
    }
    const updated = { ...current, homekitEnabled: true }
    dbState.txRowsQueue.push([current], [updated])

    homekitMock.enable.mockRejectedValue(new Error('mDNS failed'))

    await expect(caller.updateDevice({ homekitEnabled: true })).rejects.toThrow(/mDNS failed/)
    // Revert should have been attempted (db.update was called)
    expect(dbMock.update).toHaveBeenCalled()
  })
})

describe('settings.updateSide', () => {
  it('rejects alwaysOn + autoOffEnabled set true together', async () => {
    const current = {
      side: 'left', name: 'L', awayMode: false, alwaysOn: true, autoOffEnabled: false, autoOffMinutes: 30,
      awayStart: null, awayReturn: null, createdAt: new Date(0), updatedAt: new Date(0),
    }
    dbState.txRowsQueue.push([current])

    await expect(caller.updateSide({ side: 'left', autoOffEnabled: true })).rejects.toThrow(/mutually exclusive/)
  })

  it('rejects awayReturn earlier than awayStart', async () => {
    const current = {
      side: 'left', name: 'L', awayMode: false, alwaysOn: false, autoOffEnabled: false, autoOffMinutes: 30,
      awayStart: '2025-01-10T00:00:00Z', awayReturn: null, createdAt: new Date(0), updatedAt: new Date(0),
    }
    dbState.txRowsQueue.push([current])

    await expect(caller.updateSide({
      side: 'left',
      awayReturn: '2025-01-01T00:00:00Z',
    })).rejects.toThrow(/awayReturn must not be before awayStart/)
  })

  it('starts keepalive when alwaysOn=true', async () => {
    const current = {
      side: 'left', name: 'L', awayMode: false, alwaysOn: false, autoOffEnabled: false, autoOffMinutes: 30,
      awayStart: null, awayReturn: null, createdAt: new Date(0), updatedAt: new Date(0),
    }
    const updated = { ...current, alwaysOn: true }
    dbState.txRowsQueue.push([current], [updated])

    await caller.updateSide({ side: 'left', alwaysOn: true })
    expect(keepaliveMock.startKeepalive).toHaveBeenCalledWith('left')
  })

  it('stops keepalive when alwaysOn=false', async () => {
    const current = {
      side: 'left', name: 'L', awayMode: false, alwaysOn: true, autoOffEnabled: false, autoOffMinutes: 30,
      awayStart: null, awayReturn: null, createdAt: new Date(0), updatedAt: new Date(0),
    }
    const updated = { ...current, alwaysOn: false }
    dbState.txRowsQueue.push([current], [updated])

    await caller.updateSide({ side: 'left', alwaysOn: false })
    expect(keepaliveMock.stopKeepalive).toHaveBeenCalledWith('left')
  })

  it('throws NOT_FOUND when no row exists', async () => {
    dbState.txRowsQueue.push([])
    await expect(caller.updateSide({ side: 'left', name: 'New' })).rejects.toThrow(/Side settings for left not found/)
  })
})

describe('settings.setAlwaysOn', () => {
  it('starts keepalive when alwaysOn=true', async () => {
    const updated = {
      side: 'left', name: 'L', awayMode: false, alwaysOn: true, autoOffEnabled: false, autoOffMinutes: 30,
      awayStart: null, awayReturn: null, createdAt: new Date(0), updatedAt: new Date(0),
    }
    dbState.txRowsQueue.push([updated])

    await caller.setAlwaysOn({ side: 'left', alwaysOn: true })
    expect(keepaliveMock.startKeepalive).toHaveBeenCalledWith('left')
  })

  it('stops keepalive when alwaysOn=false', async () => {
    const updated = {
      side: 'right', name: 'R', awayMode: false, alwaysOn: false, autoOffEnabled: false, autoOffMinutes: 30,
      awayStart: null, awayReturn: null, createdAt: new Date(0), updatedAt: new Date(0),
    }
    dbState.txRowsQueue.push([updated])

    await caller.setAlwaysOn({ side: 'right', alwaysOn: false })
    expect(keepaliveMock.stopKeepalive).toHaveBeenCalledWith('right')
  })

  it('throws NOT_FOUND when row missing', async () => {
    dbState.txRowsQueue.push([])
    await expect(caller.setAlwaysOn({ side: 'left', alwaysOn: true })).rejects.toThrow(/Side settings for left not found/)
  })
})

describe('settings.setGesture / deleteGesture', () => {
  it('creates a temperature gesture when none exists', async () => {
    // tx.select existing → empty; tx.insert.values.returning.all → [created]
    const created = {
      id: 1, side: 'left', tapType: 'doubleTap', actionType: 'temperature',
      temperatureChange: 'increment', temperatureAmount: 2,
      createdAt: new Date(0), updatedAt: new Date(0),
    }
    dbState.txRowsQueue.push([], [created])

    const out = await caller.setGesture({
      side: 'left',
      tapType: 'doubleTap',
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 2,
    })
    expect(out.id).toBe(1)
  })

  it('updates an alarm gesture when one already exists', async () => {
    const existing = { id: 5, side: 'left', tapType: 'doubleTap' }
    const updated = {
      id: 5, side: 'left', tapType: 'doubleTap', actionType: 'alarm',
      alarmBehavior: 'snooze',
      createdAt: new Date(0), updatedAt: new Date(0),
    }
    dbState.txRowsQueue.push([existing], [updated])

    const out = await caller.setGesture({
      side: 'left',
      tapType: 'doubleTap',
      actionType: 'alarm',
      alarmBehavior: 'snooze',
    })
    expect(out.id).toBe(5)
  })

  it('deleteGesture throws NOT_FOUND when no row deleted', async () => {
    dbState.txRowsQueue.push([])
    await expect(caller.deleteGesture({ side: 'left', tapType: 'doubleTap' })).rejects.toThrow(/not found/)
  })

  it('deleteGesture returns success when a row was deleted', async () => {
    dbState.txRowsQueue.push([{ id: 1 }])
    const out = await caller.deleteGesture({ side: 'left', tapType: 'doubleTap' })
    expect(out).toEqual({ success: true })
  })
})

// Shared device row fixture for branches that don't care about specific values.
const baseDevice = {
  id: 1, timezone: 'UTC', temperatureUnit: 'F' as const,
  rebootDaily: false, rebootTime: '03:00',
  primePodDaily: false, primePodTime: '14:00',
  ledNightModeEnabled: false, ledDayBrightness: 100, ledNightBrightness: 0,
  ledNightStartTime: '22:00', ledNightEndTime: '07:00',
  globalMaxOnHours: null, homekitEnabled: false,
  pumpStallProtectionEnabled: true, pumpStallRpmThreshold: 500,
  pumpStallDwellSamples: 2, pumpStallAutoRecoveryEnabled: false,
  pumpStallRecoveryRpm: 1500, pumpStallRecoverySamples: 3,
  createdAt: new Date(0), updatedAt: new Date(0),
}

const baseSide = {
  side: 'left' as const, name: 'L', awayMode: false, alwaysOn: false,
  autoOffEnabled: false, autoOffMinutes: 30,
  awayStart: null, awayReturn: null,
  createdAt: new Date(0), updatedAt: new Date(0),
}

describe('settings.updateDevice — extra branches', () => {
  it('throws NOT_FOUND when current device row is missing inside the tx', async () => {
    dbState.txRowsQueue.push([]) // tx select(current) → empty
    await expect(caller.updateDevice({ timezone: 'UTC' })).rejects.toThrow(/Device settings not found/)
  })

  it('rejects primePodDaily=true without a primePodTime', async () => {
    const current = { ...baseDevice, primePodTime: null }
    dbState.txRowsQueue.push([current])
    await expect(caller.updateDevice({ primePodDaily: true })).rejects.toThrow(/primePodTime is required/)
  })

  it('throws NOT_FOUND when the update returning() is empty', async () => {
    dbState.txRowsQueue.push([baseDevice], []) // current present, update result empty
    await expect(caller.updateDevice({ timezone: 'UTC' })).rejects.toThrow(/Device settings not found/)
  })

  it('swallows scheduler reload failures without failing the mutation', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, timezone: 'America/New_York' }
    dbState.txRowsQueue.push([current], [updated])
    schedulerMock.jm.updateTimezone.mockRejectedValueOnce(new Error('scheduler down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await caller.updateDevice({ timezone: 'America/New_York' })
    expect(result.timezone).toBe('America/New_York')
    expect(errorSpy).toHaveBeenCalledWith('Scheduler update failed:', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('restarts auto-off timers when globalMaxOnHours changes', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, globalMaxOnHours: 8 }
    dbState.txRowsQueue.push([current], [updated])
    await caller.updateDevice({ globalMaxOnHours: 8 })
    expect(autoOffMock.restartAutoOffTimers).toHaveBeenCalledTimes(1)
  })

  it('logs but does not fail when autoOff restart throws', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, globalMaxOnHours: 12 }
    dbState.txRowsQueue.push([current], [updated])
    autoOffMock.restartAutoOffTimers.mockImplementationOnce(() => {
      throw new Error('autoOff bust')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await caller.updateDevice({ globalMaxOnHours: 12 })
    expect(errorSpy).toHaveBeenCalledWith('autoOff restart failed:', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('invokes homekit.disable() when homekitEnabled flips to false', async () => {
    dbState.topRowsQueue.push([{ homekitEnabled: true }])
    const current = { ...baseDevice, homekitEnabled: true }
    const updated = { ...current, homekitEnabled: false }
    dbState.txRowsQueue.push([current], [updated])
    await caller.updateDevice({ homekitEnabled: false })
    expect(homekitMock.disable).toHaveBeenCalledTimes(1)
    expect(homekitMock.enable).not.toHaveBeenCalled()
  })

  it('wraps non-TRPC errors thrown by the transaction in INTERNAL_SERVER_ERROR', async () => {
    // First call to db.transaction throws a raw Error — the catch block at
    // the bottom of updateDevice should wrap it.
    dbMock.transaction.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    await expect(caller.updateDevice({ timezone: 'UTC' })).rejects.toThrow(/Failed to update device settings: boom/)
  })
})

describe('settings.updateSide — extra branches', () => {
  it('throws NOT_FOUND when update returning() is empty (race vs delete)', async () => {
    const current = { ...baseSide }
    dbState.txRowsQueue.push([current], [])
    await expect(caller.updateSide({ side: 'left', name: 'Renamed' })).rejects.toThrow(/Side settings for left not found/)
  })

  it('upserts away-mode incrementally when the window changes', async () => {
    const current = { ...baseSide }
    const updated = { ...current, awayStart: '2025-01-01T00:00:00Z' }
    dbState.txRowsQueue.push([current], [updated])
    await caller.updateSide({ side: 'left', awayStart: '2025-01-01T00:00:00Z' })
    expect(schedulerMock.jm.upsertAwayMode).toHaveBeenCalledWith('left', '2025-01-01T00:00:00Z', null)
    expect(schedulerMock.jm.reloadSchedules).not.toHaveBeenCalled()
  })

  it('logs but does not fail when away-window scheduler upsert throws', async () => {
    const current = { ...baseSide }
    const updated = { ...current, awayReturn: '2025-01-02T00:00:00Z' }
    dbState.txRowsQueue.push([current], [updated])
    schedulerMock.jm.upsertAwayMode.mockImplementationOnce(() => {
      throw new Error('reload boom')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await caller.updateSide({ side: 'left', awayReturn: '2025-01-02T00:00:00Z' })
    expect(errorSpy).toHaveBeenCalledWith('Scheduler update failed:', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('restarts auto-off timers when autoOffMinutes changes', async () => {
    const current = { ...baseSide }
    const updated = { ...current, autoOffMinutes: 45 }
    dbState.txRowsQueue.push([current], [updated])
    await caller.updateSide({ side: 'left', autoOffMinutes: 45 })
    expect(autoOffMock.restartAutoOffTimers).toHaveBeenCalledTimes(1)
  })

  it('logs but does not fail when auto-off restart throws in updateSide', async () => {
    const current = { ...baseSide }
    const updated = { ...current, autoOffEnabled: true }
    dbState.txRowsQueue.push([current], [updated])
    autoOffMock.restartAutoOffTimers.mockImplementationOnce(() => {
      throw new Error('autoOff fail')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await caller.updateSide({ side: 'left', autoOffEnabled: true })
    expect(errorSpy).toHaveBeenCalledWith('Auto-off timer restart failed:', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('wraps non-TRPC errors from the transaction in INTERNAL_SERVER_ERROR', async () => {
    dbMock.transaction.mockImplementationOnce(() => {
      throw new Error('side boom')
    })
    await expect(caller.updateSide({ side: 'left', name: 'X' })).rejects.toThrow(/Failed to update side settings: side boom/)
  })
})

describe('settings.setAlwaysOn — error wrap', () => {
  it('wraps non-TRPC errors from the transaction in INTERNAL_SERVER_ERROR', async () => {
    dbMock.transaction.mockImplementationOnce(() => {
      throw new Error('toggle boom')
    })
    await expect(caller.setAlwaysOn({ side: 'left', alwaysOn: true })).rejects.toThrow(/Failed to set alwaysOn: toggle boom/)
  })
})

describe('settings.setGesture — extra branches', () => {
  it('throws INTERNAL_SERVER_ERROR when update returning() yields no row', async () => {
    // Existing gesture found, but the update inside the same tx returns no
    // row (theoretically impossible with a returning() chain — guarded anyway).
    dbState.txRowsQueue.push([{ id: 9, side: 'left', tapType: 'doubleTap' }], [])
    await expect(caller.setGesture({
      side: 'left',
      tapType: 'doubleTap',
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 1,
    })).rejects.toThrow(/Failed to update gesture/)
  })

  it('throws INTERNAL_SERVER_ERROR when insert returning() yields no row', async () => {
    dbState.txRowsQueue.push([], []) // no existing, insert returned nothing
    await expect(caller.setGesture({
      side: 'left',
      tapType: 'doubleTap',
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 1,
    })).rejects.toThrow(/Failed to create gesture/)
  })

  it('wraps non-TRPC errors thrown by the transaction in INTERNAL_SERVER_ERROR', async () => {
    dbMock.transaction.mockImplementationOnce(() => {
      throw new Error('gesture boom')
    })
    await expect(caller.setGesture({
      side: 'left',
      tapType: 'doubleTap',
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 1,
    })).rejects.toThrow(/Failed to set gesture: gesture boom/)
  })
})

describe('settings.deleteGesture — extra branches', () => {
  it('wraps non-TRPC errors thrown by the transaction in INTERNAL_SERVER_ERROR', async () => {
    dbMock.transaction.mockImplementationOnce(() => {
      throw new Error('delete boom')
    })
    await expect(caller.deleteGesture({ side: 'left', tapType: 'doubleTap' })).rejects.toThrow(/Failed to delete gesture: delete boom/)
  })
})

/**
 * Throws a value that is NOT an `instanceof Error` so the routers' catch-block
 * ternaries fall through to their 'Unknown error' branch.
 */
function throwNonError(): never {
  const notAnError: unknown = { code: 'ENOENT' }
  throw notAnError
}

const baseRightSide = {
  side: 'right' as const, name: 'R', awayMode: false, alwaysOn: false,
  autoOffEnabled: false, autoOffMinutes: 30,
  awayStart: null, awayReturn: null,
  createdAt: new Date(0), updatedAt: new Date(0),
}

describe('settings.getAll — defaults and partitioning', () => {
  it('fills every device field from the synthetic default row', async () => {
    dbState.topRowsQueue.push([], [], [])
    const result = await caller.getAll({})
    // Each value is pinned — a silently-changed default ships a pod that
    // reboots/primes at the wrong hour or dims its LED at the wrong time.
    expect(result.device).toMatchObject({
      id: 1,
      timezone: 'America/Los_Angeles',
      temperatureUnit: 'F',
      rebootDaily: false,
      rebootTime: '03:00',
      primePodDaily: false,
      primePodTime: '14:00',
      ledNightModeEnabled: false,
      ledDayBrightness: 100,
      ledNightBrightness: 0,
      ledNightStartTime: '22:00',
      ledNightEndTime: '07:00',
      globalMaxOnHours: null,
      homekitEnabled: false,
      pumpStallProtectionEnabled: false,
      pumpStallRpmThreshold: 500,
      pumpStallDwellSamples: 2,
      pumpStallAutoRecoveryEnabled: false,
      pumpStallRecoveryRpm: 1500,
      pumpStallRecoverySamples: 3,
    })
  })

  it('fills every side field from the synthetic default rows', async () => {
    dbState.topRowsQueue.push([{ ...baseDevice }], [], [])
    const result = await caller.getAll({})
    expect(result.sides.left).toMatchObject({
      side: 'left', name: 'Left', alwaysOn: false, awayMode: false,
      autoOffEnabled: false, autoOffMinutes: 30,
    })
    expect(result.sides.right).toMatchObject({
      side: 'right', name: 'Right', alwaysOn: false, awayMode: false,
      autoOffEnabled: false, autoOffMinutes: 30,
    })
  })

  it('matches side rows by the side column, not by row order', async () => {
    // Right row first — a row-order match would hand the right row back as left.
    dbState.topRowsQueue.push([{ ...baseDevice }], [baseRightSide, baseSide], [])
    const result = await caller.getAll({})
    expect(result.sides.left.side).toBe('left')
    expect(result.sides.left.name).toBe('L')
    expect(result.sides.right.side).toBe('right')
    expect(result.sides.right.name).toBe('R')
  })

  it('routes each gesture to the bucket matching its own side', async () => {
    const gestures = [
      { id: 1, side: 'left', tapType: 'doubleTap', actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 1, createdAt: new Date(0), updatedAt: new Date(0) },
      { id: 2, side: 'right', tapType: 'doubleTap', actionType: 'alarm', alarmBehavior: 'snooze', createdAt: new Date(0), updatedAt: new Date(0) },
    ]
    dbState.topRowsQueue.push([{ ...baseDevice }], [baseSide, baseRightSide], gestures)
    const result = await caller.getAll({})
    expect(result.gestures.left.map(g => g.id)).toEqual([1])
    expect(result.gestures.right.map(g => g.id)).toEqual([2])
    expect(result.gestures.left[0].side).toBe('left')
    expect(result.gestures.right[0].side).toBe('right')
  })

  it('reports "Unknown error" when the thrown value is not an Error', async () => {
    dbMock.select.mockImplementationOnce(() => throwNonError())
    await expect(caller.getAll({})).rejects.toThrow('Failed to fetch settings: Unknown error')
  })
})

describe('settings.updateDevice — scheduler key detection', () => {
  it('does not treat an explicitly-undefined timezone as a timezone change', async () => {
    const current = { ...baseDevice }
    dbState.txRowsQueue.push([current], [current])

    // The key IS present in the parsed input, so only the typeof guard keeps
    // this from reloading every cron job against `undefined`.
    await caller.updateDevice({ timezone: undefined })
    expect(schedulerMock.jm.updateTimezone).not.toHaveBeenCalled()
    expect(schedulerMock.getJobManager).not.toHaveBeenCalled()
  })

  it('treats a lone rebootDaily patch as a reboot change and keeps the persisted time', async () => {
    const current = { ...baseDevice, rebootTime: '03:00' }
    const updated = { ...current, rebootDaily: true }
    dbState.txRowsQueue.push([current], [updated])
    dbState.topRowsQueue.push([updated])

    await caller.updateDevice({ rebootDaily: true })
    expect(schedulerMock.jm.upsertRebootJob).toHaveBeenCalledWith(true, '03:00')
    expect(schedulerMock.jm.upsertPrimeJob).not.toHaveBeenCalled()
    expect(schedulerMock.jm.upsertLedNightMode).not.toHaveBeenCalled()
  })

  it('treats a lone primePodDaily patch as a prime change and keeps the persisted time', async () => {
    const current = { ...baseDevice, primePodTime: '14:00' }
    const updated = { ...current, primePodDaily: true }
    dbState.txRowsQueue.push([current], [updated])
    dbState.topRowsQueue.push([updated])

    await caller.updateDevice({ primePodDaily: true })
    expect(schedulerMock.jm.upsertPrimeJob).toHaveBeenCalledWith(true, '14:00')
    expect(schedulerMock.jm.upsertRebootJob).not.toHaveBeenCalled()
    expect(schedulerMock.jm.upsertLedNightMode).not.toHaveBeenCalled()
  })

  it('skips the scheduler entirely when no scheduling key is present', async () => {
    const current = { ...baseDevice }
    dbState.txRowsQueue.push([current], [{ ...current, temperatureUnit: 'C' }])

    await caller.updateDevice({ temperatureUnit: 'C' })
    expect(schedulerMock.getJobManager).not.toHaveBeenCalled()
    expect(autoOffMock.restartAutoOffTimers).not.toHaveBeenCalled()
    expect(pumpStallMock.invalidateGuardSettingsCache).not.toHaveBeenCalled()
    expect(homekitMock.enable).not.toHaveBeenCalled()
    expect(homekitMock.disable).not.toHaveBeenCalled()
    expect(dbState.txSetCalls).toEqual([{ temperatureUnit: 'C', updatedAt: expect.any(Date) }])
  })

  it('bails out quietly when the post-commit re-read finds no row', async () => {
    const current = { ...baseDevice }
    dbState.txRowsQueue.push([current], [{ ...current, rebootDaily: true }])
    // topRowsQueue deliberately empty — the re-read yields no settings row.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await caller.updateDevice({ rebootDaily: true })
    expect(schedulerMock.jm.upsertRebootJob).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('settings.updateDevice — LED and pump-stall key coverage', () => {
  it('fires immediate LED apply when ledNightStartTime changes', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, ledNightStartTime: '23:30' }
    dbState.txRowsQueue.push([current], [updated])
    dbState.topRowsQueue.push([updated])

    await caller.updateDevice({ ledNightStartTime: '23:30' })
    expect(schedulerMock.jm.applyCurrentLedBrightness).toHaveBeenCalledTimes(1)
  })

  it('fires immediate LED apply when ledNightEndTime changes', async () => {
    const current = { ...baseDevice }
    const updated = { ...current, ledNightEndTime: '06:15' }
    dbState.txRowsQueue.push([current], [updated])
    dbState.topRowsQueue.push([updated])

    await caller.updateDevice({ ledNightEndTime: '06:15' })
    expect(schedulerMock.jm.applyCurrentLedBrightness).toHaveBeenCalledTimes(1)
  })

  it('invalidates the pump stall guard cache for each pump_stall_* field', async () => {
    const patches: Array<Parameters<typeof caller.updateDevice>[0]> = [
      { pumpStallProtectionEnabled: true },
      { pumpStallDwellSamples: 5 },
      { pumpStallAutoRecoveryEnabled: true },
      { pumpStallRecoveryRpm: 900 },
      { pumpStallRecoverySamples: 4 },
    ]

    for (const patch of patches) {
      pumpStallMock.invalidateGuardSettingsCache.mockClear()
      const current = { ...baseDevice }
      dbState.txRowsQueue.push([current], [{ ...current, ...patch }])
      await caller.updateDevice(patch)
      expect(pumpStallMock.invalidateGuardSettingsCache).toHaveBeenCalledTimes(1)
    }
  })
})

describe('settings.updateDevice — homekit lifecycle', () => {
  it('reverts to the prior persisted flag when the lifecycle call fails', async () => {
    // Prior row already had homekit ON — the revert must restore true, not the
    // `false` initializer.
    dbState.topRowsQueue.push([{ homekitEnabled: true }])
    const current = { ...baseDevice, homekitEnabled: true }
    dbState.txRowsQueue.push([current], [current])
    homekitMock.enable.mockRejectedValueOnce(new Error('mDNS failed'))

    await expect(caller.updateDevice({ homekitEnabled: true })).rejects.toThrow(/mDNS failed/)
    expect(dbState.topSetCalls).toEqual([{ homekitEnabled: true, updatedAt: expect.any(Date) }])
  })

  it('tolerates a missing prior device row when toggling homekit', async () => {
    dbState.topRowsQueue.push([]) // prior-row read returns nothing
    const current = { ...baseDevice }
    const updated = { ...current, homekitEnabled: true }
    dbState.txRowsQueue.push([current], [updated])

    const result = await caller.updateDevice({ homekitEnabled: true })
    expect(result.homekitEnabled).toBe(true)
    expect(homekitMock.enable).toHaveBeenCalledTimes(1)
  })
})

describe('settings.updateDevice — error surface', () => {
  it('preserves the BAD_REQUEST code for validation failures', async () => {
    dbState.txRowsQueue.push([{ ...baseDevice, rebootTime: null }])
    await expect(caller.updateDevice({ rebootDaily: true })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'rebootTime is required when rebootDaily is enabled',
    })
  })

  it('reports "Unknown error" when the thrown value is not an Error', async () => {
    dbMock.transaction.mockImplementationOnce(() => throwNonError())
    await expect(caller.updateDevice({ timezone: 'UTC' }))
      .rejects.toThrow('Failed to update device settings: Unknown error')
  })
})

describe('settings.updateSide — merged-state validation', () => {
  it('rejects an incoming alwaysOn that collides with persisted autoOffEnabled', async () => {
    const current = { ...baseSide, alwaysOn: false, autoOffEnabled: true }
    dbState.txRowsQueue.push([current])

    await expect(caller.updateSide({ side: 'left', alwaysOn: true }))
      .rejects.toThrow(/mutually exclusive/)
  })

  it('rejects an incoming awayStart that lands after the persisted awayReturn', async () => {
    const current = { ...baseSide, awayStart: null, awayReturn: '2025-01-01T00:00:00Z' }
    dbState.txRowsQueue.push([current])

    await expect(caller.updateSide({ side: 'left', awayStart: '2025-01-10T00:00:00Z' }))
      .rejects.toThrow(/awayReturn must not be before awayStart/)
  })

  it('accepts an away window whose start and return are the same instant', async () => {
    const current = { ...baseSide }
    const updated = { ...current, awayStart: '2025-01-01T00:00:00Z', awayReturn: '2025-01-01T00:00:00Z' }
    dbState.txRowsQueue.push([current], [updated])

    // Equal timestamps are a zero-length window, not a reversed one.
    await caller.updateSide({
      side: 'left',
      awayStart: '2025-01-01T00:00:00Z',
      awayReturn: '2025-01-01T00:00:00Z',
    })
    expect(schedulerMock.jm.upsertAwayMode)
      .toHaveBeenCalledWith('left', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')
  })

  it('leaves a reversed persisted window alone when the patch touches neither field', async () => {
    const current = { ...baseSide, awayStart: '2025-01-10T00:00:00Z', awayReturn: '2025-01-01T00:00:00Z' }
    const updated = { ...current, name: 'Renamed' }
    dbState.txRowsQueue.push([current], [updated])

    const result = await caller.updateSide({ side: 'left', name: 'Renamed' })
    expect(result.name).toBe('Renamed')
  })

  it('preserves the BAD_REQUEST code for validation failures', async () => {
    const current = { ...baseSide, alwaysOn: true }
    dbState.txRowsQueue.push([current])
    await expect(caller.updateSide({ side: 'left', autoOffEnabled: true })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'alwaysOn and autoOffEnabled are mutually exclusive — set the other to false in the same call',
    })
  })
})

describe('settings.updateSide — side effects are scoped to the changed keys', () => {
  it('runs no away/keepalive/auto-off side effects for a name-only update', async () => {
    const current = { ...baseSide }
    const updated = { ...current, name: 'Renamed' }
    dbState.txRowsQueue.push([current], [updated])

    await caller.updateSide({ side: 'left', name: 'Renamed' })
    expect(schedulerMock.jm.upsertAwayMode).not.toHaveBeenCalled()
    expect(keepaliveMock.startKeepalive).not.toHaveBeenCalled()
    expect(keepaliveMock.stopKeepalive).not.toHaveBeenCalled()
    expect(autoOffMock.restartAutoOffTimers).not.toHaveBeenCalled()
    expect(dbState.txSetCalls).toEqual([{ name: 'Renamed', updatedAt: expect.any(Date) }])
  })

  it('reports "Unknown error" when the thrown value is not an Error', async () => {
    dbMock.transaction.mockImplementationOnce(() => throwNonError())
    await expect(caller.updateSide({ side: 'left', name: 'X' }))
      .rejects.toThrow('Failed to update side settings: Unknown error')
  })
})

describe('settings.setAlwaysOn — write payload and error surface', () => {
  it('writes only the alwaysOn flag and a fresh updatedAt', async () => {
    dbState.txRowsQueue.push([{ ...baseSide, alwaysOn: true }])
    await caller.setAlwaysOn({ side: 'left', alwaysOn: true })
    expect(dbState.txSetCalls).toEqual([{ alwaysOn: true, updatedAt: expect.any(Date) }])
  })

  it('preserves the NOT_FOUND code when the row is missing', async () => {
    dbState.txRowsQueue.push([])
    await expect(caller.setAlwaysOn({ side: 'left', alwaysOn: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Side settings for left not found',
    })
  })

  it('reports "Unknown error" when the thrown value is not an Error', async () => {
    dbMock.transaction.mockImplementationOnce(() => throwNonError())
    await expect(caller.setAlwaysOn({ side: 'left', alwaysOn: true }))
      .rejects.toThrow('Failed to set alwaysOn: Unknown error')
  })
})

describe('settings.setGesture — write payload and error surface', () => {
  it('writes the merged gesture payload when updating an existing row', async () => {
    const existing = { id: 5, side: 'left', tapType: 'doubleTap' }
    const updated = {
      id: 5, side: 'left', tapType: 'doubleTap', actionType: 'alarm',
      alarmBehavior: 'snooze', createdAt: new Date(0), updatedAt: new Date(0),
    }
    dbState.txRowsQueue.push([existing], [updated])

    await caller.setGesture({
      side: 'left',
      tapType: 'doubleTap',
      actionType: 'alarm',
      alarmBehavior: 'snooze',
    })
    expect(dbState.txSetCalls).toEqual([{
      side: 'left',
      tapType: 'doubleTap',
      actionType: 'alarm',
      alarmBehavior: 'snooze',
      updatedAt: expect.any(Date),
    }])
  })

  it('rethrows the inner TRPCError unwrapped when the update returns no row', async () => {
    dbState.txRowsQueue.push([{ id: 9, side: 'left', tapType: 'doubleTap' }], [])
    await expect(caller.setGesture({
      side: 'left',
      tapType: 'doubleTap',
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 1,
    })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update gesture - no record returned',
    })
  })

  it('reports "Unknown error" when the thrown value is not an Error', async () => {
    dbMock.transaction.mockImplementationOnce(() => throwNonError())
    await expect(caller.setGesture({
      side: 'left',
      tapType: 'doubleTap',
      actionType: 'temperature',
      temperatureChange: 'increment',
      temperatureAmount: 1,
    })).rejects.toThrow('Failed to set gesture: Unknown error')
  })
})

describe('settings.deleteGesture — error surface', () => {
  it('preserves the NOT_FOUND code when nothing was deleted', async () => {
    dbState.txRowsQueue.push([])
    await expect(caller.deleteGesture({ side: 'left', tapType: 'doubleTap' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Gesture for left doubleTap not found',
    })
  })

  it('reports "Unknown error" when the thrown value is not an Error', async () => {
    dbMock.transaction.mockImplementationOnce(() => throwNonError())
    await expect(caller.deleteGesture({ side: 'left', tapType: 'doubleTap' }))
      .rejects.toThrow('Failed to delete gesture: Unknown error')
  })
})

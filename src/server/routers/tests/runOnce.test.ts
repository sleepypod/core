/**
 * Tests for the runOnce router — start (validates duration cap, primes hardware
 * BEFORE inserting session, schedules remaining set points), getActive (parses
 * setPoints JSON or returns empty on malformed), cancel.
 *
 * Db (better-sqlite3 chain), scheduler, hardware client, broadcaster, and
 * timezone resolver all mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const jobManagerMock = vi.hoisted(() => ({
  cancelRunOnceSession: vi.fn(),
  scheduleRunOnceSession: vi.fn(),
}))

const schedulerMock = vi.hoisted(() => ({
  getJobManager: vi.fn(async () => jobManagerMock),
}))

const helpersMock = vi.hoisted(() => ({
  client: { setPower: vi.fn(async () => undefined) },
  withHardwareClient: vi.fn(),
}))

const broadcastMock = vi.hoisted(() => ({
  broadcastMutationStatus: vi.fn(),
}))

const pumpStallMock = vi.hoisted(() => ({
  shouldBlock: vi.fn<(side: 'left' | 'right') => boolean>(() => false),
}))

const timeUtilsMock = vi.hoisted(() => ({
  // Default: wake time 1 hour from now
  timeToDate: vi.fn((_t: string, _tz: string, now: Date) => new Date(now.getTime() + 60 * 60 * 1000)),
}))

// DB mock with branchable behaviours per test. The router uses three patterns:
//   1. db.transaction(tx => …) where tx exposes select/update with .all()/.run()
//   2. db.select().from().limit() (await-thenable returning a deviceSettings row)
//   3. db.insert().values().returning() (await-thenable returning [{ id }])
//   4. db.update().set().where() (await-thenable, used by cancel)
const dbMock = vi.hoisted(() => {
  // settings select chain — used to fetch timezone
  const settingsRow: { timezone: string | null } = { timezone: 'America/Los_Angeles' }
  const limit = vi.fn(async () => [settingsRow])
  const from = vi.fn(() => ({ limit }))
  const select = vi.fn(() => ({ from }))

  // insert chain — returns [{ id }] from .returning()
  let nextInsertedId = 42
  const returning = vi.fn(async () => [{ id: nextInsertedId }])
  const values = vi.fn(() => ({ returning }))
  const insert = vi.fn(() => ({ values }))

  // update chain — cancel calls db.update(...).set(...).where(...)
  const updateWhere = vi.fn(async () => undefined)
  const updateSet = vi.fn(() => ({ where: updateWhere }))
  const update = vi.fn(() => ({ set: updateSet }))

  // transaction — synchronous, runs callback with a tx that exposes
  // select/update with the chain ending in .all()/.run().
  const txExisting: { id: number }[] = []
  const txSelectAll = vi.fn(() => txExisting)
  const txSelectWhere = vi.fn(() => ({ all: txSelectAll }))
  const txSelectFrom = vi.fn(() => ({ where: txSelectWhere }))
  const txSelect = vi.fn(() => ({ from: txSelectFrom }))
  const txUpdateRun = vi.fn(() => undefined)
  const txUpdateWhere = vi.fn(() => ({ run: txUpdateRun }))
  const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }))
  const txUpdate = vi.fn(() => ({ set: txUpdateSet }))
  const transaction = vi.fn((cb: (tx: unknown) => unknown) => cb({
    select: txSelect,
    update: txUpdate,
  }))

  return {
    select, insert, update, transaction,
    setNextInsertId: (id: number | null) => {
      nextInsertedId = id as number
      returning.mockResolvedValue(id === null ? [] : [{ id }])
    },
    settingsRow, txExisting,
    values, updateSet, updateWhere, txUpdateSet, txUpdateWhere, txUpdateRun, transactionFn: transaction,
  }
})

vi.mock('@/src/scheduler', () => schedulerMock)
vi.mock('@/src/hardware/pumpStallGuard', () => pumpStallMock)
vi.mock('@/src/server/helpers', () => helpersMock)
vi.mock('@/src/streaming/broadcastMutationStatus', () => broadcastMock)
vi.mock('@/src/scheduler/timeUtils', () => timeUtilsMock)
vi.mock('@/src/db', () => ({
  db: {
    select: dbMock.select,
    insert: dbMock.insert,
    update: dbMock.update,
    transaction: dbMock.transaction,
  },
  biometricsDb: {},
}))

const { runOnceRouter } = await import('@/src/server/routers/runOnce')
const caller = runOnceRouter.createCaller({})

beforeEach(() => {
  jobManagerMock.cancelRunOnceSession.mockReset()
  jobManagerMock.scheduleRunOnceSession.mockReset()
  helpersMock.withHardwareClient.mockClear()
  helpersMock.withHardwareClient.mockImplementation(async (cb: (client: unknown) => Promise<unknown>) => cb(helpersMock.client))
  helpersMock.client.setPower.mockReset().mockResolvedValue(undefined)
  broadcastMock.broadcastMutationStatus.mockReset()
  pumpStallMock.shouldBlock.mockReset().mockReturnValue(false)
  timeUtilsMock.timeToDate.mockReset().mockImplementation(
    (_t, _tz, now) => new Date(now.getTime() + 60 * 60 * 1000),
  )
  dbMock.select.mockClear()
  dbMock.insert.mockClear()
  dbMock.update.mockClear()
  dbMock.transactionFn.mockClear()
  dbMock.values.mockClear()
  dbMock.updateSet.mockClear()
  dbMock.updateWhere.mockClear()
  dbMock.txUpdateSet.mockClear()
  dbMock.txUpdateWhere.mockClear()
  dbMock.txExisting.length = 0
  dbMock.setNextInsertId(42)
  dbMock.settingsRow.timezone = 'America/Los_Angeles'
})

describe('runOnce.start', () => {
  it('throws PRECONDITION_FAILED before touching sessions while pump stall guard blocks the side', async () => {
    pumpStallMock.shouldBlock.mockReturnValue(true)

    await expect(caller.start({
      side: 'left',
      setPoints: [{ time: '23:00', temperature: 70 }],
      wakeTime: '07:00',
    })).rejects.toThrow(/Pump stall protection active/)

    // Fails fast: the existing session is not cancelled, no hardware write,
    // no session row inserted.
    expect(dbMock.transactionFn).not.toHaveBeenCalled()
    expect(jobManagerMock.cancelRunOnceSession).not.toHaveBeenCalled()
    expect(helpersMock.client.setPower).not.toHaveBeenCalled()
    expect(dbMock.insert).not.toHaveBeenCalled()
  })

  it('re-checks the guard at the hardware write and blocks a trip that lands mid-flight', async () => {
    // Entry check passes, then the guard trips during the awaited session
    // cancellation / settings lookup — the write-time re-check must stop the
    // power-on and the session insert.
    pumpStallMock.shouldBlock.mockReturnValueOnce(false).mockReturnValue(true)

    await expect(caller.start({
      side: 'left',
      setPoints: [{ time: '23:00', temperature: 70 }],
      wakeTime: '07:00',
    })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Pump stall protection active — re-enable the side first',
    })

    expect(dbMock.transactionFn).toHaveBeenCalled()
    expect(helpersMock.client.setPower).not.toHaveBeenCalled()
    expect(broadcastMock.broadcastMutationStatus).not.toHaveBeenCalled()
    expect(dbMock.insert).not.toHaveBeenCalled()
    expect(jobManagerMock.scheduleRunOnceSession).not.toHaveBeenCalled()
  })

  it('powers on the side with the first set-point temperature, persists session, and schedules the rest', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const expiresAt = new Date(Date.now() + 3_600_123)
    timeUtilsMock.timeToDate.mockReturnValueOnce(expiresAt)
    const result = await caller.start({
      side: 'left',
      setPoints: [
        { time: '23:00', temperature: 70 },
        { time: '03:00', temperature: 65 },
      ],
      wakeTime: '07:00',
    })

    // Hardware was invoked with the first set-point temp
    expect(helpersMock.withHardwareClient).toHaveBeenCalledTimes(1)
    expect(helpersMock.withHardwareClient.mock.calls[0]?.[1]).toBe('Failed to start run-once session')
    expect(helpersMock.client.setPower).toHaveBeenCalledWith('left', true, 70)

    // Mutation broadcast for live UI
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('left', expect.objectContaining({
      targetTemperature: 70,
    }))

    // Scheduler receives the *remaining* set points (slice 1) — the first
    // already fired immediately.
    expect(jobManagerMock.scheduleRunOnceSession).toHaveBeenCalledTimes(1)
    const args = jobManagerMock.scheduleRunOnceSession.mock.calls[0]
    expect(args[0]).toBe(42) // session id
    expect(args[1]).toBe('left')
    expect(args[2]).toEqual([{ time: '03:00', temperature: 65 }])
    expect(args[3]).toBe('07:00')
    expect(args[4]).toBe('America/Los_Angeles')

    expect(dbMock.values).toHaveBeenCalledWith({
      side: 'left',
      setPoints: JSON.stringify([
        { time: '23:00', temperature: 70 },
        { time: '03:00', temperature: 65 },
      ]),
      wakeTime: '07:00',
      expiresAt,
      status: 'active',
    })

    expect(result.sessionId).toBe(42)
    expect(result.expiresAt).toBe(Math.floor(expiresAt.getTime() / 1000))
    expect(log).toHaveBeenCalledWith('Run-once session 42 started for left until 07:00')
    log.mockRestore()
  })

  it('falls back to the default timezone when settings row is missing', async () => {
    // No settings row found
    dbMock.settingsRow.timezone = null as unknown as string
    // Also exercise the empty-array path: replace from()→limit() with empty
    const limit = vi.fn(async () => [])
    const from = vi.fn(() => ({ limit }))
    dbMock.select.mockReturnValueOnce({ from } as never)

    await caller.start({
      side: 'right',
      setPoints: [{ time: '23:00', temperature: 70 }],
      wakeTime: '07:00',
    })

    const args = jobManagerMock.scheduleRunOnceSession.mock.calls[0]
    expect(args[4]).toBe('America/Los_Angeles')
  })

  it('rejects sessions longer than 14 hours (catches wake-time-already-passed bug)', async () => {
    timeUtilsMock.timeToDate.mockImplementation(
      (_t, _tz, now) => new Date(now.getTime() + 20 * 60 * 60 * 1000),
    )

    await expect(caller.start({
      side: 'left',
      setPoints: [{ time: '23:00', temperature: 70 }],
      wakeTime: '07:00',
    })).rejects.toThrow(/Session too long/)

    // Hardware must NOT be touched if validation rejects
    expect(helpersMock.withHardwareClient).not.toHaveBeenCalled()
    expect(jobManagerMock.scheduleRunOnceSession).not.toHaveBeenCalled()
  })

  it('accepts a session exactly 14 hours long', async () => {
    timeUtilsMock.timeToDate.mockImplementation(
      (_t, _tz, now) => new Date(now.getTime() + 14 * 60 * 60 * 1000),
    )
    await expect(caller.start({
      side: 'left',
      setPoints: [{ time: '23:00', temperature: 70 }],
      wakeTime: '07:00',
    })).resolves.toMatchObject({ sessionId: 42 })
    expect(helpersMock.client.setPower).toHaveBeenCalledOnce()
  })

  it('reports the rounded over-limit duration in hours', async () => {
    timeUtilsMock.timeToDate.mockImplementation(
      (_t, _tz, now) => new Date(now.getTime() + 15.4 * 60 * 60 * 1000),
    )
    await expect(caller.start({
      side: 'right',
      setPoints: [{ time: '23:00', temperature: 70 }],
      wakeTime: '07:00',
    })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Session too long (15h). Wake time may have already passed.',
    })
  })

  it('throws when DB insert returns no row (e.g. constraint violation)', async () => {
    dbMock.setNextInsertId(null)

    await expect(caller.start({
      side: 'left',
      setPoints: [{ time: '23:00', temperature: 70 }],
      wakeTime: '07:00',
    })).rejects.toThrow(/Failed to create run-once session/)
  })

  it('cancels any prior active session for the same side before starting', async () => {
    // Pretend an existing active row exists for this side
    dbMock.txExisting.push({ id: 7 }, { id: 9 })

    await caller.start({
      side: 'left',
      setPoints: [{ time: '23:00', temperature: 70 }],
      wakeTime: '07:00',
    })

    // Both prior rows were updated to cancelled (one .run() per row)
    expect(dbMock.txUpdateRun).toHaveBeenCalledTimes(2)
    expect(dbMock.txUpdateSet).toHaveBeenNthCalledWith(1, { status: 'cancelled' })
    expect(dbMock.txUpdateSet).toHaveBeenNthCalledWith(2, { status: 'cancelled' })
    expect(jobManagerMock.cancelRunOnceSession).toHaveBeenCalledWith('left')
  })
})

describe('runOnce.getActive', () => {
  it('returns null when no active session', async () => {
    const limit = vi.fn(async () => [])
    const where = vi.fn(() => ({ limit }))
    const from = vi.fn(() => ({ where }))
    dbMock.select.mockReturnValueOnce({ from } as never)

    const result = await caller.getActive({ side: 'left' })
    expect(result).toBeNull()
  })

  it('parses persisted setPoints JSON', async () => {
    const session = {
      id: 99,
      side: 'left' as const,
      setPoints: JSON.stringify([{ time: '02:00', temperature: 67 }]),
      wakeTime: '07:00',
      startedAt: new Date(1700000000000),
      expiresAt: new Date(1700100000000),
      status: 'active' as const,
    }
    const limit = vi.fn(async () => [session])
    const where = vi.fn(() => ({ limit }))
    const from = vi.fn(() => ({ where }))
    dbMock.select.mockReturnValueOnce({ from } as never)

    const result = await caller.getActive({ side: 'left' })
    expect(result).not.toBeNull()
    expect(result?.id).toBe(99)
    expect(result?.setPoints).toEqual([{ time: '02:00', temperature: 67 }])
    expect(result?.startedAt).toBe(Math.floor(1700000000000 / 1000))
    expect(result?.expiresAt).toBe(Math.floor(1700100000000 / 1000))
    expect(result).toMatchObject({
      side: 'left', wakeTime: '07:00', status: 'active',
    })
  })

  it('returns empty setPoints when persisted JSON is malformed', async () => {
    const session = {
      id: 100,
      side: 'left' as const,
      setPoints: '{not json',
      wakeTime: '07:00',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
      status: 'active' as const,
    }
    const limit = vi.fn(async () => [session])
    const where = vi.fn(() => ({ limit }))
    const from = vi.fn(() => ({ where }))
    dbMock.select.mockReturnValueOnce({ from } as never)

    const result = await caller.getActive({ side: 'left' })
    expect(result?.setPoints).toEqual([])
  })
})

describe('runOnce.cancel', () => {
  it('marks active session cancelled, cancels scheduler jobs, broadcasts', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await caller.cancel({ side: 'right' })

    expect(dbMock.update).toHaveBeenCalledTimes(1)
    expect(dbMock.updateSet).toHaveBeenCalledWith({ status: 'cancelled' })
    expect(jobManagerMock.cancelRunOnceSession).toHaveBeenCalledWith('right')
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('right')
    expect(result).toEqual({ success: true })
    expect(log).toHaveBeenCalledWith('Run-once session cancelled for right')
    log.mockRestore()
  })
})

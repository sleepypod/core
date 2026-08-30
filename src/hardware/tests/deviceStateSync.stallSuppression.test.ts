/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import type { DeviceStatus } from '../types'

vi.mock('@/src/db', async () => {
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const biometricsSchema = await import('@/src/db/biometrics-schema')
  const primary = new BetterSqlite3(':memory:')
  primary.pragma('foreign_keys = ON')
  const bio = new BetterSqlite3(':memory:')
  bio.pragma('foreign_keys = ON')
  return {
    db: drizzle(primary, { schema }),
    biometricsDb: drizzle(bio, { schema: biometricsSchema }),
    sqlite: primary,
    biometricsSqlite: bio,
    closeDatabase: vi.fn(),
    closeBiometricsDatabase: vi.fn(),
  }
})

vi.mock('../pumpStallGuard', () => ({
  onFrame: vi.fn().mockResolvedValue(undefined),
}))

import * as dbModule from '@/src/db'
import { onFrame } from '../pumpStallGuard'
import { DeviceStateSync, _resetMutationStamps } from '../deviceStateSync'
import { DEFAULT_HEATING_DURATION } from '../types'

const { sqlite, biometricsSqlite } = dbModule as typeof dbModule & {
  sqlite: BetterSqlite3.Database
  biometricsSqlite: BetterSqlite3.Database
}

function resetSchema(): void {
  ;(sqlite as any).exec(`
    DROP TABLE IF EXISTS device_state;
    CREATE TABLE device_state (
      side TEXT PRIMARY KEY,
      current_temperature REAL,
      target_temperature REAL,
      is_powered INTEGER NOT NULL DEFAULT 0,
      is_alarm_vibrating INTEGER NOT NULL DEFAULT 0,
      water_level TEXT DEFAULT 'unknown',
      powered_on_at INTEGER,
      last_updated INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
  ;(biometricsSqlite as any).exec(`
    DROP TABLE IF EXISTS water_level_readings;
    DROP TABLE IF EXISTS flow_readings;
    CREATE TABLE water_level_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      level TEXT NOT NULL,
      raw INTEGER,
      calibrated_empty INTEGER,
      calibrated_full INTEGER
    );
    CREATE TABLE flow_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      left_flowrate_cd INTEGER,
      right_flowrate_cd INTEGER,
      left_pump_rpm INTEGER NOT NULL,
      right_pump_rpm INTEGER NOT NULL
    );
  `)
}

function seedSide(
  side: 'left' | 'right',
  isPowered: boolean,
  targetTemp: number | null = null,
  poweredOnAtMs: number | null = Date.now(),
): void {
  ;(sqlite as any)
    .prepare(
      `INSERT INTO device_state (side, is_powered, target_temperature, powered_on_at, last_updated)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(side) DO UPDATE SET
         is_powered = excluded.is_powered,
         target_temperature = excluded.target_temperature,
         powered_on_at = excluded.powered_on_at,
         last_updated = unixepoch()`
    )
    .run(
      side,
      isPowered ? 1 : 0,
      targetTemp,
      isPowered && poweredOnAtMs != null ? Math.floor(poweredOnAtMs / 1000) : null,
    )
}

/** DeviceStatus with both sides mid-session (powered, countdown running). */
function status(overrides: {
  targetLevel?: number
  heatingDuration?: number
  isPriming?: boolean
} = {}): DeviceStatus {
  const side: DeviceStatus['rightSide'] = {
    currentTemperature: 75,
    targetTemperature: 75,
    currentLevel: 5,
    targetLevel: overrides.targetLevel ?? 5,
    heatingDuration: overrides.heatingDuration ?? 7200,
  }
  return {
    leftSide: { ...side },
    rightSide: { ...side },
    waterLevel: 'ok',
    isPriming: overrides.isPriming ?? false,
    podVersion: 'H00' as DeviceStatus['podVersion'],
    sensorLabel: 'test',
  }
}

function frame(opts: { rpm?: number, duty?: number | null } = {}): Record<string, unknown> {
  const pump: any = { rpm: opts.rpm ?? 0 }
  if (opts.duty !== null && opts.duty !== undefined) pump.duty = opts.duty
  return {
    left: { pump: { ...pump }, temps: { flowrate: 25.0 } },
    right: { pump: { ...pump }, temps: { flowrate: 25.0 } },
  }
}

function asymmetricFrame(leftRpm: number, rightRpm: number): Record<string, unknown> {
  return {
    left: { pump: { rpm: leftRpm }, temps: { flowrate: 25.0 } },
    right: { pump: { rpm: rightRpm }, temps: { flowrate: 25.0 } },
  }
}

async function lastGuardInput(side: 'left' | 'right') {
  // runStallGuard is fire-and-forget; let its microtask settle.
  await Promise.resolve()
  await Promise.resolve()
  const calls = vi.mocked(onFrame).mock.calls
    .map(([input]) => input)
    .filter(input => input.side === side)
  return calls[calls.length - 1]
}

async function recordSustainedBilateralStop(
  sync: DeviceStateSync,
  duty: number | null = null,
): Promise<void> {
  sync.recordFlowData(frame({ rpm: 1_900, duty }))
  await lastGuardInput('left')
  sync.recordFlowData(frame({ rpm: 0, duty })) // one-frame deglitch
  sync.recordFlowData(frame({ rpm: 0, duty })) // sustained stop reaches guard
}

describe('DeviceStateSync — stall guard expected-stop suppression', () => {
  let sync: DeviceStateSync

  beforeEach(() => {
    resetSchema()
    _resetMutationStamps()
    vi.mocked(onFrame).mockClear()
    sync = new DeviceStateSync()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T08:00:00Z'))
    // DB says both sides are commanded active — the pre-fix code would
    // derive expectedActive=true from this alone.
    seedSide('left', true, 75)
    seedSide('right', true, 75)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('mid-session zero RPM still reaches the guard as expectedActive=true (real stall)', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 7200 }))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
    expect((await lastGuardInput('right'))?.expectedActive).toBe(true)
  })

  it('suppresses when firmware pump duty is 0 (commanded stop, not a stall)', async () => {
    sync.recordFlowData(frame({ rpm: 0, duty: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('does not suppress on duty alone when duty > 0 (stalled pump still driven)', async () => {
    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('duty > 0 overrides priming — a driven-but-stopped pump is a stall even mid-prime', async () => {
    await sync.sync(status({ isPriming: true }))
    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('duty > 0 overrides the session-end grace window', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 60 }))
    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('falls back to device_state when the frame omits duty', async () => {
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('suppresses while priming', async () => {
    await sync.sync(status({ isPriming: true }))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('suppresses within the grace window after priming ends, then resumes', async () => {
    await sync.sync(status({ isPriming: true }))
    await sync.sync(status({ isPriming: false }))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)

    vi.setSystemTime(new Date('2026-07-11T08:02:01Z')) // 121s after prime end
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('does not suppress at the exact 120-second post-prime boundary', async () => {
    await sync.sync(status({ isPriming: true }))
    await sync.sync(status({ isPriming: false }))
    vi.advanceTimersByTime(120_000)

    sync.recordFlowData(frame({ rpm: 0 }))

    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('does not invent a prime grace period when primeEndedAt is still zero', async () => {
    vi.setSystemTime(new Date(60_000))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('suppresses when firmware targetLevel is 0 while device_state still says powered', async () => {
    // The field-observed failure: firmware commanded neutral, but
    // device_state.isPowered stays true because durationExpired requires
    // heatingDuration=0 too and currentLevel is still non-zero.
    await sync.sync(status({ targetLevel: 0, heatingDuration: 600 }))
    seedSide('left', true, 75) // sync's upsert may have flipped it; force the lagging-DB state
    seedSide('right', true, 75)
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('treats a neutral firmware target as stopped even while duty is stale and non-zero', async () => {
    await sync.sync(status({ targetLevel: 0, heatingDuration: 0 }))
    seedSide('left', true, 75)
    seedSide('right', true, 75)

    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))

    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
    expect((await lastGuardInput('right'))?.expectedActive).toBe(false)
  })

  it('stops trusting a stale neutral-target snapshot', async () => {
    await sync.sync(status({ targetLevel: 0, heatingDuration: 0 }))
    seedSide('left', true, 75)
    vi.advanceTimersByTime(601_000)

    sync.recordFlowData(frame({ rpm: 0 }))

    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('lets positive duty expose a stall once the neutral snapshot is older than 90 seconds', async () => {
    await sync.sync(status({ targetLevel: 0, heatingDuration: 0 }))
    seedSide('left', true, 75)
    vi.advanceTimersByTime(91_000)

    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))

    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('does not trust a neutral snapshot dated in the future after clock rollback', async () => {
    await sync.sync(status({ targetLevel: 0, heatingDuration: 0 }))
    seedSide('left', true, 75)
    vi.setSystemTime(new Date('2026-07-11T07:59:59Z'))

    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))

    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('suppresses inside the session-end grace window (countdown nearly elapsed)', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 60 }))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('suppresses at exactly the 90-second session-end grace boundary', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 90 }))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('still suppresses at exactly the 600-second stale boundary', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 300 }))
    vi.advanceTimersByTime(900_000)
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('projects the countdown forward from the last poll', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 300 }))
    // No further polls; 250s later the projected remaining is ~50s ≤ grace.
    vi.setSystemTime(new Date('2026-07-11T08:04:10Z'))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('stops trusting the projected countdown long past its end (stale snapshot)', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 300 }))
    // 1000s later the projection is 700s past the session end — beyond the
    // 600s staleness bound, so a genuine stall in a later session is not
    // masked by the old snapshot.
    vi.setSystemTime(new Date('2026-07-11T08:16:40Z'))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('feeds the guard the projected remaining session seconds, not the 8h default', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 7200 }))
    vi.setSystemTime(new Date('2026-07-11T08:01:00Z')) // 60s after the poll
    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))

    const input = await lastGuardInput('left')
    expect(input?.expectedActive).toBe(true)
    expect(input?.preStallDurationSeconds).toBe(7140)
  })

  it('feeds a null snapshot duration when firmware reports no countdown', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))

    const input = await lastGuardInput('left')
    expect(input?.expectedActive).toBe(true)
    expect(input?.preStallDurationSeconds).toBeNull()
  })

  it('feeds a null snapshot duration once the projected countdown reaches zero', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 300 }))
    vi.setSystemTime(new Date('2026-07-11T08:05:00Z')) // exactly 300s later
    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))

    const input = await lastGuardInput('left')
    expect(input?.expectedActive).toBe(true) // duty > 0 keeps a real stall visible
    expect(input?.preStallDurationSeconds).toBeNull()
  })

  it('feeds a null snapshot duration on suppressed frames', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 7200 }))
    sync.recordFlowData(frame({ rpm: 0, duty: 0 }))

    const input = await lastGuardInput('left')
    expect(input?.expectedActive).toBe(false)
    expect(input?.preStallDurationSeconds).toBeNull()
  })

  it('does not treat heatingDuration=0 with a non-neutral target as session end', async () => {
    // A firmware variant reporting no countdown during an active session
    // must stay on the plain device_state path, not be suppressed forever.
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('suppresses a no-countdown firmware stop at the persisted eight-hour boundary', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    const startedAt = Date.now() - DEFAULT_HEATING_DURATION * 1000
    seedSide('left', true, 75, startedAt)
    seedSide('right', true, 75, startedAt)

    sync.recordFlowData(frame({ rpm: 1_900 }))
    await lastGuardInput('left')
    sync.recordFlowData(frame({ rpm: 0 }))
    vi.advanceTimersByTime(39_000)
    sync.recordFlowData(frame({ rpm: 0 }))

    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
    expect((await lastGuardInput('right'))?.expectedActive).toBe(false)
    expect((await lastGuardInput('left'))?.preStallDurationSeconds).toBeNull()
  })

  it('does not suppress a driven no-countdown stall at the eight-hour boundary', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    seedSide('left', true, 75, Date.now() - DEFAULT_HEATING_DURATION * 1000)

    await recordSustainedBilateralStop(sync, 65)

    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('does not suppress an asymmetric no-countdown stall at the eight-hour boundary', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    seedSide('left', true, 75, Date.now() - DEFAULT_HEATING_DURATION * 1000)

    sync.recordFlowData(asymmetricFrame(0, 1_900))

    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('does not infer a session end when only the last running side stops', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    const startedAt = Date.now() - DEFAULT_HEATING_DURATION * 1000
    seedSide('left', true, 75, startedAt)
    seedSide('right', true, 75, startedAt)

    sync.recordFlowData(asymmetricFrame(1_900, 0))
    await lastGuardInput('left')
    sync.recordFlowData(frame({ rpm: 0 }))

    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it.each([
    [1_499, true],
    [1_500, false],
  ])('bounds healthy pre-stop evidence at %s RPM', async (rpm, expectedActive) => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    const startedAt = Date.now() - DEFAULT_HEATING_DURATION * 1000
    seedSide('left', true, 75, startedAt)
    seedSide('right', true, 75, startedAt)

    sync.recordFlowData(frame({ rpm }))
    await lastGuardInput('left')
    sync.recordFlowData(frame({ rpm: 0 }))
    sync.recordFlowData(frame({ rpm: 0 }))

    expect((await lastGuardInput('left'))?.expectedActive).toBe(expectedActive)
  })

  it.each([
    [30_000, false],
    [30_001, true],
  ])('bounds healthy pre-stop evidence age at %sms', async (evidenceAgeMs, expectedActive) => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    const startedAt = Date.now() - DEFAULT_HEATING_DURATION * 1000
    seedSide('left', true, 75, startedAt)
    seedSide('right', true, 75, startedAt)

    sync.recordFlowData(frame({ rpm: 1_900 }))
    await lastGuardInput('left')
    vi.advanceTimersByTime(evidenceAgeMs)
    sync.recordFlowData(frame({ rpm: 0 }))
    sync.recordFlowData(frame({ rpm: 0 }))

    expect((await lastGuardInput('left'))?.expectedActive).toBe(expectedActive)
  })

  it('prefers a live positive countdown over the older powered-on timestamp', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 600 }))
    seedSide('left', true, 75, Date.now() - DEFAULT_HEATING_DURATION * 1000)

    await recordSustainedBilateralStop(sync)

    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('stops trusting a no-countdown session timestamp long past its expected end', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    const startedAt = Date.now() - (DEFAULT_HEATING_DURATION + 601) * 1000
    seedSide('left', true, 75, startedAt)

    await recordSustainedBilateralStop(sync)

    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it.each([
    [-91, true],
    [-90, false],
    [90, false],
    [91, true],
  ])('bounds no-countdown expiry suppression at a signed offset of %ss', async (secondsPastEnd, expectedActive) => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    const startedAt = Date.now() - (DEFAULT_HEATING_DURATION + secondsPastEnd) * 1000
    seedSide('left', true, 75, startedAt)
    seedSide('right', true, 75, startedAt)

    await recordSustainedBilateralStop(sync)

    expect((await lastGuardInput('left'))?.expectedActive).toBe(expectedActive)
  })

  it('requires a persisted powered-on timestamp for no-countdown suppression', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    seedSide('left', true, 75, null)

    await recordSustainedBilateralStop(sync)

    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('does not mistake a one-hour no-countdown stop for the default eight-hour expiry', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    seedSide('left', true, 75, Date.now() - 3_600_000)

    await recordSustainedBilateralStop(sync)

    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it.each([
    [false, 75, false, 75],
    [true, null, false, null],
    [false, null, false, null],
  ])('requires powered=%s and target=%s together', async (isPowered, target, expectedActive, preStallTarget) => {
    seedSide('left', isPowered, target)
    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))

    expect(await lastGuardInput('left')).toEqual(expect.objectContaining({
      expectedActive,
      preStallTarget,
      preStallDurationSeconds: null,
    }))
  })

  it('passes an absent row to the guard as inactive with a null snapshot', async () => {
    ;(sqlite as any).exec('DELETE FROM device_state WHERE side = \'left\'')
    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))

    expect(await lastGuardInput('left')).toEqual(expect.objectContaining({
      expectedActive: false,
      preStallTarget: null,
      preStallDurationSeconds: null,
    }))
  })
})

describe('DeviceStateSync — stall guard coalescing', () => {
  let sync: DeviceStateSync

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }

  const leftInputs = () => vi.mocked(onFrame).mock.calls
    .map(([input]) => input)
    .filter(input => input.side === 'left')

  beforeEach(() => {
    resetSchema()
    _resetMutationStamps()
    vi.mocked(onFrame).mockClear()
    vi.mocked(onFrame).mockResolvedValue(undefined)
    sync = new DeviceStateSync()
    seedSide('left', true, 75)
    seedSide('right', true, 75)
  })

  it('keeps only the newest frame while a guard pass is in flight', async () => {
    let resolveFirst!: () => void
    vi.mocked(onFrame).mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveFirst = resolve
      }),
    )

    sync.recordFlowData(frame({ rpm: 100 }))
    await flush()
    expect(leftInputs()).toHaveLength(1)
    expect(leftInputs()[0]?.rpm).toBe(100)

    // Two more frames land while the first pass awaits hardware — the
    // intermediate one must be dropped, not queued.
    sync.recordFlowData(frame({ rpm: 200 }))
    sync.recordFlowData(frame({ rpm: 300 }))
    await flush()
    expect(leftInputs()).toHaveLength(1)

    resolveFirst()
    await flush()
    expect(leftInputs()).toHaveLength(2)
    expect(leftInputs()[1]?.rpm).toBe(300)
  })

  it('releases the in-flight slot so later frames run immediately', async () => {
    sync.recordFlowData(frame({ rpm: 100 }))
    await flush()
    sync.recordFlowData(frame({ rpm: 200 }))
    await flush()
    expect(leftInputs()).toHaveLength(2)
    expect(leftInputs()[1]?.rpm).toBe(200)
  })

  it('stamps guard inputs with frame arrival time, not queue-drain time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_000_000))
    let resolveFirst!: () => void
    vi.mocked(onFrame).mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveFirst = resolve
      }),
    )

    sync.recordFlowData(frame({ rpm: 100 }))
    await flush()
    vi.setSystemTime(new Date(1_030_000))
    sync.recordFlowData(frame({ rpm: 300 }))
    await flush()

    // The queued frame drains much later — its dwell-clock stamp must stay the
    // arrival time, or a lock-hold would fabricate elapsed low time.
    vi.setSystemTime(new Date(1_090_000))
    resolveFirst()
    await flush()

    expect(leftInputs()[0]?.now).toBe(1_000_000)
    expect(leftInputs()[1]?.now).toBe(1_030_000)
    vi.useRealTimers()
  })
})

describe('DeviceStateSync — bilateral-zero de-glitch', () => {
  let sync: DeviceStateSync

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }
  const leftCalls = () => vi.mocked(onFrame).mock.calls
    .map(([input]) => input)
    .filter(input => input.side === 'left')

  beforeEach(() => {
    resetSchema()
    _resetMutationStamps()
    vi.mocked(onFrame).mockClear()
    vi.mocked(onFrame).mockResolvedValue(undefined)
    sync = new DeviceStateSync()
    seedSide('left', true, 75)
    seedSide('right', true, 75)
  })

  it('drops one both-zero frame immediately after both pumps were running', async () => {
    sync.recordFlowData(frame({ rpm: 1_900 }))
    await flush()
    sync.recordFlowData(frame({ rpm: 0 }))
    await flush()

    expect(leftCalls()).toHaveLength(1)
    expect(leftCalls()[0]?.rpm).toBe(1_900)
  })

  it('feeds a bilateral zero once it persists for another frame', async () => {
    sync.recordFlowData(frame({ rpm: 1_900 }))
    await flush()
    sync.recordFlowData(frame({ rpm: 0 }))
    await flush()
    sync.recordFlowData(frame({ rpm: 0 }))
    await flush()

    expect(leftCalls()).toHaveLength(2)
    expect(leftCalls()[1]?.rpm).toBe(0)
  })

  it('does not suppress a one-sided zero-RPM frame', async () => {
    sync.recordFlowData(frame({ rpm: 1_900 }))
    await flush()
    sync.recordFlowData(asymmetricFrame(0, 1_900))
    await flush()

    expect(leftCalls()).toHaveLength(2)
    expect(leftCalls()[1]?.rpm).toBe(0)
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any */
import { resetControlDatabase } from '@/src/temperature/tests/databaseFixture'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import type { OccupancyResult } from '@/src/lib/occupancy'

// ── Shared mocks ──────────────────────────────────────────────────────────
const connect = vi.fn(async () => {})
interface PowerOnStatus { source: null, requestId: null, targetTemperature: number, holdUntil: null, blocked: null }
const powerOnLocked = vi.fn<(side: 'left' | 'right', fallback?: number) => Promise<PowerOnStatus>>(async () => ({
  source: null, requestId: null, targetTemperature: 72, holdUntil: null, blocked: null,
}))
const broadcastMutationStatus = vi.fn()
const markSideMutated = vi.fn()
const cancelAutoOffTimer = vi.fn()
const releaseHeldPowerOff = vi.fn()
const shouldBlock = vi.fn<(side: 'left' | 'right') => boolean>(() => false)

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ connect }),
}))
vi.mock('@/src/temperature/instance', () => ({
  getTemperatureController: () => ({ powerOnLocked }),
}))
vi.mock('@/src/streaming/broadcastMutationStatus', () => ({
  broadcastMutationStatus: (...args: unknown[]) => broadcastMutationStatus(...args),
}))
vi.mock('@/src/hardware/deviceStateSync', () => ({
  markSideMutated: (...args: unknown[]) => markSideMutated(...args),
}))
vi.mock('@/src/hardware/pumpStallGuard', () => ({
  shouldBlock: (side: 'left' | 'right') => shouldBlock(side),
}))
vi.mock('@/src/scheduler/instance', () => ({
  getJobManager: async () => ({ releaseHeldPowerOff }),
}))
vi.mock('./../autoOffWatcher', () => ({
  cancelAutoOffTimer: (...args: unknown[]) => cancelAutoOffTimer(...args),
}))

let mockOccupancy: Record<'left' | 'right', OccupancyResult>
let occupancyFailure: unknown = null
/** Per-read overrides for the left side, consumed in order before falling back to mockOccupancy. */
const leftReadQueue: OccupancyResult[] = []

function occ(classification: OccupancyResult['classification'], available = true): OccupancyResult {
  const occupied = classification !== 'none'
  return {
    occupied,
    available,
    classification,
    movement: { active: false, peakScore: 0 },
    level: {
      active: occupied,
      deviation: available ? (occupied ? 12 : 0) : null,
      threshold: available ? 6 : null,
      ageMs: available ? 100 : null,
      zoneDeviations: available ? [4, 4, 4] : null,
      zones: available ? (classification === 'person' ? 3 : classification === 'light' ? 1 : 0) : null,
    },
    vitals: { heartRate: null, breathingRate: null, humanRange: null },
  }
}

vi.mock('@/src/lib/occupancy', () => ({
  getOccupancy: (side: 'left' | 'right') => {
    if (occupancyFailure !== null) throw occupancyFailure
    const queued = side === 'left' ? leftReadQueue.shift() : undefined
    if (queued) return queued
    return mockOccupancy[side]
  },
}))

vi.mock('@/src/db', async () => {
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const primary = new BetterSqlite3(':memory:')
  primary.pragma('foreign_keys = ON')
  return {
    db: drizzle(primary, { schema }),
    sqlite: primary,
    closeDatabase: vi.fn(),
  }
})

import * as dbModule from '@/src/db'
import { withSideLock } from '@/src/hardware/sideLock'
import { _resetMutationStamps, markSideMutated as stampSideMutation } from '@/src/hardware/sideMutations'
import {
  inWindow,
  localMinutes,
  restartAutoOnWatcher,
  startAutoOnWatcher,
  stopAutoOnWatcher,
} from '@/src/services/autoOnWatcher'

const { sqlite } = dbModule as typeof dbModule & { sqlite: BetterSqlite3.Database }

const POLL_MS = 30_000
const MIN = 60_000
// 2026-06-01T03:00Z — 03:00 in the UTC device timezone, inside the default 20:00–08:00 window.
const NIGHT = new Date('2026-06-01T03:00:00Z')

function resetSchema(): void {
  resetControlDatabase(sqlite)
  sqlite.exec(`INSERT INTO device_settings (id, timezone) VALUES (1, 'UTC');
    INSERT INTO side_settings (side, name, auto_on_enabled, auto_on_minutes)
      VALUES ('left', 'Left', 1, 5), ('right', 'Right', 0, 5);
    INSERT INTO device_state (side, is_powered) VALUES ('left', 0), ('right', 0);`)
}

function setPowered(side: 'left' | 'right', powered: boolean, target: number | null = null): void {
  ;(sqlite as any)
    .prepare('UPDATE device_state SET is_powered=?, target_temperature=? WHERE side=?')
    .run(powered ? 1 : 0, target, side)
}

function setSideSettings(side: 'left' | 'right', patch: Partial<{
  autoOnEnabled: number
  autoOnMinutes: number
  autoOnStart: string
  autoOnEnd: string
  awayMode: number
}>): void {
  const current = (sqlite as any).prepare('SELECT * FROM side_settings WHERE side=?').get(side)
  ;(sqlite as any)
    .prepare('UPDATE side_settings SET auto_on_enabled=?, auto_on_minutes=?, auto_on_start=?, auto_on_end=?, away_mode=? WHERE side=?')
    .run(
      patch.autoOnEnabled ?? current.auto_on_enabled,
      patch.autoOnMinutes ?? current.auto_on_minutes,
      patch.autoOnStart ?? current.auto_on_start,
      patch.autoOnEnd ?? current.auto_on_end,
      patch.awayMode ?? current.away_mode,
      side,
    )
}

function insertActiveRunOnce(side: 'left' | 'right'): void {
  ;(sqlite as any)
    .prepare(`INSERT INTO run_once_sessions (side, set_points, wake_time, expires_at, status)
      VALUES (?, '[]', '07:00', ?, 'active')`)
    .run(side, Math.floor(Date.now() / 1000) + 3600)
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NIGHT)
  connect.mockClear()
  powerOnLocked.mockClear()
  broadcastMutationStatus.mockClear()
  markSideMutated.mockClear()
  cancelAutoOffTimer.mockClear()
  releaseHeldPowerOff.mockClear()
  shouldBlock.mockReset()
  shouldBlock.mockImplementation(() => false)
  occupancyFailure = null
  leftReadQueue.length = 0
  _resetMutationStamps()
  resetSchema()
  mockOccupancy = { left: occ('none'), right: occ('none') }
})

afterEach(async () => {
  await stopAutoOnWatcher()
  vi.useRealTimers()
})

describe('autoOnWatcher — dwell and power-on', () => {
  it('powers a side on once a person has been in bed for the dwell', async () => {
    mockOccupancy.left = occ('person')
    startAutoOnWatcher() // poll@0 stamps personSince
    expect(powerOnLocked).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(powerOnLocked).toHaveBeenCalledWith('left', 75, expect.any(Function))
    expect(powerOnLocked).toHaveBeenCalledTimes(1)
  })

  it('does not fire before the dwell elapses', async () => {
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(4 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('runs the full scheduler-style power-on sequence', async () => {
    mockOccupancy.left = occ('person')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(markSideMutated).toHaveBeenCalledWith('left')
    expect(releaseHeldPowerOff).toHaveBeenCalledWith('left')
    expect(connect).toHaveBeenCalledOnce()
    expect(cancelAutoOffTimer).toHaveBeenCalledWith('left')
    expect(broadcastMutationStatus).toHaveBeenCalledWith('left', {})
    expect(log).toHaveBeenCalledWith('[auto-on] left: person in bed, auto-on in 5min if still present')
    expect(log).toHaveBeenCalledWith('[auto-on] Powered on left side (person in bed 5min) → 72°F')
  })

  it('uses the last target seen while powered as the fallback setpoint', async () => {
    setPowered('left', true, 68)
    startAutoOnWatcher() // observes powered + target 68
    setPowered('left', false) // off with nobody in bed → no suppression
    await vi.advanceTimersByTimeAsync(POLL_MS)
    mockOccupancy.left = occ('person')
    await vi.advanceTimersByTimeAsync(6 * MIN)
    expect(powerOnLocked).toHaveBeenCalledWith('left', 68, expect.any(Function))
  })

  it('resets the dwell when the person leaves mid-countdown', async () => {
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(3 * MIN)
    mockOccupancy.left = occ('none')
    await vi.advanceTimersByTimeAsync(POLL_MS)
    mockOccupancy.left = occ('person')
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(powerOnLocked).toHaveBeenCalledTimes(1)
  })

  it('honours a custom dwell', async () => {
    setSideSettings('left', { autoOnMinutes: 1 })
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(MIN)
    expect(powerOnLocked).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a side that is already powered', async () => {
    setPowered('left', true, 70)
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('does not re-fire while a power-on is in flight', async () => {
    let release: () => void = () => {}
    powerOnLocked.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ source: null, requestId: null, targetTemperature: 72, holdUntil: null, blocked: null })
    }))
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(powerOnLocked).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('logs and survives a hardware failure', async () => {
    connect.mockRejectedValueOnce(new Error('offline'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(error).toHaveBeenCalledWith('[auto-on] Failed to power on left:', 'offline')
    expect(broadcastMutationStatus).not.toHaveBeenCalled()
  })
})

describe('autoOnWatcher — pets and unsensable presence', () => {
  it('never fires on a light load (pet)', async () => {
    mockOccupancy.left = occ('light')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('a pet interrupting the dwell resets it', async () => {
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(4 * MIN)
    mockOccupancy.left = occ('light')
    await vi.advanceTimersByTimeAsync(POLL_MS)
    mockOccupancy.left = occ('person')
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('never fires when presence cannot be sensed', async () => {
    mockOccupancy.left = occ('person', false)
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('treats a thrown occupancy read as unsensable', async () => {
    occupancyFailure = new Error('sensor read failed')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })
})

describe('autoOnWatcher — suppression after an intentional off', () => {
  it('stands down when the side is turned off with a person still in bed', async () => {
    setPowered('left', true, 70)
    mockOccupancy.left = occ('person')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    startAutoOnWatcher()
    setPowered('left', false) // manual / scheduled off while occupied
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[auto-on] left: turned off with a person in bed, standing down until the bed clears')
  })

  it('re-arms once the bed has been clear for the dwell', async () => {
    setPowered('left', true, 70)
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    setPowered('left', false)
    await vi.advanceTimersByTimeAsync(10 * MIN) // suppressed
    mockOccupancy.left = occ('none')
    await vi.advanceTimersByTimeAsync(5 * MIN + POLL_MS) // clear for the dwell → re-armed
    mockOccupancy.left = occ('person')
    await vi.advanceTimersByTimeAsync(5 * MIN + POLL_MS)
    expect(powerOnLocked).toHaveBeenCalledTimes(1)
  })

  it('a brief absence shorter than the dwell does not re-arm', async () => {
    setPowered('left', true, 70)
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    setPowered('left', false)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    mockOccupancy.left = occ('none')
    await vi.advanceTimersByTimeAsync(2 * MIN) // bathroom trip
    mockOccupancy.left = occ('person')
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('tracks the off transition even while the feature is disabled', async () => {
    setSideSettings('left', { autoOnEnabled: 0 })
    setPowered('left', true, 70)
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    setPowered('left', false)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    setSideSettings('left', { autoOnEnabled: 1 })
    restartAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('stands down after an on→off that lands between two polls', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.advanceTimersByTimeAsync(1000)
    mockOccupancy.left = occ('person')
    stampSideMutation('left') // switched on and straight back off before the next poll
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[auto-on] left: turned off with a person in bed, standing down until the bed clears')
  })

  it('stands down when its own power-on is switched off before the next poll', async () => {
    // powerOnLocked is mocked, so device_state never reads powered: exactly
    // what a manual off inside the poll interval looks like.
    mockOccupancy.left = occ('person')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(powerOnLocked).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[auto-on] left: turned off with a person in bed, standing down until the bed clears')
  })

  it('an unsensable gap restarts the bed-clear countdown', async () => {
    setPowered('left', true, 70)
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    setPowered('left', false)
    await vi.advanceTimersByTimeAsync(POLL_MS) // suppressed
    mockOccupancy.left = occ('none')
    await vi.advanceTimersByTimeAsync(3 * MIN)
    mockOccupancy.left = occ('none', false)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    mockOccupancy.left = occ('none')
    await vi.advanceTimersByTimeAsync(3 * MIN) // 6.5 min since the first clear reading, 3 since the gap
    mockOccupancy.left = occ('person')
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('an off while the bed is empty does not suppress', async () => {
    setPowered('left', true, 70)
    startAutoOnWatcher()
    setPowered('left', false)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    mockOccupancy.left = occ('person')
    await vi.advanceTimersByTimeAsync(6 * MIN)
    expect(powerOnLocked).toHaveBeenCalledTimes(1)
  })
})

describe('autoOnWatcher — gates', () => {
  it('is off by default for a side with autoOnEnabled=false', async () => {
    mockOccupancy.right = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('leaves a side with no settings row disabled', async () => {
    ;(sqlite as any).exec('DELETE FROM side_settings')
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('skips a side in away mode', async () => {
    setSideSettings('left', { awayMode: 1 })
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('skips a side with an active run-once session', async () => {
    insertActiveRunOnce('left')
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('skips when the pump stall guard blocks the side', async () => {
    shouldBlock.mockImplementation(side => side === 'left')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[auto-on] left: skipped, pump stall guard blocks the side')
  })

  it('re-checks eligibility under the side lock', async () => {
    mockOccupancy.left = occ('person')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(5 * MIN - POLL_MS)
    // The firing poll reads presence once to decide, then once more under the
    // lock. The person leaves in between.
    leftReadQueue.push(occ('person'), occ('none'))
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(powerOnLocked).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[auto-on] left: power-on skipped, no longer eligible')
  })

  it('re-checks the window under the side lock', async () => {
    setSideSettings('left', { autoOnStart: '20:00', autoOnEnd: '03:10' }) // now is 03:00 UTC
    mockOccupancy.left = occ('person')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    let releaseLock!: () => void
    void withSideLock('left', () => new Promise<void>((resolve) => {
      releaseLock = resolve
    }))
    startAutoOnWatcher()
    // The dwell elapses inside the window, but the power-on waits behind the
    // held lock until the window has closed.
    await vi.advanceTimersByTimeAsync(11 * MIN)
    releaseLock()
    await vi.advanceTimersByTimeAsync(0)
    expect(powerOnLocked).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[auto-on] left: power-on skipped, no longer eligible')
  })

  it('re-reads the settings under the side lock', async () => {
    mockOccupancy.left = occ('person')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    let releaseLock!: () => void
    void withSideLock('left', () => new Promise<void>((resolve) => {
      releaseLock = resolve
    }))
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(5 * MIN + POLL_MS)
    setSideSettings('left', { autoOnEnabled: 0 }) // disabled while the power-on waits
    releaseLock()
    await vi.advanceTimersByTimeAsync(0)
    expect(powerOnLocked).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[auto-on] left: power-on skipped, no longer eligible')
  })

  it('a settings change drops a queued power-on', async () => {
    mockOccupancy.left = occ('person')
    let releaseLock!: () => void
    void withSideLock('left', () => new Promise<void>((resolve) => {
      releaseLock = resolve
    }))
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(5 * MIN + POLL_MS)
    restartAutoOnWatcher()
    releaseLock()
    await vi.advanceTimersByTimeAsync(0)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('only fires inside the configured window', async () => {
    setSideSettings('left', { autoOnStart: '21:00', autoOnEnd: '23:00' }) // now is 03:00 UTC
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('fires at any time when start and end are equal', async () => {
    setSideSettings('left', { autoOnStart: '12:00', autoOnEnd: '12:00' })
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(powerOnLocked).toHaveBeenCalledTimes(1)
  })

  it('evaluates the window in the device timezone', async () => {
    // 03:00 UTC is 20:00 the previous evening in Los Angeles (PDT): inside a 19:00–21:00 window.
    ;(sqlite as any).exec(`UPDATE device_settings SET timezone='America/Los_Angeles' WHERE id=1`)
    setSideSettings('left', { autoOnStart: '19:00', autoOnEnd: '21:00' })
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(powerOnLocked).toHaveBeenCalledTimes(1)
  })
})

describe('autoOnWatcher — lifecycle', () => {
  it('shares its timer across module instances and stops the original producer', async () => {
    mockOccupancy.left = occ('person')
    const interval = vi.spyOn(globalThis, 'setInterval')
    startAutoOnWatcher()
    vi.resetModules()
    const duplicate = await import('../autoOnWatcher')
    duplicate.startAutoOnWatcher()
    expect(interval).toHaveBeenCalledOnce()
    await duplicate.stopAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('start is idempotent and stop awaits in-flight power-ons', async () => {
    let release: () => void = () => {}
    powerOnLocked.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ source: null, requestId: null, targetTemperature: 72, holdUntil: null, blocked: null })
    }))
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(5 * MIN)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stopping = stopAutoOnWatcher()
    expect(stopAutoOnWatcher()).toBe(stopping)
    expect(() => startAutoOnWatcher()).toThrow('stopping')
    release()
    await stopping
    expect(log).toHaveBeenCalledWith('[auto-on] Waiting for 1 in-flight power-on(s)...')
    expect(log).toHaveBeenCalledWith('[auto-on] Watcher stopped')
  })

  it('stop drops a power-on still waiting for the side lock', async () => {
    mockOccupancy.left = occ('person')
    let releaseLock!: () => void
    void withSideLock('left', () => new Promise<void>((resolve) => {
      releaseLock = resolve
    }))
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(5 * MIN + POLL_MS)
    const stopping = stopAutoOnWatcher()
    releaseLock()
    await stopping
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('restart is a no-op when the watcher is not running', () => {
    expect(() => restartAutoOnWatcher()).not.toThrow()
    expect(powerOnLocked).not.toHaveBeenCalled()
  })

  it('restart resets the dwell countdown', async () => {
    mockOccupancy.left = occ('person')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(4 * MIN)
    restartAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(powerOnLocked).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3 * MIN + POLL_MS)
    expect(powerOnLocked).toHaveBeenCalledTimes(1)
  })

  it('logs and continues when a side evaluation throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(sqlite as any).exec('DROP TABLE device_state')
    startAutoOnWatcher()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    // readPower swallows its own errors; nothing should surface as an evaluation error.
    expect(error).not.toHaveBeenCalled()
    expect(powerOnLocked).not.toHaveBeenCalled()
  })
})

describe('inWindow / localMinutes', () => {
  it('handles same-day, midnight-wrapping and always windows', () => {
    expect(inWindow(10 * 60, '09:00', '11:00')).toBe(true)
    expect(inWindow(11 * 60, '09:00', '11:00')).toBe(false) // half-open end
    expect(inWindow(9 * 60, '09:00', '11:00')).toBe(true) // inclusive start
    expect(inWindow(23 * 60, '20:00', '08:00')).toBe(true)
    expect(inWindow(3 * 60, '20:00', '08:00')).toBe(true)
    expect(inWindow(12 * 60, '20:00', '08:00')).toBe(false)
    expect(inWindow(12 * 60, '08:00', '08:00')).toBe(true)
  })

  it('rejects malformed times', () => {
    expect(inWindow(600, '9:00', '11:00')).toBe(false)
    expect(inWindow(600, '09:00', '24:00')).toBe(false)
  })

  it('converts to the device timezone and falls back to UTC on a bad zone', () => {
    const t = new Date('2026-06-01T03:00:00Z')
    expect(localMinutes(t, 'UTC')).toBe(180)
    expect(localMinutes(t, 'America/Los_Angeles')).toBe(20 * 60)
    expect(localMinutes(t, 'Not/AZone')).toBe(180)
  })
})

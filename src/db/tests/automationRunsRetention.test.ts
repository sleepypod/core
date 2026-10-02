import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../schema'

// Keep the module-level default handle off the real sleepypod.db.
const mockState = vi.hoisted(() => ({ sqlite: null as Database.Database | null }))

vi.mock('../index', () => ({
  get sqlite() {
    if (!mockState.sqlite) throw new Error('sqlite mock not initialised')
    return mockState.sqlite
  },
}))

const {
  AUTOMATION_RUNS_TABLE_NAME,
  configuredAutomationRunsRetentionDays,
  pruneOldAutomationRuns,
  startAutomationRunsRetention,
  stopAutomationRunsRetention,
} = await import('../automationRunsRetention')

const DAY = 86_400_000
const originalRetentionDays = process.env.AUTOMATION_RUNS_RETENTION_DAYS

function openTempDb(): { raw: Database.Database, automationId: number } {
  const raw = new Database(':memory:')
  raw.pragma('foreign_keys = ON')
  const db = drizzle(raw, { schema })
  migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations') })
  const { id } = raw
    .prepare(`INSERT INTO automations (name, "trigger", conditions, actions) VALUES ('r', '{}', '{}', '[]') RETURNING id`)
    .get() as { id: number }
  return { raw, automationId: id }
}

function seed(raw: Database.Database, automationId: number, firedAt: number[]): void {
  const stmt = raw.prepare(`INSERT INTO automation_runs (automation_id, fired_at, outcome) VALUES (?, ?, 'skipped')`)
  raw.transaction(() => {
    for (const t of firedAt) stmt.run(automationId, t)
  })()
}

function firedAts(raw: Database.Database): number[] {
  return (raw.prepare('SELECT fired_at FROM automation_runs ORDER BY id').all() as { fired_at: number }[])
    .map(r => r.fired_at)
}

const sec = (ms: number) => Math.floor(ms / 1000)

describe('pruneOldAutomationRuns', () => {
  let raw: Database.Database
  let automationId: number

  beforeEach(() => {
    ({ raw, automationId } = openTempDb())
  })

  afterEach(() => {
    raw.close()
  })

  it('exports the pruned table name', () => {
    expect(AUTOMATION_RUNS_TABLE_NAME).toBe('automation_runs')
  })

  it('deletes rows older than the cutoff and keeps recent ones (seconds)', async () => {
    const now = Date.now()
    seed(raw, automationId, [sec(now - 200 * DAY), sec(now - 91 * DAY), sec(now - 89 * DAY), sec(now)])

    const deleted = await pruneOldAutomationRuns(new Date(now - 90 * DAY), raw)

    expect(deleted).toBe(2)
    expect(firedAts(raw)).toEqual([sec(now - 89 * DAY), sec(now)])
  })

  it('works through more old rows than one batch', async () => {
    const now = Date.now()
    const old = Array.from({ length: 2_503 }, (_, i) => sec(now - 100 * DAY) + i)
    seed(raw, automationId, [...old, sec(now)])
    const batches: number[] = []
    const prepare = raw.prepare.bind(raw)
    vi.spyOn(raw, 'prepare').mockImplementation((source: string) => {
      const stmt = prepare(source)
      const run = stmt.run.bind(stmt)
      return Object.assign(stmt, {
        run: (...args: unknown[]) => {
          const result = run(...args)
          batches.push(result.changes)
          return result
        },
      })
    })

    const deleted = await pruneOldAutomationRuns(new Date(now - 90 * DAY), raw, 500)

    expect(deleted).toBe(2_503)
    expect(batches).toEqual([500, 500, 500, 500, 500, 3])
    expect(firedAts(raw)).toEqual([sec(now)])
  })

  it('stops cleanly when the handle closes mid-pass', async () => {
    const now = Date.now()
    seed(raw, automationId, Array.from({ length: 30 }, (_, i) => sec(now - 100 * DAY) + i))
    const pass = pruneOldAutomationRuns(new Date(now - 90 * DAY), raw, 10)
    raw.close()
    await expect(pass).resolves.toBe(10)
    ;({ raw } = openTempDb())
  })
})

describe('configuredAutomationRunsRetentionDays', () => {
  afterEach(() => {
    if (originalRetentionDays === undefined) Reflect.deleteProperty(process.env, 'AUTOMATION_RUNS_RETENTION_DAYS')
    else process.env.AUTOMATION_RUNS_RETENTION_DAYS = originalRetentionDays
  })

  it('defaults to 90', () => {
    Reflect.deleteProperty(process.env, 'AUTOMATION_RUNS_RETENTION_DAYS')
    expect(configuredAutomationRunsRetentionDays()).toBe(90)
  })

  it('honours a valid override', () => {
    process.env.AUTOMATION_RUNS_RETENTION_DAYS = '14'
    expect(configuredAutomationRunsRetentionDays()).toBe(14)
  })

  it.each(['abc', '0', '-5', 'Infinity'])('falls back to 90 for %s', (value) => {
    process.env.AUTOMATION_RUNS_RETENTION_DAYS = value
    expect(configuredAutomationRunsRetentionDays()).toBe(90)
  })
})

describe('startAutomationRunsRetention / stopAutomationRunsRetention', () => {
  let raw: Database.Database
  let automationId: number

  beforeEach(() => {
    ({ raw, automationId } = openTempDb())
    mockState.sqlite = raw
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopAutomationRunsRetention()
    raw.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
    mockState.sqlite = null
    if (originalRetentionDays === undefined) Reflect.deleteProperty(process.env, 'AUTOMATION_RUNS_RETENTION_DAYS')
    else process.env.AUTOMATION_RUNS_RETENTION_DAYS = originalRetentionDays
  })

  it('runs 30 s after start, then every 24 h, and logs a summary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const now = Date.now()
    seed(raw, automationId, [sec(now - 100 * DAY), sec(now)])

    startAutomationRunsRetention()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(firedAts(raw)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(firedAts(raw)).toEqual([sec(now)])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Pruned 1 automation_runs rows older than 90d'))

    seed(raw, automationId, [sec(Date.now() - 100 * DAY)])
    await vi.advanceTimersByTimeAsync(24 * 3_600_000 - 1)
    expect(firedAts(raw)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(firedAts(raw)).toHaveLength(1)
  })

  it('uses the env retention window and falls back when it is invalid', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const now = Date.now()
    seed(raw, automationId, [sec(now - 10 * DAY), sec(now - 3 * DAY)])

    process.env.AUTOMATION_RUNS_RETENTION_DAYS = 'nope'
    startAutomationRunsRetention({ initialDelayMs: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(firedAts(raw)).toHaveLength(2)
    stopAutomationRunsRetention()

    process.env.AUTOMATION_RUNS_RETENTION_DAYS = '5'
    startAutomationRunsRetention({ initialDelayMs: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(firedAts(raw)).toEqual([sec(now - 3 * DAY)])
  })

  it('does not log when nothing was deleted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    seed(raw, automationId, [sec(Date.now())])
    startAutomationRunsRetention({ initialDelayMs: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(log).not.toHaveBeenCalled()
  })

  it('is idempotent and stop cancels the pending pass', async () => {
    seed(raw, automationId, [sec(Date.now() - 100 * DAY)])
    startAutomationRunsRetention()
    startAutomationRunsRetention()
    expect(vi.getTimerCount()).toBe(1)

    stopAutomationRunsRetention()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(firedAts(raw)).toHaveLength(1)
  })

  it('logs and survives a failing pass', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    raw.exec('DROP TABLE automation_runs')
    startAutomationRunsRetention({ initialDelayMs: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(error).toHaveBeenCalledWith('[retention] automation_runs pass failed:', expect.any(String))
  })
})

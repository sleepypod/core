import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { healthRuns } from '@/src/db/biometrics-schema'
import { loadOpenRuns, readHistory, recordSample, type OpenRun } from '../healthHistory'

const MIN = 60_000
const T0 = Date.UTC(2026, 8, 28, 0, 0, 0)

type Db = ReturnType<typeof drizzle<typeof schema>>

describe('health history', () => {
  let raw: Database.Database
  let db: Db

  beforeEach(() => {
    raw = new Database(':memory:')
    db = drizzle(raw, { schema })
    migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations') })
  })

  afterEach(() => raw.close())

  function sample(open: Map<string, OpenRun>, at: number, status: 'ok' | 'stale' | 'idle' | 'down') {
    recordSample(db, open, [{ id: 'piezo-processor', status, detail: `status ${status}` }], at)
  }

  it('extends one run while the status holds', () => {
    const open = new Map<string, OpenRun>()
    for (let m = 0; m < 10; m++) sample(open, T0 + m * MIN, 'ok')
    const rows = db.select().from(healthRuns).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].lastSeenAt.getTime()).toBe(T0 + 9 * MIN)
  })

  it('starts a new run where the previous ended when the status changes', () => {
    const open = new Map<string, OpenRun>()
    sample(open, T0, 'ok')
    sample(open, T0 + MIN, 'ok')
    sample(open, T0 + 2 * MIN, 'stale')
    const rows = db.select().from(healthRuns).orderBy(healthRuns.startedAt).all()
    expect(rows.map(r => r.status)).toEqual(['ok', 'stale'])
    expect(rows[1].startedAt.getTime()).toBe(T0 + MIN)
  })

  it('leaves a gap after the core was down and resumes a run that just stopped', () => {
    const open = new Map<string, OpenRun>()
    sample(open, T0, 'ok')
    // Core restarts 30 min later: a fresh process has no open runs in memory.
    const resumed = loadOpenRuns(db, T0 + 30 * MIN)
    expect(resumed.size).toBe(0)
    sample(resumed, T0 + 30 * MIN, 'ok')
    expect(db.select().from(healthRuns).all()).toHaveLength(2)

    // A quick restart (under three samples) picks the run back up.
    const quick = loadOpenRuns(db, T0 + 31 * MIN)
    sample(quick, T0 + 31 * MIN, 'ok')
    expect(db.select().from(healthRuns).all()).toHaveLength(2)
  })

  it('reads runs, incidents and unrecorded gaps for the window', () => {
    const open = new Map<string, OpenRun>()
    for (let m = 0; m <= 60; m++) sample(open, T0 + m * MIN, m >= 20 && m < 30 ? 'stale' : 'ok')
    // Core down 61–120; back and stalled until now.
    const open2 = new Map<string, OpenRun>()
    for (let m = 120; m <= 180; m++) sample(open2, T0 + m * MIN, 'stale')

    const h = readHistory(db, T0 + 180 * MIN)
    const check = h.checks.find(c => c.id === 'piezo-processor')
    expect(check?.runs.map(r => r.status)).toEqual(['ok', 'stale', 'ok', 'stale'])
    expect(check?.incidents).toBe(2)
    expect(h.gaps).toEqual([{ start: T0 + 60 * MIN, end: T0 + 120 * MIN }])

    const [latest, earlier] = h.incidents
    expect(latest).toMatchObject({ checkId: 'piezo-processor', status: 'stale', start: T0 + 120 * MIN, end: null })
    expect(earlier).toMatchObject({ status: 'stale', start: T0 + 19 * MIN, end: T0 + 29 * MIN })
    expect(check?.healthyShare).toBeCloseTo(50 / 120, 1)
  })

  it('ends a run that was replaced moments ago instead of stretching it to now', () => {
    const open = new Map<string, OpenRun>()
    for (let m = 0; m <= 10; m++) sample(open, T0 + m * MIN, 'stale')
    sample(open, T0 + 11 * MIN, 'ok')
    const h = readHistory(db, T0 + 11 * MIN)
    const runs = h.checks.find(c => c.id === 'piezo-processor')?.runs
    expect(runs).toEqual([
      { status: 'stale', start: T0, end: T0 + 10 * MIN },
      { status: 'ok', start: T0 + 10 * MIN, end: T0 + 11 * MIN },
    ])
    expect(h.incidents[0]).toMatchObject({ status: 'stale', end: T0 + 10 * MIN })
  })

  it('clips runs to the 24-hour window', () => {
    const open = new Map<string, OpenRun>()
    sample(open, T0, 'ok')
    for (let m = 1; m <= 26 * 60; m++) sample(open, T0 + m * MIN, 'ok')
    const now = T0 + 26 * 60 * MIN
    const h = readHistory(db, now)
    const run = h.checks.find(c => c.id === 'piezo-processor')?.runs[0]
    expect(run?.start).toBe(now - 24 * 60 * MIN)
    expect(run?.end).toBe(now)
    expect(h.recordedSince).toBe(now - 24 * 60 * MIN)
  })
})

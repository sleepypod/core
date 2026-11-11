import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { assessPresenceBreaks, type PresenceRecordEvidence } from '../fragmentation'
import { readPresenceBreaks } from '../fragmentation-read'

const now = Date.UTC(2026, 10, 10, 22)
const end = now / 1000 - 3600
const start = end - 7200

function record(gaps: Array<[number, number]> = [[start + 300, start + 360], [start + 900, start + 960], [start + 1500, start + 1560]]): PresenceRecordEvidence {
  let cursor = start
  const present: Array<[number, number]> = []
  for (const gap of gaps) {
    present.push([cursor, gap[0]])
    cursor = gap[1]
  }
  present.push([cursor, end])
  return { side: 'left', start, end, present: JSON.stringify(present), absent: JSON.stringify(gaps) }
}

describe('completed presence interval review', () => {
  it('counts explicit short breaks without treating the record duration as sleep', () => {
    const result = assessPresenceBreaks([record()], now)
    expect(result.status).toBe('read')
    expect(result.sides[0]).toEqual({ side: 'left', records: 1, discarded: 0, reportedPresenceSeconds: 7020, shortBreaks: 3, mostInOneHour: 3 })
    expect(result.sides[1]).toMatchObject({ records: 0, shortBreaks: 0 })
  })

  it('deduplicates overlapping records and keeps the two recording streams separate', () => {
    const result = assessPresenceBreaks([record(), record(), { ...record([]), side: 'right' }], now)
    expect(result.sides[0]).toMatchObject({ reportedPresenceSeconds: 7020, shortBreaks: 3, mostInOneHour: 3 })
    expect(result.sides[1]).toMatchObject({ reportedPresenceSeconds: 7200, shortBreaks: 0 })
  })

  it('does not infer absence from unknown gaps between separate records', () => {
    const rows = [0, 1, 2, 3].map(index => ({ side: 'left' as const, start: start + index * 660, end: start + index * 660 + 600,
      present: JSON.stringify([[start + index * 660, start + index * 660 + 600]]), absent: '[]' }))
    expect(assessPresenceBreaks(rows, now).sides[0]).toMatchObject({ shortBreaks: 0, mostInOneHour: 0, reportedPresenceSeconds: 2400 })
  })

  it('requires a recorded return and honors short-break and rolling-hour boundaries', () => {
    const row = record([[start + 300, start + 330], [start + 900, start + 1020], [start + 1500, start + 1529], [start + 3900, start + 4021]])
    expect(assessPresenceBreaks([row], now).sides[0]).toMatchObject({ shortBreaks: 2, mostInOneHour: 2 })
    const hourly = record([[start + 300, start + 360], [start + 3900, start + 3960]])
    expect(assessPresenceBreaks([hourly], now).sides[0]).toMatchObject({ shortBreaks: 2, mostInOneHour: 1 })
    const noReturn = { ...record([]), present: JSON.stringify([[start, end - 60]]), absent: JSON.stringify([[end - 60, end]]) }
    expect(assessPresenceBreaks([noReturn], now).sides[0].shortBreaks).toBe(0)
  })

  it('accepts fractional detector intervals within floored SQLite boundaries', () => {
    const row = { ...record([]), present: JSON.stringify([[start + 0.5, start + 300.5], [start + 360.5, end + 0.5]]),
      absent: JSON.stringify([[start + 300.5, start + 360.5]]) }
    expect(assessPresenceBreaks([row], now)).toMatchObject({ status: 'read', sides: [{ shortBreaks: 1 }, { shortBreaks: 0 }] })
  })

  it.each([null, '', '{}', '[[1]]', '[["1",2]]', '[[-1,2]]', '[[1,1]]', '[[1,1e999]]', ' '.repeat(65537)])('rejects malformed or oversized interval data (%j)', (present) => {
    const result = assessPresenceBreaks([{ ...record(), present }], now)
    expect(result.status).toBe('partial')
    expect(result.sides[0]).toMatchObject({ records: 0, discarded: 1, shortBreaks: 0 })
  })

  it('withdraws conflicting absence evidence within and across records', () => {
    const contradictory = { ...record(), present: JSON.stringify([[start, end]]) }
    expect(assessPresenceBreaks([contradictory], now).sides[0]).toMatchObject({ records: 0, discarded: 1, shortBreaks: 0 })
    const result = assessPresenceBreaks([record(), record([])], now)
    expect(result.status).toBe('partial')
    expect(result.sides[0]).toMatchObject({ discarded: 3, shortBreaks: 0 })
  })

  it('only includes complete short breaks inside the trailing 24 hours', () => {
    const observed = (start + 330) * 1000 + 24 * 3_600_000
    expect(assessPresenceBreaks([record()], observed).sides[0].shortBreaks).toBe(2)
    expect(assessPresenceBreaks([record()], now + 2 * 24 * 3_600_000).sides[0]).toMatchObject({ records: 0, shortBreaks: 0 })
  })

  it('rejects future evidence and invalid clocks instead of showing zero problems', () => {
    const future = { ...record(), end: now / 1000 + 1 }
    expect(assessPresenceBreaks([future], now).status).toBe('partial')
    expect(assessPresenceBreaks([{ ...record(), present: JSON.stringify([[start, now / 1000 + 0.5]]) }], now).status).toBe('partial')
    for (const clock of [NaN, Infinity, -1, now + 0.5]) expect(assessPresenceBreaks([], clock).status).toBe('unavailable')
  })

  it('bounds records and interval counts and preserves a partial source result', () => {
    expect(assessPresenceBreaks(Array.from({ length: 201 }, () => record()), now).status).toBe('partial')
    const present = JSON.stringify(Array.from({ length: 2001 }, () => [start, end]))
    expect(assessPresenceBreaks([{ ...record(), present }], now).sides[0].records).toBe(0)
    expect(assessPresenceBreaks([record()], now, true).status).toBe('partial')
  })
})

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
function database() {
  const connection = new Database(':memory:')
  databases.push(connection)
  connection.exec(readFileSync('src/db/biometrics-migrations/0000_noisy_onslaught.sql', 'utf8'))
  return connection
}
function insert(connection: Database.Database, row = record()) {
  connection.prepare(`INSERT INTO sleep_records (side,entered_bed_at,left_bed_at,sleep_duration_seconds,present_intervals,not_present_intervals,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(row.side, row.start, row.end, row.end - row.start, row.present, row.absent, end)
}

describe('bounded read of completed detector intervals', () => {
  it('reads the real indexed schema without changing recordings or connection state', () => {
    const connection = database()
    insert(connection)
    const before = connection.serialize()
    expect(readPresenceBreaks(connection, now).sides[0]).toMatchObject({ shortBreaks: 3, mostInOneHour: 3 })
    expect(connection.serialize()).toEqual(before)
    expect(connection.inTransaction).toBe(false)
    const plan = connection.prepare('EXPLAIN QUERY PLAN SELECT id FROM sleep_records WHERE side=? AND entered_bed_at>=? AND entered_bed_at<=? AND left_bed_at>? ORDER BY entered_bed_at DESC,id DESC LIMIT 201').all('left', start, end, start)
    expect(JSON.stringify(plan)).toContain('idx_sleep_records_side_entered')
  })

  it('excludes old records, bounds each side and does not turn excess rows into complete evidence', () => {
    const connection = database()
    for (let index = 0; index < 201; index++) insert(connection)
    insert(connection, { ...record([]), side: 'right' })
    insert(connection, { ...record(), start: start - 5 * 86400, end: end - 5 * 86400 })
    const result = readPresenceBreaks(connection, now)
    expect(result.status).toBe('partial')
    expect(result.sides[0]).toMatchObject({ records: 200, shortBreaks: 3 })
    expect(result.sides[1].records).toBe(1)
  })

  it('does not load oversized or missing JSON and retains independently usable rows', () => {
    const connection = database()
    insert(connection, { ...record(), present: ' '.repeat(65537) })
    insert(connection, { ...record(), absent: null })
    insert(connection)
    const result = readPresenceBreaks(connection, now)
    expect(result.status).toBe('partial')
    expect(result.sides[0]).toMatchObject({ records: 1, shortBreaks: 3 })
  })

  it('caps total JSON bytes even when individual fields and rows fit', () => {
    const connection = database()
    const padded = record()
    padded.present = String(padded.present).padEnd(60_000, ' ')
    for (let index = 0; index < 100; index++) insert(connection, padded)
    const result = readPresenceBreaks(connection, now)
    expect(result.status).toBe('partial')
    expect(result.sides[0].records).toBeLessThan(36)
    expect(result.sides[0].shortBreaks).toBe(3)
  })

  it('returns unavailable for missing tables and does not create or repair them', () => {
    const connection = database()
    connection.exec('DROP TABLE sleep_records')
    const before = connection.serialize()
    expect(readPresenceBreaks(connection, now)).toEqual({ observedAt: now, status: 'unavailable', sides: [] })
    expect(connection.serialize()).toEqual(before)
    expect(readPresenceBreaks(connection, NaN).status).toBe('unavailable')
  })
})

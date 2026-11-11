import { randomUUID } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, describe, expect, it } from 'vitest'
import { readNightExplanation } from '../reader'
import { nightWindow } from '../window'
import { groupNightDecisions } from '../events'
import { nightExplanationSchema } from '../contract'

const now = Date.parse('2026-11-01T20:00:00Z')
const at = Date.parse('2026-11-01T08:30:00Z')
const opened: Database.Database[] = []
afterEach(() => {
  for (const database of opened.splice(0)) if (database.open) database.close()
})
function setup() {
  const main = new Database(':memory:'), biometrics = new Database(':memory:')
  opened.push(main, biometrics)
  migrate(drizzle(main), { migrationsFolder: path.resolve('src/db/migrations') })
  migrate(drizzle(biometrics), { migrationsFolder: path.resolve('src/db/biometrics-migrations') })
  main.prepare('INSERT INTO device_settings (id,timezone) VALUES (1,?)').run('America/Los_Angeles')
  const read = (side: 'left' | 'right' = 'left') => readNightExplanation(main, biometrics, side, '2026-11-01', now)
  const application = (time = at, side = 'left', outcome = 'acknowledged', payload = {}) => main.prepare(`INSERT INTO temperature_applications
    (attempt_id,side,attempted_at,finished_at,outcome,request) VALUES (?,?,?,?,?,?)`).run(randomUUID(), side, time, time + 100, outcome,
    JSON.stringify({ side, targetF: 70, durationSec: null, reason: 'manual', source: 'manual', requestId: null, ...payload }))
  const decision = (time = at, override = {}) => main.prepare('INSERT INTO comfort_events (side,observed_at,event) VALUES (?,?,?)').run('left', time,
    JSON.stringify({ at: time, kind: 'preview', session: 'night', message: 'Manual hold takes priority.', proposedF: 69, reportedF: 70,
      eligible: false, deviceObservedAt: time - 1000, presenceObservedAt: time - 1000, owner: 'manual', ...override }))
  const thermal = (time = at, side = 'left', powered = 1, target = 70) => biometrics.prepare(`INSERT INTO thermal_state
    (timestamp,side,is_powered,target_temp_f,current_temp_f) VALUES (?,?,?,?,?)`).run(time / 1000, side, powered, target, 72)
  return { main, biometrics, read, application, decision, thermal }
}

describe('night explanation evidence', () => {
  it('resolves Pod-local noon including short and long DST nights', () => {
    const autumn = nightWindow('America/Los_Angeles', now, '2026-11-01')
    expect(autumn.start).toBe(Date.parse('2026-10-31T19:00Z'))
    expect(autumn.end - autumn.start).toBe(25 * 3600_000)
    const spring = nightWindow('America/Los_Angeles', Date.parse('2026-03-08T20:00Z'), '2026-03-08')
    expect(spring.end - spring.start).toBe(23 * 3600_000)
    expect(nightWindow('Asia/Tokyo', now).wakeDate).toBe('2026-11-02')
    expect(() => nightWindow('UTC', now, '2026-11-03')).toThrow('started night')
    expect(() => nightWindow('UTC', now, '2026-09-01')).toThrow('30 days')
    expect(() => nightWindow('UTC', now, '2026-02-30')).toThrow()
    expect(() => nightWindow('bad zone', now)).toThrow()
  })
  it('keeps receipts, proposals and reported temperatures distinct with no write on read', () => {
    const { main, biometrics, read, application, decision, thermal } = setup()
    application()
    application(at + 1000, 'left', 'unknown')
    application(at, 'right')
    decision(at + 2000)
    thermal(at + 3000)
    thermal(at, 'right')
    thermal(at + 60_000, 'left', 0)
    const changes = [main.prepare('SELECT total_changes() AS total').get(), biometrics.prepare('SELECT total_changes() AS total').get()]
    const report = read()
    expect(report.attribution).toBe('physical_zone_only')
    expect(report.events.map(event => event.kind)).toEqual(['acknowledged', 'unconfirmed', 'withheld'])
    expect(report.events[0]).toMatchObject({ targetF: 70, reportedF: null, owner: 'manual', evidence: 'controller_receipt' })
    expect(report.events[2].detail).toBe('Manual hold takes priority.')
    expect(report.thermal).toHaveLength(2)
    expect(report.thermal[0]).toMatchObject({ at: at + 3000, reportedF: 72, targetF: 70, powered: true })
    expect(report.thermal[1].powered).toBe(false)
    expect([main.prepare('SELECT total_changes() AS total').get(), biometrics.prepare('SELECT total_changes() AS total').get()]).toEqual(changes)
    expect(read('right').events).toHaveLength(1)
  })
  it('rejects corrupt identities and future nested clocks without losing good sources', () => {
    const { main, read, application, decision, thermal } = setup()
    application()
    application(at + 1000, 'left', 'acknowledged', { side: 'right' })
    application(now + 1000)
    decision(at, { deviceObservedAt: at + 1 })
    decision(at + 1000)
    main.prepare('INSERT INTO comfort_events (side,observed_at,event) VALUES (?,?,?)').run('left', at + 3000, '{')
    thermal(at, 'left', 3)
    thermal(at + 1000)
    const result = read()
    expect(result.events).toHaveLength(2)
    expect(result.thermal).toHaveLength(1)
    expect(result.sources.find(source => source.key === 'applications')).toMatchObject({ status: 'partial', rowsRead: 2, discarded: 1 })
    expect(result.sources.find(source => source.key === 'decisions')).toMatchObject({ status: 'partial', discarded: 2 })
    expect(result.sources.find(source => source.key === 'thermal')).toMatchObject({ status: 'partial', discarded: 1 })
  })
  it('reports empty and unavailable independently rather than claiming no changes occurred', () => {
    const { main, biometrics, read, decision } = setup()
    decision()
    main.exec('DROP TABLE bedroom_history')
    biometrics.close()
    const result = read()
    expect(result.sources.find(source => source.key === 'applications')?.status).toBe('empty')
    expect(result.sources.find(source => source.key === 'thermal')?.status).toBe('unavailable')
    expect(result.sources.find(source => source.key === 'room')?.status).toBe('unavailable')
    expect(result.events).toHaveLength(1)
  })
  it('groups identical evaluations but never bridges missing observations or merges receipts', () => {
    const { read, decision, application } = setup()
    decision()
    decision(at + 60_000)
    decision(at + 240_000)
    decision(at + 300_000, { message: 'Presence unavailable.' })
    application(at + 30_000)
    const events = read().events
    expect(events).toHaveLength(4)
    expect(events[0]).toMatchObject({ count: 2, at, through: at + 60_000 })
    expect(events[1].source).toBe('applications')
    expect(events[2].count).toBe(1)
    expect(groupNightDecisions([events[1], events[1]])).toHaveLength(2)
  })
  it('does not label an eligible Preview or active policy proposal as a hardware command', () => {
    const { read, decision } = setup()
    decision(at, { eligible: true })
    decision(at + 1000, { kind: 'active', eligible: true })
    expect(read().events.map(event => [event.kind, event.evidence])).toEqual([['preview', 'policy_evaluation'], ['preview', 'policy_evaluation']])
  })
  it('uses each recorded rule action side and never borrows its current name or conditions', () => {
    const { main, read } = setup()
    main.exec(`INSERT INTO automations (id,name,trigger,conditions,actions) VALUES (1,'New private name','{}','{}','[]')`)
    const insert = main.prepare('INSERT INTO automation_runs (automation_id,fired_at,outcome,detail) VALUES (1,?,?,?)')
    insert.run(at / 1000, 'fired', JSON.stringify({ actions: [{ side: 'right', temp: 90, sent: true }, { side: 'left', temp: 69, sent: true }] }))
    insert.run(at / 1000 + 10, 'skipped', JSON.stringify({ reason: 'condition-false' }))
    insert.run(at / 1000 + 20, 'dry_run', JSON.stringify({ actions: [{ side: 'right', temp: 80, dryRun: true }] }))
    const events = read().events
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ scope: 'left', targetF: 69, kind: 'rule_output' })
    expect(events[1]).toMatchObject({ scope: 'unassigned', targetF: null, kind: 'withheld' })
    expect(JSON.stringify(events)).not.toContain('New private name')
    expect(JSON.stringify(events)).not.toContain('outside-window')
  })
  it('keeps room clocks and historical mappings, with explicit five-minute sampling', () => {
    const { main, read } = setup()
    const source = { id: 'sensor', deviceId: 'homepod', deviceName: 'Bedside HomePod', label: 'Room temperature', provider: 'apple_home',
      externalId: 'temp', model: '', location: 'room', metric: 'temperature', unit: '°C', maxAgeSeconds: 300, enabled: true, useForControl: false }
    const insert = main.prepare('INSERT INTO bedroom_history (revision,source_id,received_at,source,report) VALUES (1,?,?,?,?)')
    const add = (time: number, changes = {}, sourceChanges = {}) => insert.run('sensor', time, JSON.stringify({ ...source, ...sourceChanges }),
      JSON.stringify({ schemaVersion: 1, revision: 1, sourceId: 'sensor', available: true, value: 20,
        observedAt: time - 1000, measuredAt: null, timeBasis: 'cached', ...changes }))
    add(at)
    add(at + 60_000)
    add(at + 300_000, { value: 21, timeBasis: 'measurement', measuredAt: at + 298_000 })
    add(at + 400_000, { observedAt: at + 500_000 })
    add(at + 500_000, {}, { location: 'right' })
    const result = read()
    expect(result.room).toHaveLength(2)
    expect(result.room[0]).toMatchObject({ value: 68, measuredAt: null, timeBasis: 'cached', receivedAt: at + 60_000 })
    expect(result.room[1]).toMatchObject({ timeBasis: 'measurement', measuredAt: at + 298_000, value: 69.8 })
    expect(result.sources.find(item => item.key === 'room')).toMatchObject({ status: 'partial', discarded: 1 })
  })
  it('caps source reads and tells the client when the most recent event list is truncated', () => {
    const { read, application, main } = setup()
    main.transaction(() => {
      for (let index = 0; index < 1002; index++) application(at + index * 1000)
    })()
    const result = read()
    expect(result.events).toHaveLength(600)
    expect(result.eventsTruncated).toBe(true)
    expect(result.sources.find(item => item.key === 'applications')).toMatchObject({ status: 'partial', truncated: true, rowsRead: 1000 })
    expect(result.events.at(-1)?.at).toBe(at + 1001 * 1000)
  })
  it('validates response identities and rejects duplicate source summaries', () => {
    const { read, application } = setup()
    application()
    const result = read()
    expect(() => nightExplanationSchema.parse({ ...result, timeZone: 'invalid/timezone' })).toThrow()
    expect(() => nightExplanationSchema.parse({ ...result, observedThrough: result.start - 1 })).toThrow()
    expect(() => nightExplanationSchema.parse({ ...result, sources: Array(5).fill(result.sources[0]) })).toThrow()
    expect(() => nightExplanationSchema.parse({ ...result, events: [{ ...result.events[0], scope: 'right' }] })).toThrow()
    expect(() => nightExplanationSchema.parse({ ...result, thermal: [{ id: 1, at: now + 1, powered: true, targetF: 70, reportedF: 70 }] })).toThrow()
  })
})

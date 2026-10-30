// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ComfortSignalReader } from '../signal-reader'
import { HISTORY_DAY_MS, personalBaseline, type ComfortWindow } from '../signals'

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
const now = Date.parse('2026-10-25T10:12:10Z')

function fixture(days = 7, recentHeartRate = 60) {
  const database = new Database(':memory:')
  databases.push(database)
  migrate(drizzle(database), { migrationsFolder: fileURLToPath(new URL('../../db/biometrics-migrations/', import.meta.url)) })
  const epoch = randomUUID(), currentSpan = randomUUID(), historyRun = randomUUID(), currentRun = randomUUID()
  for (const run of [historyRun, currentRun]) database.prepare('INSERT INTO biometric_processing_runs (id,side,kind,bundle,config_hash,input_identity,started_at_ms) VALUES (?,\'left\',\'live\',?,?,?,?)')
    .run(run, JSON.stringify({ schemaVersion: 1, manifestHash: 'b'.repeat(64) }), 'a'.repeat(64),
      JSON.stringify({ sourceSide: 'left', timestampBasis: 'firmware_event_time_v1', mechanicalContext: 'mechanical-context-v1' }), now - 30 * HISTORY_DAY_MS)
  const insert = (timestamp: number, span: string, run: string, heartRate = 60) => {
    const id = Number(database.prepare('INSERT INTO vitals (side,timestamp,heart_rate,processing_run_id) VALUES (\'left\',?,?,?)').run(timestamp / 1000, heartRate, run).lastInsertRowid)
    database.prepare('INSERT INTO vitals_quality (vitals_id,side,timestamp,quality_score,flags,created_at) VALUES (?,\'left\',?,0.9,?,?)')
      .run(id, timestamp / 1000, JSON.stringify([`mechanical_context_v1:${epoch}:${span}:${timestamp - 31000}:${timestamp + 1000}`]), timestamp / 1000)
    return id
  }
  const historicalSpans: string[] = []
  for (let day = 2; day < days + 2; day++) {
    const start = Date.parse('2026-10-25T10:00:00Z') - day * HISTORY_DAY_MS, span = randomUUID()
    historicalSpans.push(span)
    database.prepare('INSERT INTO biometric_mechanical_spans VALUES (?,?,?,?)').run(span, epoch, start - 600000, start + 3600000)
    for (let minute = 0; minute < 60; minute++) insert(start + minute * 60000 + 30000, span, historyRun)
  }
  const start = Date.parse('2026-10-25T10:00:00Z')
  database.prepare('INSERT INTO biometric_mechanical_spans VALUES (?,?,?,?)').run(currentSpan, epoch, start - 600000, now)
  for (let minute = 0; minute < 12; minute++) insert(start + minute * 60000 + 30000, currentSpan, currentRun, recentHeartRate)
  const state = { version: 'mechanical-context-v1', epoch, publishedAtMs: now, confirmedThroughMs: now,
    validUntilMs: now + 10000, blockedUntilMs: start - 600000, cleanSinceMs: start - 600000,
    spanId: currentSpan, reasons: [], commandAtMs: null, commandUntilMs: 0 }
  database.prepare('INSERT INTO biometric_mechanical_state VALUES (1,?)').run(JSON.stringify(state))
  const reader = new ComfortSignalReader(database)
  return { database, reader, currentRun, historyRun, currentSpan, historicalSpans, state, insert,
    async read(at = now, timezone = 'America/Los_Angeles') {
      await reader.prepare('left', timezone, at)
      return reader.read('left', timezone, at)
    } }
}

describe('qualified personal baseline with real migrated SQLite', () => {
  it('uses historical receipts from older quiet intervals while requiring the current interval for recent windows', async () => {
    const setup = fixture()
    expect(await setup.read()).toMatchObject({ state: 'ready', baselineDays: 7, baselineWindows: 84,
      baselineHeartRate: 60, recentHeartRates: [60, 60], sampleAt: Date.parse('2026-10-25T10:10:00Z'), expiresAt: now + 10000 })
    setup.database.prepare('UPDATE biometric_mechanical_state SET payload=?').run(JSON.stringify({ ...setup.state, spanId: randomUUID() }))
    expect(setup.reader.read('left', 'America/Los_Angeles', now).state).toBe('stale')
  })

  it('keeps insufficient history in learning and sustained deviations in review', async () => {
    expect(await fixture(6).read()).toMatchObject({ state: 'learning', baselineDays: 6, baselineHeartRate: null })
    expect(await fixture(7, 75).read()).toMatchObject({ state: 'review', baselineHeartRate: 60, recentHeartRates: [75, 75] })
    expect(await fixture(7, 45).read()).toMatchObject({ state: 'review' })
  })

  it.each(['legacy', 'replay', 'quality', 'duplicate quality', 'timestamp', 'low signal', 'manifest', 'physical side', 'config'])('does not learn from incompatible %s history', async (kind) => {
    const setup = fixture(), database = setup.database
    if (kind === 'legacy') database.prepare('UPDATE vitals SET processing_run_id=NULL WHERE processing_run_id=?').run(setup.historyRun)
    if (kind === 'replay') database.prepare('UPDATE biometric_processing_runs SET kind=\'replay\' WHERE id=?').run(setup.historyRun)
    if (kind === 'quality') database.prepare('DELETE FROM vitals_quality WHERE timestamp<?').run((now - HISTORY_DAY_MS) / 1000)
    if (kind === 'duplicate quality') database.exec(`INSERT INTO vitals_quality(vitals_id,side,timestamp,quality_score,flags,created_at)
      SELECT vitals_id,side,timestamp,quality_score,flags,created_at FROM vitals_quality WHERE timestamp < ${(now - HISTORY_DAY_MS) / 1000}`)
    if (kind === 'timestamp') database.prepare('UPDATE vitals_quality SET timestamp=timestamp+1 WHERE timestamp<?').run((now - HISTORY_DAY_MS) / 1000)
    if (kind === 'low signal') database.prepare('UPDATE vitals_quality SET flags=json_insert(flags,\'$[#]\',\'low_signal\') WHERE timestamp<?').run((now - HISTORY_DAY_MS) / 1000)
    if (kind === 'manifest') database.prepare('UPDATE biometric_processing_runs SET bundle=? WHERE id=?').run(JSON.stringify({ schemaVersion: 1, manifestHash: 'c'.repeat(64) }), setup.historyRun)
    if (kind === 'physical side') database.prepare('UPDATE biometric_processing_runs SET input_identity=json_set(input_identity,\'$.sourceSide\',\'right\') WHERE id=?').run(setup.historyRun)
    if (kind === 'config') database.prepare('UPDATE biometric_processing_runs SET config_hash=? WHERE id=?').run('c'.repeat(64), setup.historyRun)
    expect(await setup.read()).toMatchObject({ state: 'learning', baselineDays: 0, baselineWindows: 0 })
  })

  it('requires cached proof coverage before the summary interval as well as inside it', async () => {
    const setup = fixture()
    expect((await setup.read()).state).toBe('ready')
    // The first estimate also depends on signal immediately before the summary.
    setup.database.prepare('UPDATE biometric_mechanical_spans SET start_ms=start_ms+600000 WHERE id=?').run(setup.historicalSpans[0])
    expect(await setup.read()).toMatchObject({ state: 'learning', baselineDays: 6 })
  })

  it('revalidates cached span retention and changes in the numerical pipeline', async () => {
    const setup = fixture()
    expect((await setup.read()).state).toBe('ready')
    setup.database.prepare('DELETE FROM biometric_mechanical_spans WHERE id=?').run(setup.historicalSpans[0])
    expect(await setup.read()).toMatchObject({ state: 'learning', baselineDays: 6 })
    setup.database.prepare('UPDATE biometric_processing_runs SET config_hash=? WHERE id=?').run('d'.repeat(64), setup.currentRun)
    expect(await setup.read()).toMatchObject({ state: 'learning', baselineDays: 0 })
  })

  it.each(['missing minute', 'duplicate minute', 'low quality', 'future', 'missing run', 'stale quiet state', 'motion', 'oversized bundle'])('withholds current %s readings without falling back to older ready evidence', async (kind) => {
    const setup = fixture(), database = setup.database
    if (kind === 'missing minute') database.prepare('DELETE FROM vitals WHERE timestamp=?').run(Date.parse('2026-10-25T10:06:30Z') / 1000)
    if (kind === 'duplicate minute') setup.insert(Date.parse('2026-10-25T10:06:40Z'), setup.currentSpan, setup.currentRun)
    if (kind === 'low quality') database.exec('UPDATE vitals_quality SET quality_score=0.1 WHERE vitals_id=(SELECT MAX(id) FROM vitals)')
    if (kind === 'future') database.exec(`UPDATE vitals SET timestamp=${now / 1000 + 1} WHERE id=(SELECT MAX(id) FROM vitals)`)
    if (kind === 'missing run') database.exec('UPDATE vitals SET processing_run_id=NULL WHERE id=(SELECT MAX(id) FROM vitals)')
    if (kind === 'oversized bundle') database.prepare('UPDATE biometric_processing_runs SET bundle=? WHERE id=?').run(' '.repeat(65537), setup.currentRun)
    if (kind === 'stale quiet state') setup.state.publishedAtMs -= 10000
    if (kind === 'motion') Object.assign(setup.state, { reasons: ['base_motion'], spanId: null })
    database.prepare('UPDATE biometric_mechanical_state SET payload=?').run(JSON.stringify(setup.state))
    expect((await setup.read()).state).toBe('stale')
  })

  it('expires prepared evidence on clock reversal, a delayed lock or timezone change', async () => {
    const setup = fixture()
    await setup.read()
    expect(setup.reader.read('left', 'America/Los_Angeles', now + 10000).state).toBe('stale')
    expect(setup.reader.read('left', 'America/Los_Angeles', now - 1000).state).toBe('stale')
    expect(setup.reader.read('left', 'UTC', now).state).toBe('learning')
    expect(setup.reader.read('right', 'UTC', now).state).toBe('stale')
  })
})

it('weights days equally, deduplicates summaries and excludes the latest 24 hours', () => {
  const windows: ComfortWindow[] = []
  for (let day = 2; day < 9; day++) {
    const start = Date.parse('2026-10-25T10:00:00Z') - day * HISTORY_DAY_MS
    for (let index = 0; index < (day === 2 ? 100 : 12); index++) windows.push({ start: start + index * 300000,
      end: start + (index + 1) * 300000, heartRate: day === 2 ? 90 : 60, spanId: 'fixture', epoch: 'fixture', evidenceStart: start - 300000, evidenceEnd: start + (index + 1) * 300000 })
  }
  expect(personalBaseline([...windows, ...windows, { ...windows[0], start: now - 300000, end: now, heartRate: 90 }], 'America/Los_Angeles', now))
    .toMatchObject({ heartRate: 60, days: 7, windows: 172 })
})

it('qualifies dates in the configured timezone instead of counting UTC dates as local nights', () => {
  const windows: ComfortWindow[] = []
  for (let day = 0; day < 7; day++) {
    const start = Date.parse('2026-10-10T00:00:00Z') + day * HISTORY_DAY_MS
    for (const hour of [0, 23]) for (let index = 0; index < 6; index++) {
      const at = start + hour * 3600000 + index * 300000
      windows.push({ start: at, end: at + 300000, evidenceStart: at - 300000, evidenceEnd: at + 300000,
        heartRate: 60, spanId: 'fixture', epoch: 'fixture' })
    }
  }
  expect(personalBaseline(windows, 'UTC', now)).toMatchObject({ days: 7, heartRate: 60 })
  expect(personalBaseline(windows, 'America/Los_Angeles', now)).toMatchObject({ days: 6, heartRate: null })
})

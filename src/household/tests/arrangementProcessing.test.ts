import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/schema'
import { configHash } from '@/src/biometrics/algorithms/canonical'
import { defaultConfig } from '@/src/biometrics/algorithms/registry'
import { ProfileStore } from '@/src/biometrics/profiles/store'
import { requestManualActivation } from '@/src/biometrics/profiles/activation'
import { personalRuntimeFixture } from './runtimeFixture'
import { historySourceFixture } from './historySourceFixture'
import { prepareArrangementProcessing, readArrangementProcessing, type ArrangementProcessing } from '../arrangementProcessing'

let fixture: ReturnType<typeof personalRuntimeFixture>, source: ReturnType<typeof historySourceFixture>, operationId: string
const prepare = () => fixture.database.transaction(() => prepareArrangementProcessing(fixture.database,
  { householdId: fixture.owner.householdId, assignmentRevision: 1 }, operationId, source.identity.datasetId, fixture.clock.now)).immediate()

beforeEach(() => {
  fixture = personalRuntimeFixture()
  source = historySourceFixture(fixture.database, fixture.owner, () => fixture.clock.now)
  operationId = randomUUID()
})
afterEach(() => {
  source.biometrics.close()
  fixture.database.close()
})

describe('arrangement algorithm identity', () => {
  it('preserves an old personalized revision and resets both new sides with immutable generations', () => {
    const store = drizzle(fixture.database, { schema })
    const profiles = new ProfileStore(store, () => fixture.clock.now)
    const revision = profiles.createRevision({ side: 'left', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }],
      origin: 'manual', requester: 'prior-person', idempotencyKey: 'prior-profile' })
    requestManualActivation(store, { side: 'left', action: 'activate', revisionId: revision.id, expectedGeneration: 0,
      expectedResolvedHash: revision.resolvedHash, boundary: 'immediate', requester: 'prior-person', idempotencyKey: 'prior-activation', allowUnvalidated: true }, fixture.clock.now)
    const intent = prepare()
    expect(intent).toMatchObject({ operationId, profiles: { left: { generation: 2, hash: configHash(defaultConfig) }, right: { generation: 1, hash: configHash(defaultConfig) } } })
    expect(profiles.validateRevision(revision.id, 'left').hash).toBe(revision.resolvedHash)
    expect(profiles.binding('left')).toMatchObject({ desiredRevisionId: null, previousRevisionId: revision.id, generation: 2 })
    expect(fixture.database.prepare('SELECT state FROM biometric_config_outbox WHERE side=\'left\' AND generation=1').get()).toEqual({ state: 'failed' })
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM biometric_config_outbox WHERE state=\'pending\'').get()).toEqual({ count: 2 })
    expect(source.biometrics.prepare('SELECT * FROM household_processing_receipts').all()).toEqual([])
  })

  it('preserves a valid legacy classifier before clearing the personal selection', () => {
    const classifier = { ...defaultConfig.sleep_stages, ruleset: { ...defaultConfig.sleep_stages.ruleset, smoothIsolatedEpochs: false } }
    fixture.database.prepare('UPDATE side_settings SET stage_classifier=? WHERE side=\'left\'').run(JSON.stringify(classifier))
    const intent = prepare()
    expect(intent.profiles.left.generation).toBe(2)
    const revisions = fixture.database.prepare('SELECT resolved FROM biometric_profile_revisions').all() as { resolved: string }[]
    expect(revisions).toHaveLength(1)
    expect(revisions.map(row => JSON.parse(row.resolved).sleep_stages)).toEqual([classifier])
  })

  it('retains malformed legacy data in the reset audit', () => {
    fixture.database.prepare('UPDATE side_settings SET stage_classifier=? WHERE side=\'left\'').run(JSON.stringify({ broken: true }))
    prepare()
    const event = fixture.database.prepare('SELECT evidence FROM biometric_activation_events WHERE side=\'left\'').get() as { evidence: string }
    expect(JSON.parse(event.evidence)).toMatchObject({ recovery: 'invalid_legacy_reset', preservedLegacyClassifier: { broken: true } })
  })

  it('rolls back both sides if the second publication fails and never runs outside a caller transaction', () => {
    expect(() => prepareArrangementProcessing(fixture.database, { householdId: fixture.owner.householdId, assignmentRevision: 1 }, operationId, source.identity.datasetId, fixture.clock.now)).toThrow('transaction')
    fixture.database.exec('CREATE TRIGGER fail_right BEFORE INSERT ON biometric_config_outbox WHEN NEW.side=\'right\' BEGIN SELECT RAISE(FAIL, \'publication failed\'); END')
    expect(prepare).toThrow('publication failed')
    for (const table of ['biometric_profile_bindings', 'biometric_profile_revisions', 'biometric_activation_events', 'biometric_config_outbox'])
      expect(fixture.database.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
  })
})

function acknowledge(intent: ArrangementProcessing) {
  for (const component of ['sleep-detector', 'piezo-processor']) source.biometrics.prepare(`INSERT INTO household_processing_receipts
    (operation_id, component, process_id, intent_hash, first_sample_ms, latest_sample_ms, heartbeat_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(intent.operationId, component, randomUUID(), configHash(intent), fixture.clock.now, fixture.clock.now, fixture.clock.now)
}

describe('actual pipeline adoption', () => {
  it('requires both consumers and returns the later observed boundary, without writing an epoch or releasing hardware', () => {
    const intent = prepare()
    expect(readArrangementProcessing(source.biometrics, intent, fixture.clock.now)).toBeNull()
    acknowledge(intent)
    fixture.clock.now += 1000
    source.biometrics.prepare('UPDATE household_processing_receipts SET first_sample_ms=?, latest_sample_ms=?, heartbeat_at_ms=? WHERE component=\'piezo-processor\'')
      .run(fixture.clock.now, fixture.clock.now, fixture.clock.now)
    expect(readArrangementProcessing(source.biometrics, intent, fixture.clock.now)?.earliestAssignedSampleAt).toBe(fixture.clock.now)
    expect(fixture.database.prepare('SELECT * FROM household_attribution_epochs').all()).toEqual([])
  })

  it.each(['missing', 'wrong-hash', 'old-heartbeat', 'old-frame', 'future', 'reversed', 'old-boundary', 'corrupt-process', 'source-replaced'])(
    'withholds %s processing evidence', (problem) => {
      const intent = prepare()
      acknowledge(intent)
      const database = source.biometrics
      if (problem === 'missing') database.prepare('DELETE FROM household_processing_receipts WHERE component=\'piezo-processor\'').run()
      if (problem === 'wrong-hash') database.prepare('UPDATE household_processing_receipts SET intent_hash=?').run('a'.repeat(64))
      if (problem === 'old-heartbeat') fixture.clock.now += 5001
      if (problem === 'old-frame') {
        fixture.clock.now += 10001
        database.prepare('UPDATE household_processing_receipts SET heartbeat_at_ms=?').run(fixture.clock.now)
      }
      if (problem === 'future') database.prepare('UPDATE household_processing_receipts SET heartbeat_at_ms=?').run(fixture.clock.now + 1)
      if (problem === 'reversed') database.prepare('UPDATE household_processing_receipts SET first_sample_ms=?').run(fixture.clock.now + 1)
      if (problem === 'old-boundary') database.prepare('UPDATE household_processing_receipts SET first_sample_ms=?').run(intent.committedAt - 1)
      if (problem === 'corrupt-process') database.prepare('UPDATE household_processing_receipts SET process_id=\'bad\'').run()
      if (problem === 'source-replaced') database.prepare('UPDATE biometric_history_identity SET dataset_id=?').run(randomUUID())
      expect(readArrangementProcessing(database, intent, fixture.clock.now)).toBeNull()
    })
})

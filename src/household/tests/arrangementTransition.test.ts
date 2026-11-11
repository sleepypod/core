import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/schema'
import { installHardwareAdmission, beginHardwareWrite, captureHardwareIntent, waitForHardwareDrain } from '@/src/hardware/admission'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { readBedtimeRoutineState, replaceBedtimeRoutineBatch } from '@/src/server/bedtimeRoutineTransaction'
import { createComfortLimitStore } from '@/src/temperature/limitStore'
import { defaultComfortState } from '@/src/comfort/policy'
import type { BedtimeDraft } from '@/src/lib/bedtimeRoutines'
import { ArrangementReviewService } from '../arrangementReviews'
import { ArrangementTransitionStore } from '../arrangementTransition'
import { PersonHistoryStore } from '../personHistory'
import { committedArrangementDigest } from '../arrangementTransitionState'
import { verifyLearningArchive } from '../learningArchive'
import { learningArchiveLimits } from '../learningArchiveContract'
import { PersonalLearningLibrary } from '../learningLibrary'
import { PersonalLearningApi } from '../learningApi'
import { householdHttp } from '../http'
import { issuePersonalSession, PERSONAL_COOKIE } from '../browserSession'
import { bindBrowserScope, browserScopeRevision } from '@/src/auth/browserScope'
import { historySourceFixture } from './historySourceFixture'
import { personalRuntimeFixture } from './runtimeFixture'
import type { ArrangementObservation, ArrangementTransitionRequest } from '../arrangementTransitionContract'

const night: BedtimeDraft = {
  power: { onTime: '22:00', offTime: '07:15', onTemperature: 70, enabled: true, endAction: 'maintain' }, temperatures: [],
  alarm: { time: '07:00', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 20, alarmTemperature: 105, enabled: true,
    wakeWindow: 0, snoozeDuration: 540, snoozeTaper: 30 }, notes: 'Owner private operating week',
}
let fixture: ReturnType<typeof personalRuntimeFixture>, source: ReturnType<typeof historySourceFixture>
let reviews: ArrangementReviewService, history: PersonHistoryStore, transition: ArrangementTransitionStore, admission: HardwareAdmissionStore
let request: ArrangementTransitionRequest, proof: ArrangementObservation, uninstall: () => void, folder: string, runId: string, enabled: boolean
let finishes: (() => void)[]
const context = (key = fixture.ownerKey) => {
  const session = fixture.identities.session(key)
  return { requestId: randomUUID(), expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision }
}
const state = () => ['hardware_admission', 'households', 'household_accounts', 'side_settings', 'device_settings', 'household_personal_settings',
  'bedtime_routines', 'power_schedules', 'temperature_schedules', 'alarm_schedules', 'temperature_limits', 'comfort_states',
  'household_arrangement_reviews', 'household_arrangement_transitions', 'household_attribution_epochs', 'household_history_state',
  'biometric_profile_bindings', 'biometric_profile_revisions', 'biometric_activation_events', 'biometric_config_outbox',
  'household_learning_archives', 'household_learning_records']
  .map(table => fixture.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
const generation = () => ({ version: 1, invocationId: 'a'.repeat(32), bootId: runId, pid: 1234, startTicks: '1000', observedAt: fixture.clock.now })
const makeStore = (runtimeId = runId, controllerGeneration: () => unknown = generation) => new ArrangementTransitionStore({ database: fixture.database, identities: fixture.identities,
  reviews, history, historySource: source.source, enabled: () => enabled, observe: () => proof, runId: runtimeId, now: () => fixture.clock.now,
  controllerGeneration })
const ownWeek = (side: 'left' | 'right') => readBedtimeRoutineState(drizzle(fixture.database, { schema }), side).records.map(row => row.snapshot)

beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), 'sleepypod-arrangement-'))
  fixture = personalRuntimeFixture(path.join(folder, 'configuration.db'))
  fixture.database.pragma('journal_mode = WAL')
  source = historySourceFixture(fixture.database, fixture.owner, () => fixture.clock.now)
  history = new PersonHistoryStore(fixture.database, fixture.identities, source.source, () => fixture.clock.now)
  history.appendReviewedEpoch({ householdId: fixture.owner.householdId, datasetId: source.identity.datasetId, expectedAttributionRevision: 1,
    startsAt: fixture.clock.now, endsAt: null, mode: 'solo_merged', basis: 'verified_arrangement', reviewReceiptId: randomUUID(),
    reviewedBy: fixture.owner.accountId, assignments: [{ sleeperId: fixture.owner.selfSleeperId, recordedSide: 'left' }] })
  fixture.clock.now += 2000
  for (const key of [fixture.ownerKey, fixture.memberKey]) {
    const prior = fixture.identities.preferences(key)
    fixture.identities.updatePreferences(key, { ...context(key), expectedRevision: prior.revision,
      preferences: { ...prior.preferences, preferredTemperatureF: key === fixture.ownerKey ? 70 : 82 } })
    fixture.identities.updateRoutines(key, { ...context(key), expectedRevision: fixture.identities.routines(key).revision,
      routines: [{ dayOfWeek: 'friday', draft: { ...night, alarm: null, power: { ...night.power, onTemperature: key === fixture.ownerKey ? 90 : 82 },
        notes: key === fixture.ownerKey ? 'Unpublished owner draft' : 'Partner private draft' } }] })
  }
  replaceBedtimeRoutineBatch(fixture.database, [{ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: night }] }])
  createComfortLimitStore(fixture.database).save('left', 0, { enabled: true, minF: 68, maxF: 72 })
  fixture.database.prepare('INSERT INTO comfort_states(side, state) VALUES (?, ?)').run('left', JSON.stringify({ ...defaultComfortState(), config: { mode: 'preview', minimumF: 68, maximumF: 72 }, offsetF: -2 }))
  reviews = new ArrangementReviewService({ database: fixture.database, identities: fixture.identities, enabled: () => true, now: () => fixture.clock.now })
  const review = reviews.propose(fixture.ownerKey, { ...context(), version: 1, ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true })
  for (const key of [fixture.ownerKey, fixture.memberKey]) reviews.approve(key, { ...context(key), version: 1, reviewId: review.reviewId,
    issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000, confirmMySide: true, confirmMyRoutine: true, acknowledgeSeparateActivation: true })
  runId = randomUUID()
  enabled = true
  proof = { runId, presence: { observedAt: fixture.clock.now, left: 'empty', right: 'empty' },
    thermal: { observedAt: fixture.clock.now, leftPowered: false, rightPowered: false, water: 'ok', priming: false },
    alarm: { observedAt: fixture.clock.now, vibrating: false, snoozing: false }, base: { observedAt: fixture.clock.now, state: 'stationary' } }
  request = { ...context(), version: 1, reviewId: review.reviewId, issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000,
    confirmEmptyAndAttended: true, confirmClearTemporaryActions: true, confirmPauseLearningAndSharedAutomations: true, acknowledgeHeldUntilRecovery: true }
  admission = new HardwareAdmissionStore(fixture.database, () => fixture.clock.now)
  uninstall = installHardwareAdmission(admission)
  finishes = []
  transition = makeStore()
})
afterEach(() => {
  for (const finish of finishes) finish()
  uninstall?.()
  source?.biometrics.close()
  fixture?.database.close()
  rmSync(folder, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('atomic reviewed arrangement storage', () => {
  const serveLearning = (incoming: Request, enabled = () => true) => householdHttp(incoming,
    { store: fixture.identities, verifySoloConfiguration: () => true,
      personalLearning: new PersonalLearningApi({ identities: fixture.identities,
        library: new PersonalLearningLibrary(fixture.database, fixture.identities), enabled, now: () => fixture.clock.now }) })
  const learningRequest = (route: string, key = fixture.ownerKey, enabled = () => true, signal?: AbortSignal) => serveLearning(
    new Request(`http://pod.local/api/v1/me/learning/${route}`, { headers: { authorization: `Bearer ${key}` }, signal }), enabled)

  it('preserves learning when committing an older held operation', () => {
    transition.begin(fixture.ownerKey, request)
    const saved = fixture.database.prepare('SELECT context FROM household_arrangement_transitions').get() as { context: string }
    const legacyContext = JSON.parse(saved.context)
    delete legacyContext.learningArchiveVersion
    fixture.database.prepare('UPDATE household_arrangement_transitions SET context = ?').run(JSON.stringify(legacyContext))
    transition.commit(fixture.ownerKey, request)
    expect(verifyLearningArchive(fixture.database, request.requestId).recordCount).toBeGreaterThan(0)
    const committed = fixture.database.prepare('SELECT context FROM household_arrangement_transitions').get() as { context: string }
    expect(JSON.parse(committed.context).learningArchiveVersion).toBe(1)
  })

  it('requires the selected sleeper on browser reads and withdraws a response when that browser changes accounts', async () => {
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    vi.stubEnv('DATABASE_URL', path.join(folder, 'configuration.db'))
    vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', randomUUID() + randomUUID())
    const issued = issuePersonalSession(fixture.identities.deviceIdentity(fixture.ownerKey))
    const url = 'http://pod.local/api/v1/me/learning/archives'
    const scope = bindBrowserScope(new Request(url), 'personal', issued).split(';')[0]
    const cookie = `${PERSONAL_COOKIE}=${issued}; ${scope}`
    const incoming = (sleeperId?: string) => new Request(url, { headers: {
      cookie, ...(sleeperId ? { 'x-sleepypod-sleeper-id': sleeperId } : {}),
    } })
    expect((await serveLearning(incoming())).status).toBe(409)
    expect((await serveLearning(incoming(fixture.member.selfSleeperId))).status).toBe(409)
    const response = await serveLearning(incoming(fixture.owner.selfSleeperId))
    expect(response.status).toBe(200)
    const member = issuePersonalSession(fixture.identities.deviceIdentity(fixture.memberKey))
    const switching = incoming(fixture.owner.selfSleeperId)
    switching.headers.set('x-sleepypod-browser-revision', browserScopeRevision(switching.headers) ?? '')
    bindBrowserScope(switching, 'personal', member)
    await expect(response.text()).rejects.toThrow('before delivery')
  })

  it('serves preserved learning only to its original account after sides change', async () => {
    fixture.database.prepare('INSERT INTO journal_entries (side, local_date, revision, record) VALUES (?, ?, ?, ?)')
      .run('left', '2026-10-30', randomUUID(), JSON.stringify({ note: 'Only the original owner can read this' }))
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    const ownResponse = await learningRequest('archives')
    expect(ownResponse.status).toBe(200)
    expect(ownResponse.headers.get('cache-control')).toBe('private, no-store')
    const owner = await ownResponse.json()
    expect(owner.scope).toMatchObject({ accountId: fixture.owner.accountId, sleeperId: fixture.owner.selfSleeperId, assignmentRevision: 2 })
    expect(owner.archives).toMatchObject([{ archiveId: request.requestId, sourceSide: 'left', activation: 'historical_only' }])
    const member = await (await learningRequest('archives', fixture.memberKey)).json()
    expect(member.archives).toEqual([])
    expect(member.nextCursor).toBeNull()
    const first = await (await learningRequest(`records?archiveId=${request.requestId}&limit=1`)).json()
    expect(first.records).toHaveLength(1)
    expect(first.nextOrdinal).toBe(1)
    expect(JSON.stringify(first)).not.toContain('Only the original owner')
    const second = await (await learningRequest(`records?archiveId=${request.requestId}&after=${first.nextOrdinal}&limit=1`)).json()
    expect(second.records[0].recordId).not.toBe(first.records[0].recordId)
    expect(second.records[0]).toMatchObject({ sourceTable: 'journal_entries', recordedDate: '2026-10-30' })
    expect(JSON.stringify(second)).not.toContain('Only the original owner')
    const record = fixture.database.prepare('SELECT id FROM household_learning_records WHERE source_table = \'journal_entries\'').get() as { id: string }
    const detail = await (await learningRequest(`records/${record.id}`)).json()
    expect(detail.payload).toContain('Only the original owner')
    expect(detail).toMatchObject({ sourceSide: 'left', attribution: 'operator_custody_unreviewed', activation: 'historical_only' })
    for (const route of [`records?archiveId=${request.requestId}`, `records/${record.id}`, `archives?before=${request.requestId}`]) {
      const denied = await learningRequest(route, fixture.memberKey)
      expect(denied.status).toBe(404)
      expect(await denied.text()).not.toContain('Only the original owner')
    }
  })

  it.each(['limit=0', 'limit=51', 'limit=1&limit=2', 'limit=01', 'limit=1e1', 'side=left', 'accountId=guess', '__proto__=anything', 'constructor=anything'])('rejects ambiguous or unsafe library query %s', async (query) => {
    expect((await learningRequest(`archives?${query}`)).status).toBe(400)
  })

  it.each([-1, 0, 51, Infinity, NaN, 1.5])('bounds private library reads even without the HTTP adapter: %s', (limit) => {
    const library = new PersonalLearningLibrary(fixture.database, fixture.identities)
    expect(() => library.archives(fixture.ownerKey, null, limit)).toThrow()
    expect(() => library.records(fixture.ownerKey, request.requestId, 0, limit)).toThrow()
  })

  it.each([-1, 100_001, Infinity, NaN, 1.5])('rejects an invalid direct record cursor %s', (after) => {
    expect(() => new PersonalLearningLibrary(fixture.database, fixture.identities).records(fixture.ownerKey, request.requestId, after, 20)).toThrow()
  })

  it('withholds corrupt stored metadata instead of returning a successful library page', async () => {
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    fixture.database.exec('UPDATE household_learning_records SET kind = \'physical\' WHERE source_table = \'comfort_states\'')
    const response = await learningRequest(`records?archiveId=${request.requestId}`)
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('offsetF')
  })

  it.each(['revocation', 'account', 'assignment', 'disabled', 'changed_payload', 'abort'])('withdraws buffered private model output after %s', async (kind) => {
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    const record = fixture.database.prepare('SELECT id FROM household_learning_records LIMIT 1').get() as { id: string }
    let available = true
    const abort = new AbortController()
    const response = await learningRequest(`records/${record.id}`, fixture.ownerKey, () => available, abort.signal)
    expect(response.status).toBe(200)
    if (kind === 'revocation') fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?')
      .run(fixture.clock.now, fixture.owner.accountId)
    if (kind === 'disabled') available = false
    if (kind === 'account') fixture.database.prepare('UPDATE household_accounts SET state = \'revoked\' WHERE id = ?').run(fixture.owner.accountId)
    if (kind === 'assignment') fixture.database.prepare('UPDATE households SET assignment_revision = assignment_revision + 1').run()
    if (kind === 'abort') abort.abort()
    if (kind === 'changed_payload') fixture.database.prepare('UPDATE household_learning_records SET payload = \'{}\' WHERE id = ?').run(record.id)
    await expect(response.text()).rejects.toThrow('Private learning access or records changed before delivery')
  })

  it('preserves original learning custody and physical provenance before clearing selected models', () => {
    fixture.database.prepare('INSERT INTO journal_entries (side, local_date, revision, record) VALUES (?, ?, ?, ?)')
      .run('left', '2026-10-30', randomUUID(), JSON.stringify({ note: 'Original private night', warmth: 'warm' }))
    fixture.database.prepare('INSERT INTO side_stage_models (side, model, version, model_hash, uploaded_at, active) VALUES (?, ?, ?, ?, ?, 1)')
      .run('left', JSON.stringify({ trainingSide: 'left', datasetHash: 'original-dataset' }), 'original-version', 'a'.repeat(64), 100)
    fixture.database.prepare('INSERT INTO target_response_models (id, side, created_at, record) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), 'right', 200, JSON.stringify({ calibration: 'original-right-calibration' }))
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    const archive = verifyLearningArchive(fixture.database, request.requestId)
    expect(archive.binding).toMatchObject({ accountId: fixture.owner.accountId, sleeperId: fixture.owner.selfSleeperId,
      datasetId: source.identity.datasetId, sourceSide: 'left', attribution: 'operator_custody_unreviewed', activation: 'historical_only' })
    const rows = fixture.database.prepare('SELECT source_table, source_side, kind, payload FROM household_learning_records ORDER BY ordinal').all()
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_table: 'side_stage_models', source_side: 'left', kind: 'processing', payload: expect.stringContaining('original-dataset') }),
      expect.objectContaining({ source_table: 'target_response_models', source_side: 'right', kind: 'physical', payload: expect.stringContaining('original-right-calibration') }),
      expect.objectContaining({ source_table: 'journal_entries', source_side: 'left', kind: 'personal', payload: expect.stringContaining('Original private night') }),
      expect.objectContaining({ source_table: 'comfort_states', payload: expect.stringContaining('offsetF') }),
    ]))
    expect(JSON.stringify(rows)).not.toContain(fixture.ownerKey)
    expect(JSON.stringify(rows)).not.toContain(fixture.memberKey)
    expect(fixture.database.prepare('SELECT active FROM side_stage_models').get()).toEqual({ active: 0 })
    expect(fixture.database.prepare('SELECT account_id FROM household_learning_archives').all()).toEqual([{ account_id: fixture.owner.accountId }])
    expect(JSON.stringify(transition.readReceipt(fixture.ownerKey, request))).not.toContain('Original private night')
    const reopened = new Database(path.join(folder, 'configuration.db'))
    try {
      expect(verifyLearningArchive(reopened, request.requestId)).toEqual(archive)
    }
    finally {
      reopened.close()
    }
  })

  it('keeps SQLite integer source IDs exact and does not copy later feedback on request replay', () => {
    fixture.database.exec('INSERT INTO comfort_feedback (id, side, local_date, comfort, recorded_at) VALUES (9007199254740993, \'left\', \'2026-10-30\', \'warm\', 100)')
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    const before = verifyLearningArchive(fixture.database, request.requestId)
    const feedback = fixture.database.prepare('SELECT source_key, payload FROM household_learning_records WHERE source_table = \'comfort_feedback\'').get() as { source_key: string, payload: string }
    expect(feedback.source_key).toBe('[9007199254740993]')
    expect(feedback.payload).toContain('"id":9007199254740993')
    fixture.database.prepare('INSERT INTO comfort_feedback (side, local_date, comfort, recorded_at) VALUES (?, ?, ?, ?)').run('right', '2026-11-01', 'cold', 200)
    const replay = transition.commit(fixture.ownerKey, request)
    expect(replay.state).toBe('committed')
    expect(verifyLearningArchive(fixture.database, request.requestId)).toEqual(before)
  })

  it('keeps a deleted journal revision without recreating its note', () => {
    fixture.database.prepare('INSERT INTO journal_entries (side, local_date, revision, record) VALUES (?, ?, ?, NULL)')
      .run('left', '2026-10-30', randomUUID())
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    const archived = fixture.database.prepare('SELECT payload FROM household_learning_records WHERE source_table = \'journal_entries\'').get() as { payload: string }
    expect(JSON.parse(archived.payload)).toMatchObject({ record: null })
    expect(verifyLearningArchive(fixture.database, request.requestId).recordCount).toBeGreaterThan(0)
  })

  it('leaves the original records and hold intact if one payload exceeds the preservation limit', () => {
    fixture.database.prepare('INSERT INTO journal_entries (side, local_date, revision, record) VALUES (\'left\', \'2026-10-30\', ?, printf(\'%.*c\', ?, \'x\'))')
      .run(randomUUID(), learningArchiveLimits.recordBytes + 1)
    transition.begin(fixture.ownerKey, request)
    const before = state()
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow('exceeds the archive limit')
    expect(state()).toEqual(before)
    expect(admission.read().holdId).toBe(request.requestId)
    expect(fixture.database.prepare('SELECT length(record) AS length FROM journal_entries').get())
      .toEqual({ length: learningArchiveLimits.recordBytes + 1 })
  })

  it('rolls back partial archive inserts together with the arrangement after a storage failure', () => {
    fixture.database.prepare('INSERT INTO comfort_feedback (side, local_date, comfort, recorded_at) VALUES (?, ?, ?, ?)')
      .run('left', '2026-10-30', 'warm', 100)
    transition.begin(fixture.ownerKey, request)
    const before = state()
    fixture.database.exec('CREATE TRIGGER fail_archive BEFORE INSERT ON household_learning_records WHEN NEW.ordinal = 2 BEGIN SELECT RAISE(ABORT, \'archive_disk_failure\'); END')
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow('archive_disk_failure')
    expect(state()).toEqual(before)
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
  })

  it.each(['payload', 'custody', 'missing_record', 'ordinal'])('detects %s corruption in preserved learning', (kind) => {
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    if (kind === 'payload') fixture.database.exec('UPDATE household_learning_records SET payload = \'{}\' WHERE ordinal = 1')
    if (kind === 'custody') fixture.database.prepare('UPDATE household_learning_archives SET account_id = ?').run(fixture.member.accountId)
    if (kind === 'missing_record') fixture.database.exec('DELETE FROM household_learning_records WHERE ordinal = 1')
    if (kind === 'ordinal') fixture.database.exec('UPDATE household_learning_records SET ordinal = ordinal + 100')
    expect(() => verifyLearningArchive(fixture.database, request.requestId)).toThrow()
    expect(() => committedArrangementDigest(fixture.database, fixture.owner.householdId)).toThrow()
    expect(admission.read().holdId).toBe(request.requestId)
  })

  it.each(['missing', 'stale', 'future'])('requires %s controller proof to be corrected before holding', (problem) => {
    const controller = generation()
    if (problem === 'stale') controller.observedAt -= 5001
    if (problem === 'future') controller.observedAt++
    const store = makeStore(runId, () => problem === 'missing' ? null : controller)
    expect(() => store.begin(fixture.ownerKey, request)).toThrow()
    expect(admission.read().holdId).toBeNull()
  })

  it.each(['invocationId', 'pid', 'startTicks', 'bootId'] as const)('keeps held after actual %s changes even with an unchanged app run ID', (field) => {
    const controller = generation()
    const store = makeStore(runId, () => controller)
    store.begin(fixture.ownerKey, request)
    if (field === 'invocationId') controller.invocationId = 'b'.repeat(32)
    if (field === 'pid') controller.pid++
    if (field === 'startTicks') controller.startTicks = '2000'
    if (field === 'bootId') controller.bootId = randomUUID()
    const before = state()
    expect(() => store.commit(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
    expect(admission.read().holdId).toBe(request.requestId)
  })

  it('holds and records together, changes both weeks and identities together, and stays closed for recovery', async () => {
    const operating = ownWeek('left')[0]?.draft
    const draft = fixture.identities.routines(fixture.ownerKey)
    const held = transition.begin(fixture.ownerKey, request)
    expect(held).toMatchObject({ state: 'held', admissionRevision: 2 })
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
    await waitForHardwareDrain(request.requestId)
    const committed = transition.commit(fixture.ownerKey, request)
    expect(committed).toMatchObject({ state: 'committed', hardware: 'held_for_runtime_recovery' })
    expect(ownWeek('right')).toMatchObject([{ dayOfWeek: 'monday', draft: operating }])
    expect(ownWeek('left')).toMatchObject([{ dayOfWeek: 'friday', draft: { notes: 'Partner private draft', power: { onTemperature: 82 }, alarm: null } }])
    expect(fixture.identities.routines(fixture.ownerKey)).toMatchObject({ revision: draft.revision, routines: draft.routines })
    expect(fixture.identities.session(fixture.ownerKey)).toMatchObject({ sessionRevision: 2, assignmentRevision: 2, self: { assignment: 'right' } })
    expect(fixture.identities.session(fixture.memberKey)).toMatchObject({ sessionRevision: 2, assignmentRevision: 2, self: { assignment: 'left' } })
    expect(createComfortLimitStore(fixture.database).read('right').config).toEqual({ enabled: true, minF: 68, maxF: 72 })
    expect(createComfortLimitStore(fixture.database).read('left').config.enabled).toBe(false)
    expect(fixture.database.prepare('SELECT state FROM comfort_states').all().map(row => JSON.parse((row as { state: string }).state).config.mode)).toEqual(['off', 'off'])
    expect(fixture.database.prepare('SELECT bed_mode, autopilot_enabled FROM device_settings').get()).toEqual({ bed_mode: 'two', autopilot_enabled: 0 })
    expect(admission.read()).toEqual({ revision: 2, holdId: request.requestId })
    const saved = fixture.database.prepare('SELECT archive, committed_hash FROM household_arrangement_transitions').get() as { archive: string, committed_hash: string }
    expect(saved.archive).toContain('offsetF')
    expect(saved.archive).not.toContain('mqtt_password')
    expect(saved.committed_hash).toBe(committedArrangementDigest(fixture.database, fixture.owner.householdId))
    expect(JSON.stringify(committed)).not.toMatch(/Partner private draft|Owner private operating|offsetF/)
  })

  it('retains private copies and withholds the reload interval instead of attributing old pipeline output to the new sleeper', () => {
    const sample = { householdId: fixture.owner.householdId, datasetId: source.identity.datasetId, sourceRecordKey: 'old-night', recordedSide: 'left',
      startsAt: fixture.clock.now - 1500, endsAt: fixture.clock.now - 500, payload: { kind: 'presence', reportedPresenceSeconds: 1, exits: 0, interpretation: 'bed_presence_not_sleep' } }
    expect(history.admitObservation(sample).status).toBe('admitted')
    const before = fixture.database.prepare('SELECT * FROM household_person_records').all()
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    expect(fixture.database.prepare('SELECT * FROM household_person_records').all()).toEqual(before)
    const boundary = fixture.clock.now
    fixture.clock.now += 2000
    expect(history.admitObservation({ ...sample, sourceRecordKey: 'new-night', startsAt: boundary, endsAt: boundary + 1000 }).status).toBe('withheld')
    expect(history.admitObservation({ ...sample, sourceRecordKey: 'crossing-night', startsAt: boundary - 500, endsAt: boundary + 500 }).status).toBe('withheld')
    expect(fixture.database.prepare('SELECT source_record_key, sleeper_id FROM household_person_records ORDER BY sequence').all()).toEqual([
      { source_record_key: 'old-night', sleeper_id: fixture.owner.selfSleeperId },
    ])
  })

  it('makes lost-response replays idempotent without replaying writes after request expiry or restart', () => {
    expect(transition.begin(fixture.ownerKey, request)).toEqual(transition.begin(fixture.ownerKey, request))
    transition.commit(fixture.ownerKey, request)
    const before = state()
    fixture.clock.now += 60_000
    expect(makeStore(randomUUID()).commit(fixture.ownerKey, request).state).toBe('committed')
    expect(transition.begin(fixture.ownerKey, request).state).toBe('committed')
    expect(state()).toEqual(before)
    expect(() => transition.commit(fixture.ownerKey, { ...request, expiresAt: request.expiresAt + 1 })).toThrow()
  })

  it.each(['receipt', 'routine', 'identity', 'final_receipt'] as const)('rolls back every related table when %s cannot be written', (failure) => {
    const table = failure === 'receipt' || failure === 'final_receipt' ? 'household_arrangement_transitions' : failure === 'routine' ? 'alarm_schedules' : 'households'
    const event = failure === 'receipt' || failure === 'routine' ? 'INSERT' : 'UPDATE'
    if (failure !== 'receipt') transition.begin(fixture.ownerKey, request)
    const before = state()
    fixture.database.exec(`CREATE TRIGGER fail_transition BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected_disk_failure'); END`)
    expect(() => failure === 'receipt' ? transition.begin(fixture.ownerKey, request) : transition.commit(fixture.ownerKey, request)).toThrow('injected_disk_failure')
    expect(state()).toEqual(before)
    expect(admission.read().holdId).toBe(failure === 'receipt' ? null : request.requestId)
  })

  it.each(['expired', 'stop'])('rechecks %s after the final receipt write and rolls back the whole configuration', (problem) => {
    transition.begin(fixture.ownerKey, request)
    fixture.database.function('interrupt_commit', () => {
      if (problem === 'expired') fixture.clock.now = request.expiresAt
      else finishes.push(beginHardwareWrite(captureHardwareIntent(), true))
      return 1
    })
    fixture.database.exec('CREATE TRIGGER interrupt_transition AFTER UPDATE OF state ON household_arrangement_transitions BEGIN SELECT interrupt_commit(); END')
    const before = state()
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
    expect(admission.read()).toEqual({ revision: 2, holdId: request.requestId })
  })

  it.each(['presence', 'thermal', 'alarm', 'base'] as const)('rejects independently stale or future %s evidence before hold and before commit', (sourceName) => {
    const fresh = proof[sourceName].observedAt
    proof[sourceName].observedAt -= 5001
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    expect(admission.read().holdId).toBeNull()
    proof[sourceName].observedAt = fresh
    transition.begin(fixture.ownerKey, request)
    const before = state()
    proof[sourceName].observedAt = fresh + 1
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
  })

  it.each(['presence', 'thermal', 'alarm', 'base'] as const)('rejects active, unknown or missing %s observations', (sourceName) => {
    const bad = {
      presence: { ...proof.presence, left: 'unknown' }, thermal: { ...proof.thermal, leftPowered: true },
      alarm: { ...proof.alarm, snoozing: true }, base: { ...proof.base, state: 'moving' },
    }
    proof = { ...proof, [sourceName]: bad[sourceName] } as ArrangementObservation
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    expect(admission.read().holdId).toBeNull()
  })

  it.each(['cancel', 'revoke', 'routine', 'preference', 'limits', 'source', 'epoch'] as const)('keeps admission held when %s changes after the hold', (change) => {
    transition.begin(fixture.ownerKey, request)
    if (change === 'cancel') reviews.cancel(fixture.memberKey, { ...context(fixture.memberKey), version: 1, reviewId: request.reviewId })
    if (change === 'revoke') fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?').run(fixture.clock.now, fixture.member.accountId)
    if (change === 'routine') fixture.database.prepare('UPDATE household_personal_settings SET routines_revision = routines_revision + 1 WHERE account_id = ?').run(fixture.member.accountId)
    if (change === 'preference') fixture.database.prepare('UPDATE household_personal_settings SET preferences_revision = preferences_revision + 1 WHERE account_id = ?').run(fixture.owner.accountId)
    if (change === 'limits') createComfortLimitStore(fixture.database).save('left', 1, { enabled: true, minF: 69, maxF: 73 })
    if (change === 'source') source.biometrics.prepare('UPDATE biometric_history_identity SET dataset_id = ?').run(randomUUID())
    if (change === 'epoch') fixture.database.prepare('UPDATE household_attribution_epochs SET revoked_at = ?').run(fixture.clock.now)
    const before = state()
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
    expect(admission.read().holdId).toBe(request.requestId)
  })

  it('cannot begin as a member, use another request ID or take an unrelated hold', () => {
    expect(() => transition.begin(fixture.memberKey, { ...request, ...context(fixture.memberKey) })).toThrow()
    expect(admission.read().holdId).toBeNull()
    transition.begin(fixture.ownerKey, request)
    expect(() => transition.begin(fixture.ownerKey, { ...request, requestId: randomUUID() })).toThrow()
    expect(() => transition.commit(fixture.memberKey, request)).toThrow()
    expect(admission.read().holdId).toBe(request.requestId)
  })

  it('requires both approvals and an existing reviewed solo history source, never creating either', () => {
    const approvals = fixture.database.prepare('SELECT * FROM household_arrangement_approvals').all() as Record<string, string | number>[]
    fixture.database.prepare('DELETE FROM household_arrangement_approvals WHERE account_id = ?').run(fixture.member.accountId)
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    for (const row of approvals.filter(row => row.account_id === fixture.member.accountId)) fixture.database.prepare('INSERT INTO household_arrangement_approvals (request_id, review_id, account_id, device_id, request_hash, created_at) VALUES (@request_id, @review_id, @account_id, @device_id, @request_hash, @created_at)').run(row)
    fixture.database.prepare('DELETE FROM household_history_sources').run()
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    expect(admission.read().holdId).toBeNull()
    expect(fixture.database.prepare('SELECT * FROM household_history_sources').all()).toEqual([])
  })

  it('does not invent a missing receipt for an orphaned hardware hold', () => {
    admission.hold(request.requestId)
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    expect(fixture.database.prepare('SELECT * FROM household_arrangement_transitions').all()).toEqual([])
    expect(admission.read()).toEqual({ revision: 2, holdId: request.requestId })
  })

  it.each(['request_hash', 'request', 'context', 'state'] as const)('rejects a corrupt saved %s without releasing admission', (column) => {
    transition.begin(fixture.ownerKey, request)
    fixture.database.prepare(`UPDATE household_arrangement_transitions SET ${column} = ?`).run('corrupt')
    const before = state()
    expect(() => transition.begin(fixture.ownerKey, request)).toThrow()
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    expect(state()).toEqual(before)
    expect(admission.read().holdId).toBe(request.requestId)
  })

  it('retains holds and complete committed state when the database is reopened', () => {
    transition.begin(fixture.ownerKey, request)
    let reopened = new Database(path.join(folder, 'configuration.db'))
    expect(new HardwareAdmissionStore(reopened).read()).toEqual({ revision: 2, holdId: request.requestId })
    expect(reopened.prepare('SELECT state FROM household_arrangement_transitions').get()).toEqual({ state: 'held' })
    reopened.close()
    transition.commit(fixture.ownerKey, request)
    reopened = new Database(path.join(folder, 'configuration.db'))
    try {
      expect(new HardwareAdmissionStore(reopened).read()).toEqual({ revision: 2, holdId: request.requestId })
      expect(reopened.prepare('SELECT state FROM household_arrangement_transitions').get()).toEqual({ state: 'committed' })
      expect(committedArrangementDigest(reopened, fixture.owner.householdId)).toBe(committedArrangementDigest(fixture.database, fixture.owner.householdId))
    }
    finally { reopened.close() }
  })

  it('clears transient actions and disables old automatic owners while preserving their recovery archive', () => {
    fixture.database.prepare('INSERT INTO temperature_holds VALUES (?, ?, ?, ?)').run('left', 70, fixture.clock.now, fixture.clock.now + 60_000)
    fixture.database.prepare('INSERT INTO temporary_cooling VALUES (?, ?)').run('left', JSON.stringify({ fixture: 'temporary cooling' }))
    fixture.database.prepare('INSERT INTO alarm_overrides VALUES (?, ?, ?)').run('left', randomUUID(), JSON.stringify({ fixture: 'temporary alarm' }))
    fixture.database.prepare('INSERT INTO run_once_sessions (side, set_points, wake_time, expires_at) VALUES (?, ?, ?, ?)').run('left', '[]', '08:00', Math.floor(fixture.clock.now / 1000) + 60)
    fixture.database.prepare('UPDATE side_settings SET auto_on_enabled = 1, always_on = 1, stage_classifier = ?').run(JSON.stringify({ fixture: 'personal classifier' }))
    // Changes before either person sees the review require a replacement review.
    reviews.cancel(fixture.ownerKey, { ...context(), version: 1, reviewId: request.reviewId })
    const next = reviews.propose(fixture.ownerKey, { ...context(), version: 1, ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true })
    for (const key of [fixture.ownerKey, fixture.memberKey]) reviews.approve(key, { ...context(key), version: 1, reviewId: next.reviewId,
      issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000, confirmMySide: true, confirmMyRoutine: true, acknowledgeSeparateActivation: true })
    request = { ...request, reviewId: next.reviewId }
    transition.begin(fixture.ownerKey, request)
    transition.commit(fixture.ownerKey, request)
    expect(fixture.database.prepare('SELECT * FROM temperature_holds').all()).toEqual([])
    expect(fixture.database.prepare('SELECT * FROM temporary_cooling').all()).toEqual([])
    expect(fixture.database.prepare('SELECT record FROM alarm_overrides').all()).toEqual([{ record: null }, { record: null }])
    expect(fixture.database.prepare('SELECT status FROM run_once_sessions').get()).toEqual({ status: 'cancelled' })
    expect(fixture.database.prepare('SELECT auto_on_enabled, always_on, stage_classifier FROM side_settings').all()).toEqual([
      { auto_on_enabled: 0, always_on: 0, stage_classifier: null }, { auto_on_enabled: 0, always_on: 0, stage_classifier: null },
    ])
    const archive = (fixture.database.prepare('SELECT archive FROM household_arrangement_transitions').get() as { archive: string }).archive
    expect(archive).toContain('temporary cooling')
    expect(archive).toContain('temporary alarm')
    expect(archive).toContain('personal classifier')
  })

  it('rechecks in-flight Stop work after drain and before the atomic commit', async () => {
    const oldIntent = captureHardwareIntent()
    const finish = beginHardwareWrite(oldIntent)
    finishes.push(finish)
    transition.begin(fixture.ownerKey, request)
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    finish()
    await waitForHardwareDrain(request.requestId)
    const finishStop = beginHardwareWrite(captureHardwareIntent(), true)
    finishes.push(finishStop)
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    finishStop()
    expect(transition.commit(fixture.ownerKey, request).state).toBe('committed')
    expect(() => beginHardwareWrite(oldIntent)).toThrow()
  })

  it('will not commit a held operation after runtime restart, expiry, or feature withdrawal', () => {
    transition.begin(fixture.ownerKey, request)
    expect(() => makeStore(randomUUID()).commit(fixture.ownerKey, request)).toThrow()
    enabled = false
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    enabled = true
    fixture.clock.now = request.expiresAt
    expect(() => transition.commit(fixture.ownerKey, request)).toThrow()
    expect(admission.read().holdId).toBe(request.requestId)
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
  })
})

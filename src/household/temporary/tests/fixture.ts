import { randomUUID } from 'node:crypto'
import type { BedtimeDraft } from '@/src/lib/bedtimeRoutines'
import { replaceBedtimeRoutineBatch } from '@/src/server/bedtimeRoutineTransaction'
import { PersonHistoryStore } from '../../personHistory'
import { personalRuntimeFixture } from '../../tests/runtimeFixture'
import { historySourceFixture } from '../../tests/historySourceFixture'
import { TemporaryArrangementReviews } from '../reviews'
import { TemporaryArrangementSource } from '../source'

const night = (temperature: number, notes: string): BedtimeDraft => ({
  power: { onTime: '22:00', offTime: '07:15', onTemperature: temperature, enabled: true, endAction: 'maintain' }, temperatures: [],
  alarm: { time: '07:00', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 20, alarmTemperature: 105, enabled: true,
    wakeWindow: 0, snoozeDuration: 540, snoozeTaper: 30 }, notes,
})

/** Isolated migrated stores with reviewed fixture identities; no live services or user data. */
export function temporaryFixture(solo = false) {
  const fixture = personalRuntimeFixture()
  const source = historySourceFixture(fixture.database, fixture.owner, () => fixture.clock.now)
  const history = new PersonHistoryStore(fixture.database, fixture.identities, source.source, () => fixture.clock.now)
  if (!solo) {
    fixture.assignedFixture()
    fixture.database.exec('UPDATE device_settings SET unused_zone_mode = \'off\'')
  }
  const context = (key = fixture.ownerKey) => {
    const session = fixture.identities.session(key)
    return { requestId: randomUUID(), expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision }
  }
  for (const key of [fixture.ownerKey, fixture.memberKey]) {
    const current = fixture.identities.preferences(key)
    fixture.identities.updatePreferences(key, { ...context(key), expectedRevision: current.revision,
      preferences: { ...current.preferences, preferredTemperatureF: key === fixture.ownerKey ? 70 : 82 } })
    fixture.identities.updateRoutines(key, { ...context(key), expectedRevision: fixture.identities.routines(key).revision,
      routines: [{ dayOfWeek: 'friday', draft: night(90, 'Unpublished private draft') }] })
  }
  replaceBedtimeRoutineBatch(fixture.database, [
    { side: solo ? 'left' : 'right', changes: [{ dayOfWeek: 'sunday', expectedRevision: null, replacement: night(70, 'Owner private week') }] },
    ...solo ? [] : [{ side: 'left' as const, changes: [{ dayOfWeek: 'saturday' as const, expectedRevision: null, replacement: night(82, 'Partner private week') }] }],
  ])
  const epoch = history.appendReviewedEpoch({ householdId: fixture.owner.householdId, datasetId: source.identity.datasetId,
    expectedAttributionRevision: 1, startsAt: fixture.clock.now, endsAt: null, mode: solo ? 'solo_merged' : 'assigned', basis: 'verified_arrangement',
    reviewReceiptId: randomUUID(), reviewedBy: fixture.owner.accountId,
    assignments: solo
      ? [{ sleeperId: fixture.owner.selfSleeperId, recordedSide: 'left' }]
      : [
          { sleeperId: fixture.owner.selfSleeperId, recordedSide: 'right' }, { sleeperId: fixture.member.selfSleeperId, recordedSide: 'left' },
        ] })
  fixture.clock.now += 2000
  const sourceReader = new TemporaryArrangementSource(fixture.database, source.source, () => fixture.clock.now)
  const makeService = () => new TemporaryArrangementReviews({ database: fixture.database, identities: fixture.identities,
    readSource: householdId => sourceReader.read(householdId), enabled: () => fixture.clock.enabled, now: () => fixture.clock.now })
  const service = makeService()
  const proposal = () => ({ ...context(), version: 1, endsAt: fixture.clock.now + 12 * 3600_000,
    ...solo ? { kind: 'guest', residentSide: 'right', acknowledgeGuestRecordingWithheld: true } : { kind: 'side_swap' } })
  const approval = (reviewId: string, key = fixture.ownerKey) => ({ ...context(key), version: 1, reviewId,
    issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000,
    confirmMySide: true, confirmMyRoutine: true, acknowledgeRecordingPolicy: true, acknowledgeSeparateActivation: true })
  const operating = () => ['households', 'household_accounts', 'household_personal_settings', 'device_settings', 'side_settings',
    'bedtime_routines', 'power_schedules', 'temperature_schedules', 'alarm_schedules', 'household_attribution_epochs',
    'household_history_state', 'comfort_states', 'comfort_activations', 'base_schedules', 'household_person_records']
    .map(table => fixture.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  return { ...fixture, source, history, epoch, context, sourceReader, makeService, service, proposal, approval, operating,
    close: () => {
      source.biometrics.close()
      fixture.database.close()
    } }
}

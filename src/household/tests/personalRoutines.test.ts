import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BedtimeDraft } from '@/src/lib/bedtimeRoutines'
import { replaceBedtimeRoutineBatch, type RoutineDelta } from '@/src/server/bedtimeRoutineTransaction'
import { PersonalRoutineService } from '../personalRoutines'
import type { PersonalRoutinePublish } from '../routineContract'
import { personalRuntimeFixture } from './runtimeFixture'

let fixture: ReturnType<typeof personalRuntimeFixture>, service: PersonalRoutineService, publicationEnabled: boolean
let refresh: ReturnType<typeof vi.fn<(delta: RoutineDelta) => Promise<boolean>>>
let duringLockWait: () => void, lockedZones: Array<Array<'left' | 'right'>>, monotonic: number
const currentRequest = () => {}
const night: BedtimeDraft = {
  power: { onTime: '22:00', offTime: '07:15', onTemperature: 70, enabled: true, endAction: 'maintain' }, temperatures: [],
  alarm: { time: '07:00', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 20, alarmTemperature: 105, enabled: true,
    wakeWindow: 0, snoozeDuration: 540, snoozeTaper: 30 }, notes: 'Existing owner week',
}
const week = (temperature = 70) => [{ dayOfWeek: 'sunday' as const, draft: { ...night, power: { ...night.power, onTemperature: temperature } } }]
function prepareDraft(temperature = 69, key = fixture.ownerKey) {
  const session = fixture.identities.session(key)
  fixture.identities.updateRoutines(key, { requestId: randomUUID(), expectedSessionRevision: session.sessionRevision,
    expectedAssignmentRevision: session.assignmentRevision, expectedRevision: fixture.identities.routines(key).revision, routines: week(temperature) })
}
function request(key = fixture.ownerKey): PersonalRoutinePublish {
  const review = service.review(key, currentRequest)
  return { version: 1, requestId: randomUUID(), scope: review.scope, reviewRevision: review.reviewRevision,
    issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30_000, confirmReplaceLiveWeek: true, acknowledgeCurrentTargetEffect: true }
}
function createService(runId = 'test-process') {
  return new PersonalRoutineService({ database: fixture.database, identities: fixture.identities, authority: fixture.runtime.authority,
    enabled: () => publicationEnabled, now: () => fixture.clock.now, monotonicNow: () => monotonic, runId, refreshScheduler: delta => refresh(delta),
    withZones: async (zones, operation) => {
      lockedZones.push(zones)
      duringLockWait()
      return operation()
    } })
}
const rows = () => ['bedtime_routines', 'power_schedules', 'temperature_schedules', 'alarm_schedules', 'household_mutation_receipts']
  .map(table => fixture.database.prepare(`SELECT * FROM ${table}`).all())
beforeEach(() => {
  fixture = personalRuntimeFixture()
  publicationEnabled = true
  duringLockWait = () => {}
  lockedZones = []
  monotonic = 100
  refresh = vi.fn(async () => true)
  service = createService()
  replaceBedtimeRoutineBatch(fixture.database, [{ side: 'left', changes: [{ dayOfWeek: 'sunday', expectedRevision: null, replacement: night }] }])
})
afterEach(() => fixture.database.close())

describe('reviewed personal routine publication', () => {
  it('shows the actual live 70F week but refuses to publish an untouched new-account draft', async () => {
    const before = rows()
    const review = service.review(fixture.ownerKey, currentRequest)
    expect(review.liveWeek[0].draft.power.onTemperature).toBe(70)
    expect(review.liveWeek[0].draft.alarm).toMatchObject({ alarmTemperature: 105, duration: 20, snoozeDuration: 540 })
    expect(review).toMatchObject({ draftWeek: [], canPublish: false, reason: 'draft_not_prepared', temperatureZones: ['left', 'right'], sourceSide: 'left' })
    await expect(service.publish(fixture.ownerKey, request(), currentRequest)).rejects.toThrow('no changes are ready')
    expect(rows()).toEqual(before)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('keeps draft saves inert and publishes only the exact comparison after explicit confirmation', async () => {
    const before = fixture.database.prepare('SELECT * FROM power_schedules').all()
    prepareDraft()
    expect(fixture.database.prepare('SELECT * FROM power_schedules').all()).toEqual(before)
    const input = request()
    expect(service.review(fixture.ownerKey, currentRequest)).toMatchObject({ canPublish: true, changes: [{ dayOfWeek: 'sunday', operation: 'replace' }] })
    const receipt = await service.publish(fixture.ownerKey, input, currentRequest)
    expect(receipt).toMatchObject({ state: 'saved', scheduler: 'refreshed', sourceSide: 'left', physicalVerification: 'unverified', replayAllowed: false })
    expect(receipt.publishedWeek[0].draft.power.onTemperature).toBe(69)
    expect(fixture.database.prepare('SELECT side, day_of_week, time, alarm_temperature, duration FROM alarm_schedules').all())
      .toEqual([{ side: 'left', day_of_week: 'monday', time: '07:00', alarm_temperature: 105, duration: 20 }])
    expect(lockedZones).toEqual([['left', 'right']])
    expect(refresh).toHaveBeenCalledOnce()
    expect(await service.publish(fixture.ownerKey, input, currentRequest)).toEqual(receipt)
    expect(service.get(fixture.memberKey, input.requestId, currentRequest)).toBeNull()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it.each(['draft', 'live', 'assignment', 'timezone', 'revoked', 'expired', 'browser'] as const)(
    'rejects a stale %s after waiting for locks without publishing a single schedule', async (change) => {
      prepareDraft()
      const input = request()
      let browserCurrent = true
      duringLockWait = () => {
        if (change === 'draft') prepareDraft(68)
        if (change === 'live') {
          const current = service.review(fixture.ownerKey, currentRequest)
          replaceBedtimeRoutineBatch(fixture.database, [{ side: 'left', changes: [{ dayOfWeek: 'sunday', expectedRevision: current.liveWeek[0].revision, replacement: { ...night, notes: 'Changed elsewhere' } }] }])
        }
        if (change === 'assignment') fixture.assignedFixture()
        if (change === 'timezone') fixture.database.exec('UPDATE device_settings SET timezone = \'America/New_York\'')
        if (change === 'revoked') fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE id = ?').run(fixture.clock.now, fixture.identities.deviceIdentity(fixture.ownerKey))
        if (change === 'expired') fixture.clock.now += 31_000
        if (change === 'browser') browserCurrent = false
      }
      await expect(service.publish(fixture.ownerKey, input, () => {
        if (!browserCurrent) throw new Error('Browser changed')
      })).rejects.toThrow()
      expect(fixture.database.prepare('SELECT on_temperature FROM power_schedules').all()).toEqual([{ on_temperature: 70 }])
      expect(fixture.database.prepare('SELECT request_id FROM household_mutation_receipts WHERE kind = \'routine_publication\'').all()).toEqual([])
      expect(refresh).not.toHaveBeenCalled()
    })

  it('never permits a joined but unassigned partner to publish to the owner source', async () => {
    prepareDraft()
    const input = request()
    await expect(service.publish(fixture.memberKey, input, currentRequest)).rejects.toThrow('assignment is unavailable')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('publishes only the assigned person’s side and leaves the partner schedule byte-for-byte intact', async () => {
    fixture.assignedFixture()
    const currentPartnerWeek = service.review(fixture.memberKey, currentRequest).liveWeek
    replaceBedtimeRoutineBatch(fixture.database, [{ side: 'left', changes: [{ dayOfWeek: 'sunday', expectedRevision: currentPartnerWeek[0].revision,
      replacement: { ...night, power: { ...night.power, onTemperature: 82 }, alarm: null, notes: 'Separate partner fixture' } }] }])
    const partnerBefore = fixture.database.prepare('SELECT * FROM bedtime_routines WHERE side = \'left\'').all()
    prepareDraft(70)
    const receipt = await service.publish(fixture.ownerKey, request(), currentRequest)
    expect(receipt.sourceSide).toBe('right')
    expect(lockedZones).toEqual([['right']])
    expect(fixture.database.prepare('SELECT * FROM bedtime_routines WHERE side = \'left\'').all()).toEqual(partnerBefore)
    expect(fixture.database.prepare('SELECT on_temperature FROM power_schedules WHERE side = \'right\'').get()).toEqual({ on_temperature: 70 })
    expect(service.review(fixture.memberKey, currentRequest).liveWeek[0].draft.power.onTemperature).toBe(82)
  })

  it('rolls the schedule back if its publication receipt cannot be durably saved', async () => {
    prepareDraft()
    const before = rows()
    fixture.database.exec('CREATE TRIGGER reject_publication BEFORE INSERT ON household_mutation_receipts WHEN NEW.kind = \'routine_publication\' BEGIN SELECT RAISE(ABORT, \'storage_failed\'); END;')
    await expect(service.publish(fixture.ownerKey, request(), currentRequest)).rejects.toThrow('storage_failed')
    expect(rows()).toEqual(before)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('reports committed changes separately when scheduler refresh fails and never replays on reconnect', async () => {
    prepareDraft()
    refresh.mockRejectedValueOnce(new Error('scheduler unavailable'))
    const input = request()
    const receipt = await service.publish(fixture.ownerKey, input, currentRequest)
    expect(receipt).toMatchObject({ state: 'saved', scheduler: 'unconfirmed' })
    service = createService('restarted')
    fixture.clock.now += 60_000
    expect(await service.publish(fixture.ownerKey, input, currentRequest)).toEqual(receipt)
    expect(fixture.database.prepare('SELECT on_temperature FROM power_schedules').get()).toEqual({ on_temperature: 69 })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('rejects a changed duplicate ID and keeps another person from discovering a receipt', async () => {
    prepareDraft()
    const input = request()
    await service.publish(fixture.ownerKey, input, currentRequest)
    await expect(service.publish(fixture.ownerKey, { ...input, expiresAt: input.expiresAt + 1 }, currentRequest)).rejects.toThrow('identifier')
    await expect(service.publish(fixture.memberKey, input, currentRequest)).rejects.toThrow('identifier')
    expect(service.get(fixture.memberKey, input.requestId, currentRequest)).toBeNull()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('withholds the private response after revocation during scheduler refresh but retains the saved receipt', async () => {
    prepareDraft()
    const deviceId = fixture.identities.deviceIdentity(fixture.ownerKey)
    const input = request()
    refresh.mockImplementationOnce(async () => {
      fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE id = ?').run(fixture.clock.now, deviceId)
      return true
    })
    await expect(service.publish(fixture.ownerKey, input, currentRequest)).rejects.toThrow()
    expect(fixture.database.prepare('SELECT on_temperature FROM power_schedules').get()).toEqual({ on_temperature: 69 })
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_mutation_receipts WHERE kind = \'routine_publication\'').get()).toEqual({ count: 1 })
  })

  it('keeps publication disabled until its separate runtime flag is enabled', async () => {
    prepareDraft()
    publicationEnabled = false
    expect(service.present(fixture.identities.session(fixture.ownerKey)).capabilities.personalRoutinePublication).toBe(false)
    expect(service.review(fixture.ownerKey, currentRequest)).toMatchObject({ canPublish: false, reason: 'publication_disabled' })
    await expect(service.publish(fixture.ownerKey, request(), currentRequest)).rejects.toThrow('not enabled')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('does not extend publication lifetime after a wall-clock rollback during the lock wait', async () => {
    prepareDraft()
    const input = request()
    duringLockWait = () => {
      fixture.clock.now += 10_000
      monotonic += 31_000
    }
    await expect(service.publish(fixture.ownerKey, input, currentRequest)).rejects.toThrow('expired')
    expect(fixture.database.prepare('SELECT on_temperature FROM power_schedules').get()).toEqual({ on_temperature: 70 })
  })

  it('preserves unchanged days and refuses invalid time zones instead of writing an unusable schedule', async () => {
    prepareDraft(70)
    const before = rows()
    expect(service.review(fixture.ownerKey, currentRequest)).toMatchObject({ canPublish: false, reason: 'unchanged', changes: [] })
    await expect(service.publish(fixture.ownerKey, request(), currentRequest)).rejects.toThrow('no changes are ready')
    expect(rows()).toEqual(before)
    fixture.database.exec('UPDATE device_settings SET timezone = \'invalid/timezone\'')
    expect(() => service.review(fixture.ownerKey, currentRequest)).toThrow('time zone is invalid')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('can explicitly remove a reviewed week after the person saves an empty draft', async () => {
    const session = fixture.identities.session(fixture.ownerKey)
    fixture.identities.updateRoutines(fixture.ownerKey, { requestId: randomUUID(), expectedSessionRevision: session.sessionRevision,
      expectedAssignmentRevision: session.assignmentRevision, expectedRevision: 1, routines: [] })
    const input = request()
    await expect(service.publish(fixture.ownerKey, { ...input, confirmReplaceLiveWeek: false }, currentRequest)).rejects.toThrow()
    await expect(service.publish(fixture.ownerKey, { ...input, acknowledgeCurrentTargetEffect: false }, currentRequest)).rejects.toThrow()
    expect(await service.publish(fixture.ownerKey, input, currentRequest)).toMatchObject({ state: 'saved', publishedWeek: [], changes: [{ dayOfWeek: 'sunday', operation: 'remove' }] })
    expect(fixture.database.prepare('SELECT * FROM power_schedules').all()).toEqual([])
    expect(fixture.database.prepare('SELECT * FROM alarm_schedules').all()).toEqual([])
  })

  it('keeps committed schedules after a failed completion update and reports the orphan as unconfirmed', async () => {
    prepareDraft()
    const input = request()
    fixture.database.exec('CREATE TRIGGER reject_completion BEFORE UPDATE OF result ON household_mutation_receipts WHEN NEW.kind = \'routine_publication\' BEGIN SELECT RAISE(ABORT, \'completion_failed\'); END;')
    await expect(service.publish(fixture.ownerKey, input, currentRequest)).rejects.toThrow('completion_failed')
    service = createService('restarted')
    expect(service.get(fixture.ownerKey, input.requestId, currentRequest)).toMatchObject({ state: 'saved', scheduler: 'unconfirmed' })
    expect(await service.publish(fixture.ownerKey, input, currentRequest)).toMatchObject({ state: 'saved', scheduler: 'unconfirmed' })
    expect(refresh).toHaveBeenCalledOnce()
    expect(fixture.database.prepare('SELECT on_temperature FROM power_schedules').get()).toEqual({ on_temperature: 69 })
  })

  it('keeps unchanged weekday row IDs when only another night is edited', async () => {
    replaceBedtimeRoutineBatch(fixture.database, [{ side: 'left', changes: [{ dayOfWeek: 'friday', expectedRevision: null, replacement: night }] }])
    const before = fixture.database.prepare('SELECT * FROM alarm_schedules WHERE day_of_week = \'saturday\'').get()
    fixture.identities.updateRoutines(fixture.ownerKey, { requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1,
      expectedRevision: 1, routines: [...week(69), { dayOfWeek: 'friday', draft: night }] })
    expect(service.review(fixture.ownerKey, currentRequest).changes).toEqual([{ dayOfWeek: 'sunday', operation: 'replace' }])
    await service.publish(fixture.ownerKey, request(), currentRequest)
    expect(fixture.database.prepare('SELECT * FROM alarm_schedules WHERE day_of_week = \'saturday\'').get()).toEqual(before)
  })

  it('requires migration rather than overwriting unowned legacy calendar rows', async () => {
    fixture.database.exec('DELETE FROM bedtime_routines')
    prepareDraft()
    const before = rows()
    expect(service.review(fixture.ownerKey, currentRequest)).toMatchObject({ canPublish: false, reason: 'calendar_migration_required' })
    await expect(service.publish(fixture.ownerKey, request(), currentRequest)).rejects.toThrow('no changes are ready')
    expect(rows()).toEqual(before)
  })

  it('does not perform two publications when an exact duplicate arrives during scheduler refresh', async () => {
    prepareDraft()
    let finishRefresh: ((refreshed: boolean) => void) | undefined
    refresh.mockImplementationOnce(() => new Promise((resolve) => {
      finishRefresh = resolve
    }))
    const input = request()
    const original = service.publish(fixture.ownerKey, input, currentRequest)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(await service.publish(fixture.ownerKey, input, currentRequest)).toMatchObject({ state: 'saved', scheduler: 'pending' })
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_mutation_receipts WHERE kind = \'routine_publication\'').get()).toEqual({ count: 1 })
    if (!finishRefresh) throw new Error('Expected the pending refresh')
    finishRefresh(true)
    expect(await original).toMatchObject({ state: 'saved', scheduler: 'refreshed' })
    expect(refresh).toHaveBeenCalledOnce()
  })
})

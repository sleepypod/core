import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAlarmStore } from '@/src/alarms/store'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { householdHttp } from '../http'
import { personalNextWakeSchema } from '../personalWake'
import { personalRuntimeFixture } from './runtimeFixture'
import sharedExample from '../fixtures/personal-next-wake-v1.json'
import { personalBedSchema } from '../bedContract'

let fixture: ReturnType<typeof personalRuntimeFixture>
const currentRequest = () => {}
beforeEach(() => {
  fixture = personalRuntimeFixture()
  fixture.clock.now = Date.parse('2026-11-16T14:00:00Z')
  const insert = fixture.database.prepare(`INSERT INTO alarm_schedules
    (side,day_of_week,time,vibration_intensity,vibration_pattern,duration,alarm_temperature,wake_window,enabled)
    VALUES (?, 'monday', ?, 50, 'rise', 20, 105, 0, 1)`)
  insert.run('left', '07:00')
  insert.run('right', '09:00')
})
afterEach(() => fixture.database.close())
function read(key = fixture.ownerKey) {
  return fixture.runtime.nextWake(key, currentRequest)
}
function request(key?: string, suffix = '', method = 'GET', extraHeaders: Record<string, string> = {}) {
  return new Request(`http://pod.test/api/v1/me/alarm/next${suffix}`, { method,
    ...(!['GET', 'HEAD'].includes(method) ? { body: '{}' } : {}),
    headers: { host: 'pod.test', ...(key ? { authorization: `Bearer ${key}` } : {}), ...extraHeaders } })
}
function response(incoming: Request) {
  return householdHttp(incoming, { store: fixture.identities, personalRuntime: fixture.runtime, verifySoloConfiguration: () => true })
}

describe('private effective wake plan', () => {
  it('preserves the shared native contract and its separate routine and temperature routing', () => {
    expect(sharedExample.synthetic).toBe(true)
    const bed = personalBedSchema.parse(sharedExample.bed)
    const wake = personalNextWakeSchema.parse(sharedExample.wake)
    expect(wake.scope).toEqual(bed.scope)
    expect(wake.sourceSide).toBe(bed.routing.routines)
    expect(bed.routing.scheduledVibration).toEqual([wake.sourceSide])
    expect(bed.routing.temperature).toEqual(['left', 'right'])
    expect(wake.plan.canChange).toBe(false)
    expect(wake.plan.warming?.targetF).toBe(105)
    expect(wake.plan.alarm?.duration).toBe(20)
  })
  it('reads only the solo vibration source and preserves all stored state', () => {
    const before = fixture.database.prepare('SELECT total_changes() AS total').get()
    const result = personalNextWakeSchema.parse(read())
    expect(result).toMatchObject({ version: 1, sourceSide: 'left', effect: 'read_only', observedAt: fixture.clock.now,
      scope: { sleeperId: fixture.owner.selfSleeperId }, plan: { state: 'scheduled', side: 'left', canChange: false,
        alarm: { at: '2026-11-16T15:00:00.000Z', time: '07:00', duration: 20 },
        warming: { startsAt: '2026-11-16T14:30:00.000Z', targetF: 105 } } })
    expect(JSON.stringify(result)).not.toContain('09:00')
    expect(fixture.database.prepare('SELECT total_changes() AS total').get()).toEqual(before)
    expect(fixture.execute).not.toHaveBeenCalled()
    expect(fixture.observe).not.toHaveBeenCalled()
  })
  it('derives each assigned person’s side independently', () => {
    fixture.assignedFixture()
    expect(read()).toMatchObject({ sourceSide: 'right', scope: { sleeperId: fixture.owner.selfSleeperId }, plan: { alarm: { time: '09:00' } } })
    expect(read(fixture.memberKey)).toMatchObject({ sourceSide: 'left', scope: { sleeperId: fixture.member.selfSleeperId }, plan: { alarm: { time: '07:00' } } })
  })
  it('never reads an unassigned partner’s alarm from the owner’s side', () => {
    expect(() => read(fixture.memberKey)).toThrow('assignment is unavailable')
  })
  it.each(['skip', 'time'] as const)('uses the effective %s override rather than a weekly draft', (action) => {
    const alarms = createAlarmStore(fixture.database)
    const original = alarms.page('left', fixture.clock.now)
    const changed = alarms.write({ side: 'left', action, expectedRevision: original.revision,
      expectedAt: original.alarm?.at, ...(action === 'time' ? { time: '08:00' } : {}) }, fixture.clock.now)
    expect(read().plan).toEqual({ ...changed, canChange: false })
    if (action === 'skip') expect(read().plan.warming).toBeNull()
    else expect(read().plan.warming?.startsAt).toBe('2026-11-16T15:30:00.000Z')
  })
  it.each(['away', 'none'] as const)('reports %s without inventing an active wake plan', (state) => {
    if (state === 'away') fixture.database.exec('UPDATE side_settings SET away_mode=1 WHERE side=\'left\'')
    else fixture.database.exec('UPDATE alarm_schedules SET enabled=0 WHERE side=\'left\'')
    expect(read().plan).toMatchObject({ state, canChange: false, warming: null })
  })
  it.each(['disabled', 'configuration', 'revoked', 'held', 'missing_admission'] as const)('withholds the wake plan for %s state', (state) => {
    if (state === 'disabled') fixture.clock.enabled = false
    if (state === 'configuration') fixture.database.exec('UPDATE device_settings SET bed_mode=\'two\'')
    if (state === 'revoked') fixture.database.prepare('UPDATE household_devices SET revoked_at=? WHERE id=?')
      .run(fixture.clock.now, fixture.identities.deviceIdentity(fixture.ownerKey))
    if (state === 'held') new HardwareAdmissionStore(fixture.database, () => fixture.clock.now).hold(randomUUID())
    if (state === 'missing_admission') fixture.database.exec('DELETE FROM hardware_admission')
    expect(() => read()).toThrow()
    expect(fixture.execute).not.toHaveBeenCalled()
  })
  it('rechecks the selected browser identity before returning private data', () => {
    let reads = 0
    expect(() => fixture.runtime.nextWake(fixture.ownerKey, () => {
      reads += 1
      if (reads === 2) throw new Error('Browser signed out')
    })).toThrow('Browser signed out')
  })
  it('requires personal authentication and private caching headers', async () => {
    for (const key of [undefined, randomBytes(32).toString('base64url')]) {
      expect((await response(request(key))).status).toBe(401)
    }
    const accepted = await response(request(fixture.ownerKey))
    expect(accepted.status).toBe(200)
    expect(accepted.headers.get('cache-control')).toBe('private, no-store')
    expect(accepted.headers.get('vary')).toBe('Authorization, Cookie')
    expect(personalNextWakeSchema.parse(await accepted.json()).sourceSide).toBe('left')
  })
  it('rejects a client-selected side, a changed sleeper and a foreign browser origin', async () => {
    expect((await response(request(fixture.ownerKey, '?side=right'))).status).toBe(400)
    expect((await response(request(fixture.ownerKey, '', 'GET', { 'x-sleepypod-sleeper-id': fixture.member.selfSleeperId }))).status).toBe(409)
    expect((await response(request(fixture.ownerKey, '', 'GET', { origin: 'https://foreign.test' }))).status).toBe(403)
    expect(fixture.execute).not.toHaveBeenCalled()
  })
  it('does not expose alarm mutation through the personal read endpoint', async () => {
    const before = fixture.database.prepare('SELECT total_changes() AS total').get()
    expect((await response(request(fixture.ownerKey, '', 'POST', { 'content-type': 'application/json' }))).status).toBe(404)
    expect(fixture.database.prepare('SELECT total_changes() AS total').get()).toEqual(before)
    expect(fixture.execute).not.toHaveBeenCalled()
  })
})

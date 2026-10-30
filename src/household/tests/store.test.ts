import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { HouseholdStore } from '../store'
import { householdSessionSchema, personalPreferencesResponseSchema, personalRoutinesResponseSchema } from '../contract'
const secret = () => randomBytes(32).toString('base64url')
let database: Database.Database, store: HouseholdStore, now: number, ownerKey: string, memberKey: string
const context = () => ({ requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1 })
function invite(key = ownerKey, kind: 'new_person' | 'own_device' = 'new_person') {
  return store.createInvitation(key, { ...context(), invitation: secret(), kind, expiresInMinutes: 30 })
}
function addMember() {
  const invitation = invite()
  return store.join({ invitation: invitation.invitation, deviceSecret: memberKey, deviceName: 'Example member phone', displayName: 'Example member' })
}
beforeEach(() => {
  database = migratedComfortDatabase()
  database.pragma('foreign_keys = ON')
  now = Date.parse('2026-10-29T22:00:00Z')
  store = new HouseholdStore(database, () => now)
  ownerKey = secret()
  memberKey = secret()
  store.setup({ requestId: randomUUID(), displayName: 'Example owner', deviceName: 'Example owner phone', deviceSecret: ownerKey, currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
})
afterEach(() => database.close())
describe('personal household boundary', () => {
  it('keeps a joined person unassigned and gives them no live controls, Health or legacy history capability', () => {
    const owner = householdSessionSchema.parse(store.session(ownerKey))
    const member = householdSessionSchema.parse(addMember())
    expect(owner.self.zones).toEqual(['left', 'right'])
    expect(member.self).toEqual({ displayName: 'Example member', zones: [], assignment: 'unassigned' })
    expect(member.capabilities).toMatchObject({ personalControls: false, personalHistory: false, healthImport: false, activateArrangement: false })
    expect(member.selfSleeperId).not.toBe(owner.selfSleeperId)
    expect(store.session(ownerKey).arrangement.mode).toBe('solo-anywhere')
    expect(database.prepare('SELECT COUNT(*) AS count FROM bedtime_routines').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM device_settings').get()).toEqual({ count: 0 })
  })
  it('stores digests and never retains reusable invitation/device secrets', () => {
    const invitation = invite()
    store.join({ invitation: invitation.invitation, deviceSecret: memberKey, deviceName: 'Member', displayName: 'Member' })
    const rows = ['households', 'household_accounts', 'household_devices', 'household_invitations', 'household_personal_settings', 'household_mutation_receipts'].flatMap(table => database.prepare(`SELECT * FROM ${table}`).all())
    const encoded = JSON.stringify(rows)
    for (const value of [ownerKey, memberKey, invitation.invitation])
      expect(encoded).not.toContain(value)
  })
  it('resolves private preferences from the credential and rejects caller-supplied identity', () => {
    const member = addMember(), initial = store.preferences(memberKey)
    const request = { ...context(), expectedRevision: initial.revision, preferences: { ...initial.preferences, preferredTemperatureF: 82, comfort: 'cold_sleeper' } }
    const saved = personalPreferencesResponseSchema.parse(store.updatePreferences(memberKey, request))
    expect(saved.sleeperId).toBe(member.selfSleeperId)
    expect(store.preferences(ownerKey).preferences.preferredTemperatureF).toBe(76)
    expect(() => store.updatePreferences(memberKey, { ...request, sleeperId: store.session(ownerKey).selfSleeperId })).toThrow()
    expect(() => store.updatePreferences(ownerKey, request)).toThrow('request identifier')
  })
  it('rejects stale resource, session and assignment revisions without writes', () => {
    const initial = store.preferences(ownerKey)
    const request = { ...context(), expectedRevision: initial.revision, preferences: { ...initial.preferences, preferredTemperatureF: 70 } }
    store.updatePreferences(ownerKey, request)
    expect(() => store.updatePreferences(ownerKey, { ...request, requestId: randomUUID() })).toThrow('another device')
    expect(() => store.updatePreferences(ownerKey, { ...request, requestId: randomUUID(), expectedRevision: 2, expectedAssignmentRevision: 99 })).toThrow('assignment changed')
    expect(() => store.updatePreferences(ownerKey, { ...request, requestId: randomUUID(), expectedRevision: 2, expectedSessionRevision: 99 })).toThrow('account or bed assignment')
    expect(store.preferences(ownerKey).revision).toBe(2)
  })
  it('reconciles exact lost-response mutations and refuses changed replay payloads', () => {
    const initial = store.preferences(ownerKey)
    const request = { ...context(), expectedRevision: initial.revision, preferences: initial.preferences }
    expect(store.updatePreferences(ownerKey, request)).toEqual(store.updatePreferences(ownerKey, request))
    expect(store.preferences(ownerKey).revision).toBe(2)
    expect(() => store.updatePreferences(ownerKey, { ...request, preferences: { ...initial.preferences, preferredTemperatureF: 75 } })).toThrow('request identifier')
  })
  it('never grants another person access to an existing account through an owner-issued invite', () => {
    addMember()
    expect(() => invite(memberKey)).toThrow('Only the household owner')
    const ownDevice = invite(memberKey, 'own_device'), otherDeviceKey = secret()
    const session = store.join({ invitation: ownDevice.invitation, deviceSecret: otherDeviceKey, deviceName: 'Member tablet', displayName: 'Pretend owner' })
    expect(session.accountId).toBe(store.session(memberKey).accountId)
    expect(session.self.displayName).toBe('Example member')
    expect(store.devices(ownerKey).devices).toHaveLength(1)
    expect(store.devices(memberKey).devices).toHaveLength(2)
  })
  it('denies replay by a different device, expired/revoked invitations and a third person', () => {
    const invitation = invite(), join = { invitation: invitation.invitation, deviceSecret: memberKey, deviceName: 'Member', displayName: 'Member' }
    expect(store.join(join)).toEqual(store.join(join))
    expect(() => store.join({ ...join, deviceSecret: secret() })).toThrow()
    const another = invite()
    expect(() => store.join({ ...join, invitation: another.invitation, deviceSecret: secret() })).toThrow('two personal accounts')
    store.revokeInvitation(ownerKey, { ...context(), invitationId: another.id })
    expect(() => store.join({ ...join, invitation: another.invitation })).toThrow('new personal invitation')
    const expired = invite(ownerKey, 'own_device')
    now += 31 * 60000
    expect(() => store.join({ ...join, invitation: expired.invitation, deviceSecret: secret() })).toThrow('expired')
    expect(database.prepare('SELECT COUNT(*) AS count FROM household_accounts').get()).toEqual({ count: 2 })
  })
  it('rolls back membership if the device cannot be created', () => {
    const invitation = invite()
    expect(() => store.join({ invitation: invitation.invitation, deviceSecret: ownerKey, deviceName: 'Copy', displayName: 'New person' })).toThrow('fresh personal device key')
    expect(database.prepare('SELECT COUNT(*) AS count FROM household_accounts').get()).toEqual({ count: 1 })
    expect(store.invitations(ownerKey).invitations[0].status).toBe('pending')
  })
  it('revokes only self-owned devices, including browser identity, before any later read or write', () => {
    addMember()
    const invitation = invite(memberKey, 'own_device'), tabletKey = secret()
    store.join({ invitation: invitation.invitation, deviceSecret: tabletKey, deviceName: 'Tablet', displayName: 'Member' })
    const tabletId = store.deviceIdentity(tabletKey)
    expect(() => store.revokeDevice(ownerKey, { ...context(), deviceId: tabletId })).toThrow()
    expect(() => store.revokeInvitation(ownerKey, { ...context(), invitationId: invitation.id })).toThrow('unavailable')
    store.revokeDevice(memberKey, { ...context(), deviceId: tabletId })
    expect(() => store.session(tabletKey)).toThrow('revoked')
    expect(() => store.preferences({ deviceId: tabletId })).toThrow('revoked')
    expect(() => store.updatePreferences(tabletKey, { ...context(), expectedRevision: 1, preferences: store.preferences(memberKey).preferences })).toThrow('revoked')
    expect(() => store.revokeDevice(memberKey, { ...context(), deviceId: store.deviceIdentity(memberKey) })).toThrow('last personal connection')
  })
  it('persists personal routine drafts without creating any hardware schedule or inheriting partner choices', () => {
    addMember()
    const draft = { power: { onTime: '22:00', offTime: '08:00', onTemperature: 77, enabled: true, endAction: 'turn_off' }, temperatures: [], alarm: { time: '07:30', vibrationIntensity: 40, vibrationPattern: 'rise', duration: 20, alarmTemperature: 82, wakeWindow: 0, enabled: true }, notes: '' }
    const result = personalRoutinesResponseSchema.parse(store.updateRoutines(memberKey, { ...context(), expectedRevision: 1, routines: [{ dayOfWeek: 'sunday', draft }] }))
    expect(result.status).toBe('draft_only')
    expect(store.routines(ownerKey).routines).toHaveLength(0)
    expect(database.prepare('SELECT COUNT(*) AS count FROM alarm_schedules').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM power_schedules').get()).toEqual({ count: 0 })
  })
})

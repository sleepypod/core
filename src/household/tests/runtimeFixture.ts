import { randomBytes, randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { beforeControlWrite } from '@/src/controls/context'
import type { ControlAction } from '@/src/controls/contract'
import { PodVersion } from '@/src/hardware/types'
import { HouseholdStore } from '../store'
import { PersonalRuntime, type PersonalObservation } from '../personalRuntime'
import type { PersonalControlRequest } from '../controlContract'

export function personalRuntimeFixture(filename = ':memory:') {
  const database = migratedComfortDatabase(filename)
  database.pragma('foreign_keys = ON')
  const clock = { now: Date.now(), enabled: true }
  const identities = new HouseholdStore(database, () => clock.now)
  const ownerKey = randomBytes(32).toString('base64url')
  const memberKey = randomBytes(32).toString('base64url')
  const owner = identities.setup({ requestId: randomUUID(), displayName: 'Owner', deviceName: 'Owner phone', deviceSecret: ownerKey,
    currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  const invitation = identities.createInvitation(ownerKey, { requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1,
    kind: 'new_person', invitation: randomBytes(32).toString('base64url'), expiresInMinutes: 30 })
  const member = identities.join({ invitation: invitation.invitation, displayName: 'Partner', deviceName: 'Partner phone', deviceSecret: memberKey })
  database.prepare('INSERT INTO device_settings (id, bed_mode, unused_zone_mode, timezone) VALUES (1, \'solo-left\', \'follow\', \'America/Los_Angeles\')').run()
  database.prepare('INSERT INTO side_settings (side, name) VALUES (\'left\', \'Left\'), (\'right\', \'Right\')').run()
  const observation: PersonalObservation = { observedAt: clock.now, status: {
    leftSide: { currentTemperature: 69, targetTemperature: 70, currentLevel: -49, targetLevel: -45, heatingDuration: 1200 },
    rightSide: { currentTemperature: 81, targetTemperature: 82, currentLevel: -5, targetLevel: -2, heatingDuration: 900 },
    waterLevel: 'ok', isPriming: false, podVersion: PodVersion.POD_4, sensorLabel: 'private-diagnostics', gestures: { doubleTap: { l: 2, r: 3 } },
  } }
  const observe = vi.fn<() => Promise<PersonalObservation | null>>(async () => observation)
  const requestedTarget = vi.fn<(side: 'left' | 'right') => number | null>(side => side === 'left' ? 68 : 80)
  const execute = vi.fn<(action: ControlAction) => Promise<void>>(async () => {
    beforeControlWrite()
  })
  const runtime = new PersonalRuntime({ database, identities, enabled: () => clock.enabled, observe, requestedTarget, execute, now: () => clock.now, runId: 'test-runtime' })
  const command = (credential = ownerKey): PersonalControlRequest => ({ version: 1, requestId: randomUUID(),
    scope: runtime.authority.resolve(credential).scope, issuedAt: clock.now, expiresAt: clock.now + 30_000,
    action: { kind: 'temperature', temperatureF: 70, holdMinutes: 30 } })
  // A database fixture, not a shipping activation path or a consent substitute.
  const assignedFixture = () => database.transaction(() => {
    database.prepare('UPDATE household_accounts SET assigned_side = \'right\' WHERE id = ?').run(owner.accountId)
    database.prepare('UPDATE household_accounts SET assigned_side = \'left\' WHERE id = ?').run(member.accountId)
    database.prepare('UPDATE households SET mode = \'assigned\', assignment_revision = assignment_revision + 1').run()
    database.prepare('UPDATE device_settings SET bed_mode = \'two\'').run()
  })()
  return { database, clock, identities, ownerKey, memberKey, owner, member, observation, observe, requestedTarget, execute, runtime, command, assignedFixture }
}

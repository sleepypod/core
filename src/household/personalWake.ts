import { z } from 'zod'
import type Database from 'better-sqlite3'
import { nextAlarmSchema } from '@/src/alarms/contract'
import { createAlarmStore } from '@/src/alarms/store'
import { HardwareAdmissionStore } from '@/src/hardware/admissionStore'
import { personalControlScopeSchema } from './controlContract'
import { householdSideSchema } from './contract'
import type { PersonalRuntimeAuthority } from './runtimeAuthority'
import { HouseholdError, type HouseholdCredential } from './store'

export const personalNextWakeSchema = z.object({
  version: z.literal(1), scope: personalControlScopeSchema, sourceSide: householdSideSchema,
  observedAt: z.number().int().positive().max(8_640_000_000_000_000),
  plan: nextAlarmSchema.extend({ canChange: z.literal(false) }),
  effect: z.literal('read_only'),
}).strict()

/** Read the effective occurrence for the authenticated sleeper, never a client-selected side or private draft. */
export function readPersonalNextWake(database: Database.Database, authority: PersonalRuntimeAuthority,
  credential: HouseholdCredential, assertRequestCurrent: () => void, now: number) {
  return database.transaction(() => {
    assertRequestCurrent()
    const resolved = authority.resolve(credential)
    if (resolved.availability !== 'ready' || !resolved.routineSide)
      throw new HouseholdError('not_ready', 409, 'Your current bed assignment is unavailable. Refresh your personal account.')
    if (new HardwareAdmissionStore(database).read().holdId !== null)
      throw new HouseholdError('not_ready', 409, 'Bed routines are paused for maintenance. Finish recovery before relying on a wake plan.')
    const plan = createAlarmStore(database).page(resolved.routineSide, now)
    assertRequestCurrent()
    const current = authority.resolve(credential)
    if (current.availability !== 'ready' || JSON.stringify(current.scope) !== JSON.stringify(resolved.scope))
      throw new HouseholdError('conflict', 409, 'Your account or bed assignment changed. Refresh your personal account.')
    return personalNextWakeSchema.parse({ version: 1, scope: resolved.scope, sourceSide: resolved.routineSide,
      observedAt: now, plan: { ...plan, canChange: false }, effect: 'read_only' })
  })()
}

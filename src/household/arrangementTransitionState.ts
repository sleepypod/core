import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/src/db/schema'
import { routineDaySchema } from '@/src/lib/bedtimeRoutines'
import { readBedtimeRoutineState, replaceBedtimeRoutineBatch } from '@/src/server/bedtimeRoutineTransaction'
import { createComfortLimitStore } from '@/src/temperature/limitStore'
import { defaultComfortLimit } from '@/src/temperature/limits'
import { defaultComfortState } from '@/src/comfort/policy'
import { comfortStateSchema } from '@/src/comfort/contract'
import type { ApprovedArrangementSnapshot } from './arrangementReviews'
import { HouseholdError } from './store'

export const arrangementDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reject = () => new HouseholdError('not_ready', 409, 'The saved arrangement settings need review before changing sides.')

/** Archive only replaced control state. Credentials and bulk sleep/Health records are never copied here. */
export function readArrangementArchive(database: Database.Database) {
  const store = drizzle(database, { schema })
  const tables = ['side_settings', 'temperature_holds', 'temporary_cooling', 'temperature_limits', 'comfort_states',
    'alarm_overrides', 'base_schedules'] as const
  const rows = Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 1001`).all()]))
  if (Object.values(rows).some(values => values.length > 1000)) throw reject()
  const archive = { ...rows,
    routineWeeks: (['left', 'right'] as const).map(side => ({ side, records: readBedtimeRoutineState(store, side).records })),
    stageModels: database.prepare('SELECT side, active, version, model_hash FROM side_stage_models ORDER BY side').all(),
    profileBindings: database.prepare('SELECT * FROM biometric_profile_bindings ORDER BY side').all(),
    device: database.prepare('SELECT id, bed_mode, unused_zone_mode, autopilot_enabled FROM device_settings ORDER BY id').all(),
    activeRuns: database.prepare('SELECT * FROM run_once_sessions WHERE status = \'active\' ORDER BY id LIMIT 1001').all(),
    activations: database.prepare('SELECT * FROM comfort_activations WHERE revoked_at IS NULL ORDER BY id LIMIT 1001').all(),
  }
  if (archive.device.length !== 1 || archive.activeRuns.length > 1000 || archive.activations.length > 1000
    || Buffer.byteLength(JSON.stringify(archive)) > 4 * 1024 * 1024) throw reject()
  return archive
}

/** Include stable control policy in the held receipt; routine/preference changes are checked by the review itself. */
export function arrangementPolicyDigest(database: Database.Database) {
  const limits = createComfortLimitStore(database)
  const states = database.prepare('SELECT side, state FROM comfort_states ORDER BY side').all() as { side: string, state: string }[]
  return arrangementDigest({
    limits: { left: limits.read('left'), right: limits.read('right') },
    comfort: states.map(row => ({ side: row.side, config: comfortStateSchema.parse(JSON.parse(row.state)).config })),
    device: database.prepare('SELECT id, autopilot_enabled FROM device_settings ORDER BY id').all(),
    profiles: database.prepare('SELECT * FROM biometric_profile_bindings ORDER BY side').all(),
    base: database.prepare('SELECT * FROM base_schedules ORDER BY id').all(),
  })
}

/** Replace complete weeks under the caller's transaction, retaining normal routine CAS and validation. */
export function commitArrangementWeeks(database: Database.Database, plan: ApprovedArrangementSnapshot) {
  const store = drizzle(database, { schema })
  return replaceBedtimeRoutineBatch(database, plan.participants.map((person) => {
    const current = readBedtimeRoutineState(store, person.side)
    return { side: person.side, changes: routineDaySchema.options.map(dayOfWeek => ({
      dayOfWeek, expectedRevision: current.records.find(record => record.snapshot.dayOfWeek === dayOfWeek)?.snapshot.revision ?? null,
      replacement: person.week.find(entry => entry.dayOfWeek === dayOfWeek)?.draft ?? null,
    })) }
  }))
}

/** Old per-zone learning is retained for later private review, but cannot control the new sleeper. */
export function resetArrangementControls(database: Database.Database, plan: ApprovedArrangementSnapshot, now: number) {
  const limits = createComfortLimitStore(database)
  const previous = { left: limits.read('left'), right: limits.read('right') }
  for (const person of plan.participants) {
    limits.save(person.side, previous[person.side].revision, person.role === 'owner' ? previous[plan.sourceSide].config : defaultComfortLimit)
    database.prepare('INSERT INTO comfort_states (side, state) VALUES (?, ?) ON CONFLICT(side) DO UPDATE SET state = excluded.state')
      .run(person.side, JSON.stringify(defaultComfortState()))
    database.prepare('UPDATE side_settings SET name = ?, away_mode = 0, away_start = NULL, away_return = NULL, always_on = 0, auto_on_enabled = 0, auto_off_enabled = 0, stage_classifier = NULL WHERE side = ?')
      .run(person.displayName, person.side)
    database.prepare('INSERT INTO alarm_overrides (side, revision, record) VALUES (?, ?, NULL) ON CONFLICT(side) DO UPDATE SET revision = excluded.revision, record = NULL')
      .run(person.side, randomUUID())
  }
  database.prepare('DELETE FROM temperature_holds').run()
  database.prepare('DELETE FROM temporary_cooling').run()
  database.prepare('UPDATE run_once_sessions SET status = \'cancelled\' WHERE status = \'active\'').run()
  database.prepare('UPDATE comfort_activations SET revoked_at = ?, reason = \'household_arrangement_changed\' WHERE revoked_at IS NULL').run(now)
  database.prepare('UPDATE side_stage_models SET active = 0').run()
  database.prepare('UPDATE base_schedules SET enabled = 0').run()
  database.prepare('UPDATE device_settings SET bed_mode = \'two\', unused_zone_mode = \'off\', autopilot_enabled = 0').run()
}

/** Stable committed fingerprint for a later recovery coordinator; no timestamps from live sensor polling. */
export function committedArrangementDigest(database: Database.Database, householdId: string) {
  const store = drizzle(database, { schema })
  return arrangementDigest({
    household: database.prepare('SELECT * FROM households WHERE id = ?').get(householdId),
    accounts: database.prepare('SELECT id, sleeper_id, assigned_side, session_revision, state FROM household_accounts WHERE household_id = ? ORDER BY id').all(householdId),
    weeks: ['left', 'right'].map(side => readBedtimeRoutineState(store, side as 'left' | 'right').records),
    policy: arrangementPolicyDigest(database), controlState: readArrangementArchive(database),
    personalSettings: database.prepare('SELECT settings.* FROM household_personal_settings settings JOIN household_accounts account ON account.id = settings.account_id WHERE account.household_id = ? ORDER BY settings.account_id').all(householdId),
    epochs: database.prepare('SELECT * FROM household_attribution_epochs WHERE household_id = ? ORDER BY starts_at, id').all(householdId),
  })
}

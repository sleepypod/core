import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { db } from '@/src/db'
import * as schema from '@/src/db/schema'
import { bedtimeRoutines, temperatureSchedules, powerSchedules, alarmSchedules } from '@/src/db/schema'
import { compileBedtimeRoutine, normalizeBedtimeDraft, validateBedtimeWeek, routineChangesSchema, type RoutineSide, type RoutineSnapshot } from '@/src/lib/bedtimeRoutines'

export type RoutineStore = Pick<typeof db, 'select' | 'insert' | 'delete'>
export const routineRowIdsSchema = z.object({ temperature: z.array(z.number().int().positive()), power: z.array(z.number().int().positive()).length(1), alarm: z.array(z.number().int().positive()).max(1) }).strict()
export const routineTables = { temperature: temperatureSchedules, power: powerSchedules, alarm: alarmSchedules }
type Kind = keyof typeof routineTables
const tables = routineTables
const rowIdsSchema = routineRowIdsSchema

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)
}

/** Verify ownership and compiled rows before exposing or replacing a persisted routine. */
export function readBedtimeRoutineState(store: RoutineStore, side: RoutineSide) {
  const metadata = store.select().from(bedtimeRoutines).where(eq(bedtimeRoutines.side, side)).all()
  const existing = {
    temperature: store.select().from(temperatureSchedules).where(eq(temperatureSchedules.side, side)).all(),
    power: store.select().from(powerSchedules).where(eq(powerSchedules.side, side)).all(),
    alarm: store.select().from(alarmSchedules).where(eq(alarmSchedules.side, side)).all(),
  }
  const claimed = { temperature: new Set<number>(), power: new Set<number>(), alarm: new Set<number>() }
  const records = metadata.map((entry) => {
    const draft = normalizeBedtimeDraft(JSON.parse(entry.configuration))
    const ids = rowIdsSchema.parse(JSON.parse(entry.scheduleIds))
    const expected = compileBedtimeRoutine(side, { dayOfWeek: entry.dayOfWeek, draft })
    const actual: Record<Kind, unknown[]> = { temperature: [], power: [], alarm: [] }
    for (const kind of Object.keys(tables) as Kind[]) {
      if (ids[kind].length !== expected[kind].length) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Routine ownership is incomplete. Restore or review the imported candidate.' })
      for (const [index, id] of ids[kind].entries()) {
        const row = existing[kind].find(candidate => candidate.id === id)
        const wanted = expected[kind][index]
        const values = row && Object.fromEntries(Object.keys(wanted).map(key => [key, (row as unknown as Record<string, unknown>)[key]]))
        if (!row || claimed[kind].has(id) || canonical(values) !== canonical(wanted)) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Routine rows changed outside the bedtime editor. Review the controller data before saving.' })
        }
        claimed[kind].add(id)
        actual[kind].push(row)
      }
    }
    const revision = createHash('sha256').update(canonical({ entry, actual })).digest('hex')
    return { ids, snapshot: { dayOfWeek: entry.dayOfWeek, draft, revision } satisfies RoutineSnapshot }
  })
  const hasCalendarRows = (Object.keys(tables) as Kind[]).some(kind => existing[kind].some(row => !claimed[kind].has(row.id)))
  if (metadata.length && hasCalendarRows) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Calendar schedules and bedtime routines are mixed on this side. Review the migration before editing.' })
  return { records, canCreate: !hasCalendarRows }
}

export function emptyRoutineDelta() {
  return {
    removed: { temperature: [] as number[], power: [] as number[], alarm: [] as number[] },
    created: {
      temperature: [] as (typeof temperatureSchedules.$inferSelect)[],
      power: [] as (typeof powerSchedules.$inferSelect)[],
      alarm: [] as (typeof alarmSchedules.$inferSelect)[],
    },
  }
}
export type RoutineDelta = ReturnType<typeof emptyRoutineDelta>

/** The caller owns the transaction; preserve all existing CAS and snooze checks. */
function applyRoutineChanges(transaction: RoutineStore, parsed: z.infer<typeof routineChangesSchema>, delta: RoutineDelta) {
  const { removed, created } = delta
  const current = readBedtimeRoutineState(transaction, parsed.side)
  if (!current.canCreate) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Existing calendar schedules must be migrated before creating bedtime routines.' })
  for (const change of parsed.changes) {
    const found = current.records.find(record => record.snapshot.dayOfWeek === change.dayOfWeek)
    if ((found?.snapshot.revision ?? null) !== change.expectedRevision) {
      throw new TRPCError({ code: 'CONFLICT', message: `The ${change.dayOfWeek} routine changed. Reload the routines before saving your draft.` })
    }
  }
  const changedDays = new Set(parsed.changes.map(change => change.dayOfWeek))
  // Older clients omit these fields. Never let an edit or move erase custom
  // snooze settings they cannot represent; default-only legacy writes still work.
  const hasCustomSnooze = current.records.some(({ snapshot }) => changedDays.has(snapshot.dayOfWeek)
    && snapshot.draft.alarm && ((snapshot.draft.alarm.snoozeDuration ?? 300) !== 300 || (snapshot.draft.alarm.snoozeTaper ?? 0) !== 0))
  const omitsSnooze = parsed.changes.some(({ replacement }) => replacement?.alarm
    && (replacement.alarm.snoozeDuration === undefined || replacement.alarm.snoozeTaper === undefined))
  if (hasCustomSnooze && omitsSnooze) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This routine has custom snooze settings. Update the client to preserve both snooze fields before editing or moving it.' })
  const prospective = [
    ...current.records.filter(record => !changedDays.has(record.snapshot.dayOfWeek)).map(record => record.snapshot),
    ...parsed.changes.flatMap(change => change.replacement ? [{ dayOfWeek: change.dayOfWeek, draft: change.replacement }] : []),
  ]
  try {
    validateBedtimeWeek(parsed.side, prospective)
  }
  catch (error) { throw new TRPCError({ code: 'BAD_REQUEST', message: error instanceof Error ? error.message : 'Invalid bedtime week' }) }
  for (const change of parsed.changes) {
    const old = current.records.find(record => record.snapshot.dayOfWeek === change.dayOfWeek)
    if (old) {
      for (const kind of Object.keys(tables) as Kind[]) {
        if (old.ids[kind].length) transaction.delete(tables[kind]).where(inArray(tables[kind].id, old.ids[kind])).run()
        removed[kind].push(...old.ids[kind])
      }
      transaction.delete(bedtimeRoutines).where(and(eq(bedtimeRoutines.side, parsed.side), eq(bedtimeRoutines.dayOfWeek, change.dayOfWeek))).run()
    }
    if (!change.replacement) continue
    const draft = normalizeBedtimeDraft(change.replacement)
    const rows = compileBedtimeRoutine(parsed.side, { dayOfWeek: change.dayOfWeek, draft })
    const temperature = rows.temperature.map(row => transaction.insert(temperatureSchedules).values(row).returning().get())
    const power = rows.power.map(row => transaction.insert(powerSchedules).values(row).returning().get())
    const alarm = rows.alarm.map(row => transaction.insert(alarmSchedules).values(row).returning().get())
    transaction.insert(bedtimeRoutines).values({
      side: parsed.side, dayOfWeek: change.dayOfWeek,
      configuration: JSON.stringify(draft),
      scheduleIds: JSON.stringify({ temperature: temperature.map(row => row.id), power: power.map(row => row.id), alarm: alarm.map(row => row.id) }),
    }).run()
    created.temperature.push(...temperature)
    created.power.push(...power)
    created.alarm.push(...alarm)
  }
  return { version: 1 as const, side: parsed.side, canCreate: true, routines: readBedtimeRoutineState(transaction, parsed.side).records.map(record => record.snapshot) }
}

/** One commit (or nested savepoint) covers both sides; no scheduler or hardware calls. */
export function replaceBedtimeRoutineBatch(database: Database.Database, input: unknown) {
  const parsed = z.array(routineChangesSchema).min(1).max(2).superRefine((changes, context) => {
    if (new Set(changes.map(change => change.side)).size !== changes.length)
      context.addIssue({ code: 'custom', message: 'Each physical side may appear only once.' })
  }).parse(input)
  const store = drizzle(database, { schema })
  return database.transaction(() => {
    const delta = emptyRoutineDelta()
    const snapshots = parsed.map(change => applyRoutineChanges(store, change, delta))
    return { snapshots, ...delta }
  }).immediate()
}

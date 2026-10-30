import type { z } from 'zod'
import { eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { db, sqlite } from '@/src/db'
import { bedtimeRoutines, temperatureSchedules, powerSchedules, alarmSchedules } from '@/src/db/schema'
import { routineChangesSchema, type RoutineSide } from '@/src/lib/bedtimeRoutines'
import { readBedtimeRoutineState, replaceBedtimeRoutineBatch, routineRowIdsSchema as rowIdsSchema, routineTables as tables, type RoutineStore as Store, type RoutineDelta } from './bedtimeRoutineTransaction'

type Kind = keyof typeof tables

export function getBedtimeRoutines(side: RoutineSide) {
  return db.transaction((transaction) => {
    const state = readBedtimeRoutineState(transaction, side)
    return { version: 1 as const, side, canCreate: state.canCreate, routines: state.records.map(record => record.snapshot) }
  })
}

/** Compare every original revision before any write; one conflict rolls back the entire save. */
export async function replaceBedtimeRoutines(input: z.infer<typeof routineChangesSchema>) {
  const parsed = routineChangesSchema.parse(input)
  const delta = replaceBedtimeRoutineBatch(sqlite, [parsed])
  const schedulerApplied = await applyRoutineSchedulerDelta(delta)
  return { ...delta.snapshots[0], schedulerApplied }
}

/** Refresh committed rows; a later change cannot revive a removed schedule. */
export async function applyRoutineSchedulerDelta({ removed, created }: RoutineDelta): Promise<boolean> {
  // Scheduling is acknowledged separately from persistence; no physical action is inferred.
  let schedulerApplied = false
  try {
    const { getJobManager } = await import('@/src/scheduler')
    const manager = await getJobManager()
    for (const id of removed.temperature) manager.cancelTemperatureJob(id)
    for (const id of removed.power) manager.cancelPowerJob(id)
    for (const id of removed.alarm) manager.cancelAlarmJob(id)
    // A newer save may have replaced these rows while scheduler initialization was awaited.
    for (const row of created.temperature) {
      if (db.select().from(temperatureSchedules).where(eq(temperatureSchedules.id, row.id)).get()) manager.upsertTemperatureJob(row)
    }
    for (const row of created.power) {
      if (db.select().from(powerSchedules).where(eq(powerSchedules.id, row.id)).get()) manager.upsertPowerJob(row)
    }
    for (const row of created.alarm) {
      if (db.select().from(alarmSchedules).where(eq(alarmSchedules.id, row.id)).get()) manager.upsertAlarmJob(row)
    }
    schedulerApplied = true
  }
  catch (error) { console.error('Bedtime routine scheduler update failed:', error) }
  return schedulerApplied
}

/** Old calendar writers may not sever a bedtime routine's ownership or create a competing side. */
export function assertCalendarScheduleWrite(store: Store, input: unknown, path: string): void {
  const managed = store.select().from(bedtimeRoutines).all()
  if (!managed.length) return
  const sides = new Set(managed.map(row => row.side))
  const ids = { temperature: new Set<number>(), power: new Set<number>(), alarm: new Set<number>() }
  for (const entry of managed) {
    const owned = rowIdsSchema.parse(JSON.parse(entry.scheduleIds))
    for (const kind of Object.keys(tables) as Kind[]) for (const id of owned[kind]) ids[kind].add(id)
  }
  const value = input as { id?: number, side?: RoutineSide, creates?: Record<Kind, Array<{ side: RoutineSide }>>, updates?: Record<Kind, Array<{ id: number }>>, deletes?: Record<Kind, number[]>, notes?: Array<{ side: RoutineSide }> }
  let conflict = (value.side !== undefined && sides.has(value.side)) || (value.notes ?? []).some(note => sides.has(note.side))
  for (const kind of Object.keys(tables) as Kind[]) {
    conflict ||= (path.toLowerCase().includes(kind) && value.id !== undefined && ids[kind].has(value.id))
      || (value.creates?.[kind] ?? []).some(row => sides.has(row.side))
      || (value.updates?.[kind] ?? []).some(row => ids[kind].has(row.id))
      || (value.deletes?.[kind] ?? []).some(id => ids[kind].has(id))
  }
  if (conflict) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Use the bedtime routine editor to change this schedule. Calendar edits cannot replace part of a night.' })
}

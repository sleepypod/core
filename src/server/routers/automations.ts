/**
 * Autopilot automations router — CRUD for user-built WHEN/IF/THEN rules, the
 * audit-log/status reads that power the transparency wedge, the global
 * kill-switch, and a backtest endpoint that replays a rule against recorded
 * history. Parallels `schedules.ts`.
 *
 * Writes persist the engine AST (validated by the zod schemas in
 * validation-schemas.ts) and then ask the running AutomationEngine to reload so
 * changes take effect without a restart — mirroring how schedules.ts nudges the
 * JobManager. Engine errors are logged, never thrown out of the handler: the row
 * is already committed and the engine's own reload-on-boot recovers any drift.
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb, db } from '@/src/db'
import { automationRuns, automations, deviceSettings } from '@/src/db/schema'
import { bedTemp, movement, sleepRecords, vitals, waterLevelReadings } from '@/src/db/biometrics-schema'
import { centiDegreesToF, centiPercentToPercent } from '@/src/lib/tempUtils'
import {
  automationActionSchema,
  automationConditionSchema,
  automationCreateSchema,
  automationTriggerSchema,
  automationUpdateSchema,
  idSchema,
  sideSchema,
} from '@/src/server/validation-schemas'
import { getAutomationEngineIfRunning } from '@/src/automation'
import { runBacktest, type BacktestRule, type Sample } from '@/src/automation/backtest'
import type { Action, Condition, Trigger } from '@/src/automation/types'

/** Reload the running engine so a CRUD change takes effect immediately. */
async function reloadEngine(): Promise<void> {
  try {
    await getAutomationEngineIfRunning()?.reload()
  }
  catch (e) {
    console.error('[automations] engine reload failed:', e)
  }
}

const automationOutput = z.object({
  id: z.number(),
  name: z.string(),
  enabled: z.boolean(),
  side: sideSchema.nullable(),
  priority: z.number(),
  dryRun: z.boolean(),
  cooldownMin: z.number().nullable(),
  trigger: automationTriggerSchema,
  conditions: automationConditionSchema,
  actions: z.array(automationActionSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
})

type AutomationRow = typeof automations.$inferSelect

function toOutput(row: AutomationRow) {
  return {
    ...row,
    trigger: row.trigger as Trigger,
    conditions: row.conditions as Condition,
    actions: row.actions as Action[],
  }
}

export const automationsRouter = router({
  /** List all automations, highest priority first. */
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations', protect: false, tags: ['Autopilot'] } })
    .input(z.object({}).strict())
    .output(z.array(automationOutput))
    .query(() => {
      try {
        return db.select().from(automations).orderBy(desc(automations.priority), automations.id).all().map(toOutput)
      }
      catch (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Failed to list automations: ${msg(error)}`, cause: error })
      }
    }),

  /** Fetch one automation by id. */
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/get', protect: false, tags: ['Autopilot'] } })
    .input(z.object({ id: idSchema }).strict())
    .output(automationOutput)
    .query(({ input }) => {
      const [row] = db.select().from(automations).where(eq(automations.id, input.id)).all()
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: `Automation ${input.id} not found` })
      return toOutput(row)
    }),

  /** Create an automation. */
  create: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/automations', protect: false, tags: ['Autopilot'] } })
    .input(automationCreateSchema)
    .output(automationOutput)
    .mutation(async ({ input }) => {
      try {
        const [row] = db.insert(automations).values(input).returning().all()
        if (!row) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Create returned no row' })
        await reloadEngine()
        return toOutput(row)
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Failed to create automation: ${msg(error)}`, cause: error })
      }
    }),

  /** Update an automation (partial). */
  update: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/automations', protect: false, tags: ['Autopilot'] } })
    .input(automationUpdateSchema)
    .output(automationOutput)
    .mutation(async ({ input }) => {
      try {
        const { id, ...updates } = input
        const [row] = db.update(automations).set({ ...updates, updatedAt: new Date() }).where(eq(automations.id, id)).returning().all()
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: `Automation ${id} not found` })
        await reloadEngine()
        return toOutput(row)
      }
      catch (error) {
        if (error instanceof TRPCError) throw error
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Failed to update automation: ${msg(error)}`, cause: error })
      }
    }),

  /** Toggle enabled. */
  setEnabled: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/automations/enable', protect: false, tags: ['Autopilot'] } })
    .input(z.object({ id: idSchema, enabled: z.boolean() }).strict())
    .output(automationOutput)
    .mutation(async ({ input }) => {
      const [row] = db.update(automations).set({ enabled: input.enabled, updatedAt: new Date() }).where(eq(automations.id, input.id)).returning().all()
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: `Automation ${input.id} not found` })
      await reloadEngine()
      return toOutput(row)
    }),

  /** Toggle dry-run vs active for an enabled rule. */
  setDryRun: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/automations/dry-run', protect: false, tags: ['Autopilot'] } })
    .input(z.object({ id: idSchema, dryRun: z.boolean() }).strict())
    .output(automationOutput)
    .mutation(async ({ input }) => {
      const [row] = db.update(automations).set({ dryRun: input.dryRun, updatedAt: new Date() }).where(eq(automations.id, input.id)).returning().all()
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: `Automation ${input.id} not found` })
      await reloadEngine()
      return toOutput(row)
    }),

  /** Delete an automation (its runs cascade). */
  delete: publicProcedure
    .meta({ openapi: { method: 'DELETE', path: '/automations', protect: false, tags: ['Autopilot'] } })
    .input(z.object({ id: idSchema }).strict())
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      const [deleted] = db.delete(automations).where(eq(automations.id, input.id)).returning().all()
      if (!deleted) throw new TRPCError({ code: 'NOT_FOUND', message: `Automation ${input.id} not found` })
      await reloadEngine()
      return { success: true }
    }),

  /** Global kill-switch state. */
  getKillSwitch: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/kill-switch', protect: false, tags: ['Autopilot'] } })
    .input(z.object({}).strict())
    .output(z.object({ enabled: z.boolean() }))
    .query(() => {
      const [settings] = db.select({ on: deviceSettings.autopilotEnabled }).from(deviceSettings).limit(1).all()
      return { enabled: settings?.on ?? true }
    }),

  /** Flip the global kill-switch (persisted + applied to the running engine). */
  setKillSwitch: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/automations/kill-switch', protect: false, tags: ['Autopilot'] } })
    .input(z.object({ enabled: z.boolean() }).strict())
    .output(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      db.insert(deviceSettings)
        .values({ id: 1, autopilotEnabled: input.enabled })
        .onConflictDoUpdate({ target: deviceSettings.id, set: { autopilotEnabled: input.enabled, updatedAt: new Date() } })
        .run()
      getAutomationEngineIfRunning()?.setGlobalEnabled(input.enabled)
      return { enabled: input.enabled }
    }),

  /** Recent run-log rows (audit trail), newest first, joined to the rule name. */
  runs: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/runs', protect: false, tags: ['Autopilot'] } })
    .input(z.object({ automationId: idSchema.optional(), limit: z.number().int().min(1).max(500).default(100) }).strict())
    .output(z.array(z.object({
      id: z.number(),
      automationId: z.number(),
      ruleName: z.string().nullable(),
      firedAt: z.date(),
      outcome: z.enum(['fired', 'skipped', 'clamped', 'dry_run', 'error']),
      detail: z.unknown(),
    })))
    .query(({ input }) => {
      const where = input.automationId != null ? eq(automationRuns.automationId, input.automationId) : undefined
      const rows = db
        .select({
          id: automationRuns.id,
          automationId: automationRuns.automationId,
          ruleName: automations.name,
          firedAt: automationRuns.firedAt,
          outcome: automationRuns.outcome,
          detail: automationRuns.detail,
        })
        .from(automationRuns)
        .leftJoin(automations, eq(automationRuns.automationId, automations.id))
        .where(where)
        .orderBy(desc(automationRuns.firedAt))
        .limit(input.limit)
        .all()
      return rows
    }),

  /** Live status: each rule + its last outcome + fires-today, plus kill-switch. */
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/status', protect: false, tags: ['Autopilot'] } })
    .input(z.object({}).strict())
    .output(z.object({
      globalEnabled: z.boolean(),
      rules: z.array(z.object({
        id: z.number(),
        name: z.string(),
        enabled: z.boolean(),
        dryRun: z.boolean(),
        side: sideSchema.nullable(),
        cooldownMin: z.number().nullable(),
        lastOutcome: z.string().nullable(),
        lastFiredAt: z.date().nullable(),
        firesToday: z.number(),
      })),
    }))
    .query(() => {
      const [settings] = db.select({ on: deviceSettings.autopilotEnabled }).from(deviceSettings).limit(1).all()
      const rows = db.select().from(automations).orderBy(desc(automations.priority), automations.id).all()
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      const rules = rows.map((r) => {
        const [last] = db
          .select({ outcome: automationRuns.outcome, firedAt: automationRuns.firedAt })
          .from(automationRuns)
          .where(and(eq(automationRuns.automationId, r.id), eq(automationRuns.outcome, 'fired')))
          .orderBy(desc(automationRuns.firedAt))
          .limit(1)
          .all()
        const today = db
          .select({ firedAt: automationRuns.firedAt })
          .from(automationRuns)
          .where(and(
            eq(automationRuns.automationId, r.id),
            eq(automationRuns.outcome, 'fired'),
            gte(automationRuns.firedAt, startOfDay),
          ))
          .all()
        return {
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          dryRun: r.dryRun,
          side: r.side,
          cooldownMin: r.cooldownMin,
          lastOutcome: last?.outcome ?? null,
          lastFiredAt: last?.firedAt ?? null,
          firesToday: today.length,
        }
      })
      return { globalEnabled: settings?.on ?? true, rules }
    }),

  /** Available past nights to backtest against, derived from sleep records. */
  nights: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/nights', protect: false, tags: ['Autopilot'] } })
    .input(z.object({ side: sideSchema, limit: z.number().int().min(1).max(30).default(7) }).strict())
    .output(z.array(z.object({
      sleepRecordId: z.number(),
      label: z.string(),
      date: z.string(),
      startMs: z.number(),
      endMs: z.number(),
    })))
    .query(({ input }) => {
      const rows = biometricsDb
        .select({ id: sleepRecords.id, enteredBedAt: sleepRecords.enteredBedAt, leftBedAt: sleepRecords.leftBedAt })
        .from(sleepRecords)
        .where(eq(sleepRecords.side, input.side))
        .orderBy(desc(sleepRecords.enteredBedAt))
        .limit(input.limit)
        .all()
      return rows.map((r, i) => ({
        sleepRecordId: r.id,
        label: i === 0 ? 'Last night' : weekday(r.enteredBedAt),
        date: monthDay(r.enteredBedAt),
        startMs: r.enteredBedAt.getTime(),
        endMs: r.leftBedAt.getTime(),
      }))
    }),

  /**
   * Replay a rule against recorded history for a chosen night. Accepts the rule
   * inline (so the editor can backtest unsaved edits) and returns the series the
   * backtest chart renders.
   */
  backtest: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/automations/backtest', protect: false, tags: ['Autopilot'] } })
    .input(z.object({
      side: sideSchema,
      sleepRecordId: idSchema.optional(),
      stepMin: z.number().int().min(1).max(30).default(2),
      rule: z.object({
        side: sideSchema.nullable().default(null),
        cooldownMin: z.number().int().min(0).max(1440).nullable().default(null),
        trigger: automationTriggerSchema,
        conditions: automationConditionSchema,
        actions: z.array(automationActionSchema).min(1),
      }),
    }).strict())
    .output(z.object({
      ok: z.boolean(),
      message: z.string().optional(),
      night: z.object({ label: z.string(), date: z.string() }).nullable(),
      result: z.any().nullable(),
    }))
    .query(({ input }) => {
      try {
        const window = resolveNight(input.side, input.sleepRecordId)
        if (!window) {
          return { ok: false, message: 'No recorded nights for this side yet — backtest needs sleep history.', night: null, result: null }
        }
        const series = loadSeries(input.side, window.startMs, window.endMs)
        const result = runBacktest({
          rule: input.rule as BacktestRule,
          timezone: loadTimezone(),
          startMs: window.startMs,
          endMs: window.endMs,
          stepMin: input.stepMin,
          series,
        })
        return { ok: true, night: { label: window.label, date: window.date }, result }
      }
      catch (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Backtest failed: ${msg(error)}`, cause: error })
      }
    }),
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Unknown error'
}

function loadTimezone(): string {
  const [s] = db.select({ tz: deviceSettings.timezone }).from(deviceSettings).limit(1).all()
  return s?.tz ?? 'America/Los_Angeles'
}

interface NightWindow { startMs: number, endMs: number, label: string, date: string }

/** Resolve a night window: the requested record, else the latest, else last 24h. */
function resolveNight(side: 'left' | 'right', sleepRecordId?: number): NightWindow | null {
  let row: { enteredBedAt: Date, leftBedAt: Date } | undefined
  if (sleepRecordId != null) {
    [row] = biometricsDb
      .select({ enteredBedAt: sleepRecords.enteredBedAt, leftBedAt: sleepRecords.leftBedAt })
      .from(sleepRecords)
      .where(and(eq(sleepRecords.id, sleepRecordId), eq(sleepRecords.side, side)))
      .limit(1)
      .all()
  }
  if (!row) {
    [row] = biometricsDb
      .select({ enteredBedAt: sleepRecords.enteredBedAt, leftBedAt: sleepRecords.leftBedAt })
      .from(sleepRecords)
      .where(eq(sleepRecords.side, side))
      .orderBy(desc(sleepRecords.enteredBedAt))
      .limit(1)
      .all()
  }
  if (!row) {
    // No sleep records — fall back to the most recent 12h of any movement data.
    const [latest] = biometricsDb
      .select({ t: movement.timestamp })
      .from(movement)
      .where(eq(movement.side, side))
      .orderBy(desc(movement.timestamp))
      .limit(1)
      .all()
    if (!latest) return null
    const endMs = latest.t.getTime()
    return { startMs: endMs - 12 * 3_600_000, endMs, label: 'Recent', date: monthDay(latest.t) }
  }
  return {
    startMs: row.enteredBedAt.getTime(),
    endMs: row.leftBedAt.getTime(),
    label: 'Last night',
    date: monthDay(row.enteredBedAt),
  }
}

/** Build the historical signal series the backtest replays over. */
function loadSeries(side: 'left' | 'right', startMs: number, endMs: number): Record<string, Sample[]> {
  const start = new Date(startMs)
  const end = new Date(endMs)
  const series: Record<string, Sample[]> = {}

  const mv = biometricsDb
    .select({ t: movement.timestamp, v: movement.totalMovement })
    .from(movement)
    .where(and(eq(movement.side, side), gte(movement.timestamp, start), lte(movement.timestamp, end)))
    .orderBy(movement.timestamp)
    .all()
  series[`${side}.movement`] = mv.map(r => ({ t: r.t.getTime(), v: r.v }))

  const vit = biometricsDb
    .select({ t: vitals.timestamp, hr: vitals.heartRate, hrv: vitals.hrv, br: vitals.breathingRate })
    .from(vitals)
    .where(and(eq(vitals.side, side), gte(vitals.timestamp, start), lte(vitals.timestamp, end)))
    .orderBy(vitals.timestamp)
    .all()
  series[`${side}.heartRate`] = vit.flatMap(r => r.hr != null ? [{ t: r.t.getTime(), v: r.hr }] : [])
  series[`${side}.hrv`] = vit.flatMap(r => r.hrv != null ? [{ t: r.t.getTime(), v: r.hrv }] : [])
  series[`${side}.breathingRate`] = vit.flatMap(r => r.br != null ? [{ t: r.t.getTime(), v: r.br }] : [])

  const bt = biometricsDb
    .select({ t: bedTemp.timestamp, amb: bedTemp.ambientTemp, hum: bedTemp.humidity })
    .from(bedTemp)
    .where(and(gte(bedTemp.timestamp, start), lte(bedTemp.timestamp, end)))
    .orderBy(bedTemp.timestamp)
    .all()
  series['ambient.temperature'] = bt.flatMap(r => r.amb != null ? [{ t: r.t.getTime(), v: centiDegreesToF(r.amb) }] : [])
  series['ambient.humidity'] = bt.flatMap(r => r.hum != null ? [{ t: r.t.getTime(), v: centiPercentToPercent(r.hum) }] : [])

  const wl = biometricsDb
    .select({ t: waterLevelReadings.timestamp, level: waterLevelReadings.level })
    .from(waterLevelReadings)
    .where(and(gte(waterLevelReadings.timestamp, start), lte(waterLevelReadings.timestamp, end)))
    .orderBy(waterLevelReadings.timestamp)
    .all()
  series['water.low'] = wl.map(r => ({ t: r.t.getTime(), v: r.level === 'low' ? 1 : 0 }))

  return series
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function weekday(d: Date): string {
  return WEEKDAYS[d.getDay()]
}
function monthDay(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

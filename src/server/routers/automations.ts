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
import { and, desc, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm'
import { publicProcedure, router } from '@/src/server/trpc'
import { biometricsDb, db } from '@/src/db'
import { automationRuns, automations, deviceSettings, runOnceSessions, temperatureHolds } from '@/src/db/schema'
import { ambientLight, bedTemp, capSenseFrames, freezerTemp, movement, sleepRecords, vitals, waterLevelReadings } from '@/src/db/biometrics-schema'
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
import { runBacktest, type BacktestResult, type BacktestRule, type Sample } from '@/src/automation/backtest'
import { bucketRuns, classifyRun, collapseRuns, conditionTimeWindow, inTimeWindow } from '@/src/automation/activity'
import { clockInTimezone } from '@/src/automation/signals'
import type { Action, Condition, Expr, Trigger } from '@/src/automation/types'
import { getTemperatureControlStatus } from '@/src/temperature/instance'
import { temperatureControlStatusSchema } from '@/src/temperature/schema'

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

const backtestSummaryOutput = z.object({
  /** Nights replayed (per side; the larger count for a both-sides rule). */
  nights: z.number(),
  wouldFire: z.number(),
  /** Max / min of the compared value (windowed aggregate, else the raw signal). */
  peak: z.number().nullable(),
  low: z.number().nullable(),
  threshold: z.number().nullable(),
})

const sideTonightOutput = z.object({
  control: temperatureControlStatusSchema.nullable(),
  hold: z.object({ temperature: z.number(), startedAt: z.number(), expiresAt: z.number() }).nullable(),
  runOnceUntil: z.number().nullable(),
  lastAutopilot: z.object({ ruleName: z.string(), temp: z.number(), at: z.number() }).nullable(),
})

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
    .mutation(async ({ input }) => {
      db.insert(deviceSettings)
        .values({ id: 1, autopilotEnabled: input.enabled })
        .onConflictDoUpdate({ target: deviceSettings.id, set: { autopilotEnabled: input.enabled, updatedAt: new Date() } })
        .run()
      await getAutomationEngineIfRunning()?.setGlobalEnabled(input.enabled)
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
          .where(eq(automationRuns.automationId, r.id))
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

  /**
   * Per-rule evaluation history for the Diagnostics page: every run row since
   * the earlier of local midnight and `hours` ago (compact: time, outcome,
   * skip reason, whether a live action was sent), plus a live read of the
   * signals each rule's condition references. Skip rows don't record the value
   * the condition saw, so the live read is the closest truthful "observed".
   */
  diagnostics: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/diagnostics', protect: false, tags: ['Autopilot'] } })
    .input(z.object({ hours: z.number().int().min(1).max(24).default(3) }).strict())
    .output(z.object({
      now: z.date(),
      since: z.date(),
      startOfDay: z.date(),
      globalEnabled: z.boolean(),
      rules: z.array(automationOutput.extend({
        runs: z.array(z.object({
          t: z.date(),
          outcome: z.enum(['fired', 'skipped', 'clamped', 'dry_run', 'error']),
          reason: z.string().nullable(),
          sent: z.boolean(),
        })),
        signals: z.record(z.string(), z.number().nullable()),
      })),
    }))
    .query(async ({ input }) => {
      const now = new Date()
      const startOfDay = new Date(now)
      startOfDay.setHours(0, 0, 0, 0)
      const since = new Date(Math.min(startOfDay.getTime(), now.getTime() - input.hours * 3_600_000))
      const [settings] = db.select({ on: deviceSettings.autopilotEnabled }).from(deviceSettings).limit(1).all()
      const rows = db.select().from(automations).orderBy(desc(automations.priority), automations.id).all()
      const snapshot = await readLiveSignals()
      const rules = rows.map((r) => {
        const runs = db
          .select({ firedAt: automationRuns.firedAt, outcome: automationRuns.outcome, detail: automationRuns.detail })
          .from(automationRuns)
          .where(and(eq(automationRuns.automationId, r.id), gte(automationRuns.firedAt, since)))
          .orderBy(automationRuns.firedAt)
          .all()
        const signals: Record<string, number | null> = {}
        for (const key of conditionSignals(r.conditions as Condition)) signals[key] = snapshot[key] ?? null
        return {
          ...toOutput(r),
          runs: runs.map(x => ({ t: x.firedAt, outcome: x.outcome, ...runSummary(x.detail) })),
          signals,
        }
      })
      return { now, since, startOfDay, globalEnabled: settings?.on ?? true, rules }
    }),

  /**
   * Available past nights to backtest against, derived from sleep records: one
   * per night (the longest session), labelled by the date the night started.
   */
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
      return recentNights(input.side, input.limit).map(n => ({
        sleepRecordId: n.id,
        label: n.label,
        date: n.date,
        startMs: n.startMs,
        endMs: n.endMs,
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
        actions: z.array(automationActionSchema).min(1).max(10),
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

  /**
   * Replay a rule (inline, so the editor can check unsaved edits) over the last
   * recorded nights: how often it would fire and the range its compared value
   * actually reached — shown beside the threshold input so users don't pick a
   * threshold the signal never gets near.
   */
  backtestRange: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/automations/backtest-range', protect: false, tags: ['Autopilot'] } })
    .input(z.object({
      nights: z.number().int().min(1).max(14).default(5),
      rule: z.object({
        side: sideSchema.nullable().default(null),
        cooldownMin: z.number().int().min(0).max(1440).nullable().default(null),
        trigger: automationTriggerSchema,
        conditions: automationConditionSchema,
        actions: z.array(automationActionSchema).min(1).max(10),
      }),
    }).strict())
    .output(backtestSummaryOutput)
    .query(({ input }) => {
      try {
        return backtestNights(input.rule as BacktestRule, input.nights)
      }
      catch (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Backtest failed: ${msg(error)}`, cause: error })
      }
    }),

  /**
   * Per-rule backtest over the last 5 recorded nights, for the Automations
   * list. Cached by rule revision + night set, so it recomputes after a save
   * or once a new night is recorded.
   */
  backtestSummaries: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/backtest-summaries', protect: false, tags: ['Autopilot'] } })
    .input(z.object({}).strict())
    .output(z.array(backtestSummaryOutput.extend({ id: z.number() })))
    .query(() => {
      const rows = db.select().from(automations).orderBy(desc(automations.priority), automations.id).all()
      return rows.map((r) => {
        const rule = toOutput(r)
        try {
          return { id: r.id, ...cachedBacktest(rule, r.updatedAt.getTime()) }
        }
        catch (e) {
          console.warn(`[automations] backtest summary failed for rule ${r.id}:`, msg(e))
          return { id: r.id, nights: 0, wouldFire: 0, peak: null, low: null, threshold: null }
        }
      })
    }),

  /**
   * Who controls each side right now, with what the Automations page needs to
   * explain it: the controller's selected source, the manual hold row (when
   * the dial was turned and when it lapses), an active run-once session, and
   * the latest setpoint autopilot actually sent.
   */
  tonight: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/tonight', protect: false, tags: ['Autopilot'] } })
    .input(z.object({}).strict())
    .output(z.object({
      now: z.number(),
      sides: z.object({ left: sideTonightOutput, right: sideTonightOutput }),
    }))
    .query(() => {
      const now = Date.now()
      const control = getTemperatureControlStatus()
      const holds = db.select().from(temperatureHolds).all()
      const sessions = db
        .select({ side: runOnceSessions.side, expiresAt: runOnceSessions.expiresAt })
        .from(runOnceSessions)
        .where(eq(runOnceSessions.status, 'active'))
        .all()
      const recent = db
        .select({ firedAt: automationRuns.firedAt, detail: automationRuns.detail, ruleName: automations.name })
        .from(automationRuns)
        .leftJoin(automations, eq(automationRuns.automationId, automations.id))
        .where(and(
          gte(automationRuns.firedAt, new Date(now - 12 * 3_600_000)),
          inArray(automationRuns.outcome, ['fired', 'clamped']),
        ))
        .orderBy(desc(automationRuns.firedAt))
        .limit(200)
        .all()
      const side = (s: 'left' | 'right') => {
        const hold = holds.find(h => h.side === s)
        const session = sessions.find(x => x.side === s && x.expiresAt.getTime() > now)
        let lastAutopilot: { ruleName: string, temp: number, at: number } | null = null
        for (const run of recent) {
          const c = classifyRun({ automationId: 0, firedAt: run.firedAt, outcome: 'fired', detail: run.detail }, null)
          if (c.code === 'set-temperature' && c.temp != null && c.sides.includes(s)) {
            lastAutopilot = { ruleName: run.ruleName ?? 'Autopilot', temp: c.temp, at: run.firedAt.getTime() }
            break
          }
        }
        return {
          control: control?.[s] ?? null,
          hold: hold && hold.expiresAt > now ? { temperature: hold.temperature, startedAt: hold.startedAt, expiresAt: hold.expiresAt } : null,
          runOnceUntil: session ? session.expiresAt.getTime() : null,
          lastAutopilot,
        }
      }
      return { now, sides: { left: side('left'), right: side('right') } }
    }),

  /**
   * Activity log: every run in the given nights (ascending start times; each
   * night runs to the next start, the last to now), classified and with
   * consecutive same-reason skips collapsed. Manual holds that began in range
   * come back separately — the client shows them as "Paused".
   */
  activity: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/automations/activity', protect: false, tags: ['Autopilot'] } })
    .input(z.object({ nightStarts: z.array(z.number().int().nonnegative()).min(1).max(30) }).strict())
    .output(z.object({
      now: z.number(),
      nights: z.array(z.object({
        start: z.number(),
        entries: z.array(z.object({
          ruleId: z.number(),
          ruleName: z.string(),
          outcome: z.enum(['fired', 'skipped', 'clamped', 'dry_run', 'error']),
          code: z.string(),
          start: z.number(),
          end: z.number(),
          count: z.number(),
          temp: z.number().nullable(),
          sides: z.array(sideSchema),
        })),
      })),
      holds: z.array(z.object({ side: sideSchema, temperature: z.number(), startedAt: z.number(), expiresAt: z.number() })),
    }))
    .query(({ input }) => {
      const now = Date.now()
      const starts = [...input.nightStarts].sort((a, b) => a - b)
      const since = new Date(starts[0])
      const rules = db.select().from(automations).all()
      const byId = new Map(rules.map(r => [r.id, r]))
      const windows = new Map(rules.map(r => [r.id, conditionTimeWindow(r.conditions as Condition)]))
      const localMinute = localMinuteOfDay(loadTimezone())
      const runs = db
        .select({ automationId: automationRuns.automationId, firedAt: automationRuns.firedAt, outcome: automationRuns.outcome, detail: automationRuns.detail })
        .from(automationRuns)
        .where(gte(automationRuns.firedAt, since))
        .orderBy(automationRuns.firedAt)
        .all()
      const classified = runs.map((r) => {
        const w = windows.get(r.automationId)
        return classifyRun(r, w ? inTimeWindow(localMinute(r.firedAt.getTime()), w) : null)
      })
      const buckets = bucketRuns(classified, starts, now + 60_000)
      const holds = db.select().from(temperatureHolds).where(gte(temperatureHolds.startedAt, starts[0])).all()
      return {
        now,
        nights: starts.map((start, i) => ({
          start,
          entries: collapseRuns(buckets[i]).map(e => ({ ...e, ruleName: byId.get(e.ruleId)?.name ?? `Rule ${e.ruleId}` })),
        })).reverse(),
        holds: holds.map(h => ({ side: h.side, temperature: h.temperature, startedAt: h.startedAt, expiresAt: h.expiresAt })),
      }
    }),

  /**
   * Spatial zone replay for a chosen night: the per-window [head, torso, legs]
   * presence loads persisted to cap_sense_frames, downsampled to a frame budget
   * so a full night stays a light payload the zone viz can scrub. Frames with no
   * spatial resolution (Pod 3 scalar sensor → null zones) are skipped.
   */
  capZoneReplay: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/automations/cap-zone-replay', protect: false, tags: ['Autopilot'] } })
    .input(z.object({
      side: z.enum(['left', 'right']),
      sleepRecordId: idSchema.optional(),
      maxFrames: z.number().int().min(10).max(1000).default(300),
    }).strict())
    .output(z.object({
      ok: z.boolean(),
      night: z.object({ label: z.string(), date: z.string() }).nullable(),
      frames: z.array(z.object({
        tMs: z.number(),
        zones: z.array(z.number()),
        peakZone: z.number().nullable(),
      })),
    }))
    .query(({ input }) => {
      const window = resolveNight(input.side, input.sleepRecordId)
      if (!window) return { ok: false, night: null, frames: [] }
      const rows = biometricsDb
        .select({ t: capSenseFrames.timestamp, zones: capSenseFrames.zones, peakZone: capSenseFrames.peakZone })
        .from(capSenseFrames)
        .where(and(
          eq(capSenseFrames.side, input.side),
          gte(capSenseFrames.timestamp, new Date(window.startMs)),
          lte(capSenseFrames.timestamp, new Date(window.endMs)),
          isNotNull(capSenseFrames.zones),
        ))
        .orderBy(capSenseFrames.timestamp)
        .all()
      // Stride to the frame budget — evenly spaced, always keeping the first row.
      const stride = Math.max(1, Math.ceil(rows.length / input.maxFrames))
      const frames = rows
        .filter((_, i) => i % stride === 0)
        .map(r => ({ tMs: r.t.getTime(), zones: (r.zones as number[] | null) ?? [], peakZone: r.peakZone }))
      return { ok: true, night: { label: window.label, date: window.date }, frames }
    }),
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Signal keys a condition reads (plain or windowed), in first-seen order. */
function conditionSignals(c: Condition): string[] {
  const out = new Set<string>()
  const expr = (e: Expr): void => {
    if (e.kind === 'signal' || e.kind === 'window') out.add(e.signal)
    else if (e.kind === 'binary') {
      expr(e.left)
      expr(e.right)
    }
    else if (e.kind === 'clamp') {
      expr(e.value)
      expr(e.min)
      expr(e.max)
    }
  }
  const walk = (x: Condition): void => {
    if (x.kind === 'and' || x.kind === 'or') x.conditions.forEach(walk)
    else if (x.kind === 'not') walk(x.condition)
    else if (x.kind === 'compare') {
      expr(x.left)
      expr(x.right)
    }
    else if (x.kind === 'between') {
      expr(x.subject)
      expr(x.min)
      expr(x.max)
    }
  }
  walk(c)
  return [...out]
}

/** Skip reason and whether any action reached hardware, from a run's detail JSON. */
function runSummary(detail: unknown): { reason: string | null, sent: boolean } {
  if (!detail || typeof detail !== 'object') return { reason: null, sent: false }
  const d = detail as { reason?: unknown, actions?: Array<{ sent?: unknown }> }
  return {
    reason: typeof d.reason === 'string' ? d.reason : null,
    sent: Array.isArray(d.actions) && d.actions.some(a => a?.sent === true),
  }
}

/** The same composite snapshot the engine reads each tick; empty on failure. */
async function readLiveSignals(): Promise<Record<string, number | undefined>> {
  try {
    const [{ CompositeSignalReader, DeviceSignalReader }, { BiometricsSignalReader }] = await Promise.all([
      import('@/src/automation/signals'),
      import('@/src/automation/signals.biometrics'),
    ])
    return new CompositeSignalReader([new BiometricsSignalReader(), new DeviceSignalReader()]).read()
  }
  catch (e) {
    console.warn('[automations] live signal read failed:', msg(e))
    return {}
  }
}

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
    return { startMs: endMs - 12 * 3_600_000, endMs, label: 'Recent', date: nightOf(endMs + HALF_DAY_MS).date }
  }
  return {
    startMs: row.enteredBedAt.getTime(),
    endMs: row.leftBedAt.getTime(),
    label: 'Last night',
    date: nightOf(row.enteredBedAt.getTime()).date,
  }
}

interface NightRef { id: number, startMs: number, endMs: number, key: string, label: string, date: string }

const HALF_DAY_MS = 12 * 3_600_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The night a session belongs to, named by the day it started: a session
 * entered before noon belongs to the previous evening (bed at 12:30 AM Monday
 * is Sunday night).
 */
function nightOf(enteredMs: number): { key: string, weekday: string, date: string } {
  const d = new Date(enteredMs - HALF_DAY_MS)
  return {
    key: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
    weekday: WEEKDAYS[d.getDay()],
    date: `${MONTHS[d.getMonth()]} ${d.getDate()}`,
  }
}

/**
 * The side's most recent nights, newest first — one per night (its longest
 * session, so a night split by a bathroom trip doesn't show up twice).
 */
function recentNights(side: 'left' | 'right', limit: number): NightRef[] {
  const rows = biometricsDb
    .select({ id: sleepRecords.id, enteredBedAt: sleepRecords.enteredBedAt, leftBedAt: sleepRecords.leftBedAt })
    .from(sleepRecords)
    .where(eq(sleepRecords.side, side))
    .orderBy(desc(sleepRecords.enteredBedAt))
    .limit(limit * 4)
    .all()
  const byNight = new Map<string, NightRef>()
  for (const r of rows) {
    const startMs = r.enteredBedAt.getTime()
    const endMs = r.leftBedAt.getTime()
    const n = nightOf(startMs)
    const prev = byNight.get(n.key)
    if (!prev) {
      if (byNight.size >= limit) break
      byNight.set(n.key, { id: r.id, startMs, endMs, key: n.key, label: byNight.size === 0 ? 'Last night' : n.weekday, date: n.date })
    }
    else if (endMs - startMs > prev.endMs - prev.startMs) {
      byNight.set(n.key, { ...prev, id: r.id, startMs, endMs })
    }
  }
  return [...byNight.values()]
}

type BacktestSummary = z.infer<typeof backtestSummaryOutput>

/** Replay a rule over each side's last `limit` nights and fold the results. */
function backtestNights(rule: BacktestRule, limit: number): BacktestSummary {
  const tz = loadTimezone()
  const sides: Array<'left' | 'right'> = rule.side ? [rule.side] : ['left', 'right']
  let nights = 0
  let wouldFire = 0
  let peak: number | null = null
  let low: number | null = null
  let threshold: number | null = null
  for (const side of sides) {
    const refs = recentNights(side, limit)
    nights = Math.max(nights, refs.length)
    for (const n of refs) {
      const result: BacktestResult = runBacktest({
        rule: { ...rule, side },
        timezone: tz,
        startMs: n.startMs,
        endMs: n.endMs,
        stepMin: 2,
        series: loadSeries(side, n.startMs, n.endMs),
      })
      wouldFire += result.summary.wouldFire
      threshold ??= result.threshold
      for (const v of (result.avg ?? result.primary)?.values ?? []) {
        if (v == null) continue
        if (peak == null || v > peak) peak = v
        if (low == null || v < low) low = v
      }
    }
  }
  return { nights, wouldFire, peak, low, threshold }
}

const backtestCache = new Map<string, BacktestSummary>()

/** Keyed by rule revision + the nights it replays; a save or a new night misses. */
function cachedBacktest(rule: ReturnType<typeof toOutput>, updatedAtMs: number): BacktestSummary {
  const sides: Array<'left' | 'right'> = rule.side ? [rule.side] : ['left', 'right']
  const nightIds = sides.map(s => recentNights(s, 5).map(n => `${n.id}:${n.endMs}`).join(',')).join('|')
  const key = `${rule.id}:${updatedAtMs}:${nightIds}`
  const hit = backtestCache.get(key)
  if (hit) return hit
  for (const k of backtestCache.keys()) if (k.startsWith(`${rule.id}:`)) backtestCache.delete(k)
  const summary = backtestNights({ side: rule.side, cooldownMin: rule.cooldownMin, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions }, 5)
  backtestCache.set(key, summary)
  return summary
}

/**
 * Local minute-of-day in `tz`, memoising the UTC offset per hour — building
 * an Intl formatter per run row is too slow for a night of minute ticks.
 */
function localMinuteOfDay(tz: string): (ms: number) => number {
  const offsets = new Map<number, number>()
  return (ms: number) => {
    const hour = Math.floor(ms / 3_600_000)
    let offset = offsets.get(hour)
    if (offset === undefined) {
      const { nowMinutes } = clockInTimezone(tz, new Date(hour * 3_600_000))
      const utcMinutes = Math.floor((hour * 3_600_000) / 60_000) % 1440
      offset = nowMinutes - utcMinutes
      offsets.set(hour, offset)
    }
    return (((Math.floor(ms / 60_000) + offset) % 1440) + 1440) % 1440
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

  const zoneCols = side === 'left'
    ? { o: bedTemp.leftOuterTemp, c: bedTemp.leftCenterTemp, n: bedTemp.leftInnerTemp }
    : { o: bedTemp.rightOuterTemp, c: bedTemp.rightCenterTemp, n: bedTemp.rightInnerTemp }
  const bt = biometricsDb
    .select({ t: bedTemp.timestamp, amb: bedTemp.ambientTemp, hum: bedTemp.humidity, o: zoneCols.o, c: zoneCols.c, n: zoneCols.n })
    .from(bedTemp)
    .where(and(gte(bedTemp.timestamp, start), lte(bedTemp.timestamp, end)))
    .orderBy(bedTemp.timestamp)
    .all()
  series['ambient.temperature'] = bt.flatMap(r => r.amb != null ? [{ t: r.t.getTime(), v: centiDegreesToF(r.amb) }] : [])
  series['ambient.humidity'] = bt.flatMap(r => r.hum != null ? [{ t: r.t.getTime(), v: centiPercentToPercent(r.hum) }] : [])
  series[`${side}.surfaceTemp`] = bt.flatMap((r) => {
    const zs = [r.o, r.c, r.n].filter((x): x is number => x != null).map(centiDegreesToF)
    return zs.length ? [{ t: r.t.getTime(), v: zs.reduce((a, b) => a + b, 0) / zs.length }] : []
  })
  series[`${side}.surfaceTemp.spread`] = bt.flatMap((r) => {
    const zs = [r.o, r.c, r.n].filter((x): x is number => x != null).map(centiDegreesToF)
    return zs.length >= 2 ? [{ t: r.t.getTime(), v: Math.max(...zs) - Math.min(...zs) }] : []
  })
  series[`${side}.surfaceTemp.gradient`] = bt.flatMap(r =>
    r.n != null && r.o != null ? [{ t: r.t.getTime(), v: centiDegreesToF(r.n) - centiDegreesToF(r.o) }] : [])

  const waterCol = side === 'left' ? freezerTemp.leftWaterTemp : freezerTemp.rightWaterTemp
  const fz = biometricsDb
    .select({ t: freezerTemp.timestamp, w: waterCol })
    .from(freezerTemp)
    .where(and(gte(freezerTemp.timestamp, start), lte(freezerTemp.timestamp, end)))
    .orderBy(freezerTemp.timestamp)
    .all()
  series[`${side}.waterTemp`] = fz.flatMap(r => r.w != null ? [{ t: r.t.getTime(), v: centiDegreesToF(r.w) }] : [])

  const al = biometricsDb
    .select({ t: ambientLight.timestamp, lux: ambientLight.lux })
    .from(ambientLight)
    .where(and(gte(ambientLight.timestamp, start), lte(ambientLight.timestamp, end)))
    .orderBy(ambientLight.timestamp)
    .all()
  series['ambient.light'] = al.flatMap(r => r.lux != null ? [{ t: r.t.getTime(), v: r.lux }] : [])

  const wl = biometricsDb
    .select({ t: waterLevelReadings.timestamp, level: waterLevelReadings.level })
    .from(waterLevelReadings)
    .where(and(gte(waterLevelReadings.timestamp, start), lte(waterLevelReadings.timestamp, end)))
    .orderBy(waterLevelReadings.timestamp)
    .all()
  series['water.low'] = wl.map(r => ({ t: r.t.getTime(), v: r.level === 'low' ? 1 : 0 }))

  // Capacitive pressure reducers from the downsampled cap-frame history (~5s
  // windows). cap.peakZone stays out — it's a spatial index, not an engine signal.
  const cf = biometricsDb
    .select({ t: capSenseFrames.timestamp, max: capSenseFrames.max, mean: capSenseFrames.mean, spread: capSenseFrames.spread })
    .from(capSenseFrames)
    .where(and(eq(capSenseFrames.side, side), gte(capSenseFrames.timestamp, start), lte(capSenseFrames.timestamp, end)))
    .orderBy(capSenseFrames.timestamp)
    .all()
  series[`${side}.cap.max`] = cf.map(r => ({ t: r.t.getTime(), v: r.max }))
  series[`${side}.cap.mean`] = cf.map(r => ({ t: r.t.getTime(), v: r.mean }))
  series[`${side}.cap.spread`] = cf.map(r => ({ t: r.t.getTime(), v: r.spread }))

  return series
}


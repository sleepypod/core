/**
 * Global AutomationEngine singleton — mirrors `src/scheduler/instance.ts`.
 *
 * Wires the production dependencies (live signal reader, shared hardware client,
 * shared per-side lock, mutation broadcast, DB-backed rule load + audit log) and
 * ensures a single engine runs across the application. Booted beside the
 * JobManager from instrumentation.ts.
 */

import { and, avg, count, eq, gt, gte, lte, sql } from 'drizzle-orm'
import { biometricsDb, db } from '@/src/db'
import { vitals } from '@/src/db/biometrics-schema'
import { automationRuns, automations, deviceSettings, runOnceSessions } from '@/src/db/schema'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { markSideMutated } from '@/src/hardware/deviceStateSync'
import { withSideLock } from '@/src/hardware/sideLock'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'
import { AutomationEngine } from './engine'
import { DeviceSignalReader, clockInTimezone, type BaselineMap } from './signals'
import type {
  Action,
  AutomationRule,
  Condition,
  RunOutcome,
  Side,
  Trigger,
} from './types'

/** Rolling window the z-score baselines are computed over. */
const BASELINE_WINDOW_DAYS = 30

const DEFAULT_TIMEZONE = 'America/Los_Angeles'

let engineInstance: AutomationEngine | null = null
let engineInitPromise: Promise<AutomationEngine> | null = null
let cachedTimezone: string | null = null

async function loadTimezone(): Promise<string> {
  if (cachedTimezone) return cachedTimezone
  try {
    const [settings] = await db.select().from(deviceSettings).limit(1)
    cachedTimezone = settings?.timezone || DEFAULT_TIMEZONE
    return cachedTimezone
  }
  catch {
    return DEFAULT_TIMEZONE
  }
}

async function loadRules(): Promise<AutomationRule[]> {
  const rows = await db.select().from(automations)
  // JSON columns come back parsed; the router validates them with zod on write.
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    side: r.side,
    priority: r.priority,
    dryRun: r.dryRun,
    cooldownMin: r.cooldownMin,
    trigger: r.trigger as Trigger,
    conditions: r.conditions as Condition,
    actions: r.actions as Action[],
  }))
}

/**
 * Per-side vitals baselines (mean + population SD) over the trailing window,
 * computed the same way as `biometrics.getVitalsBaseline` (E[X²] − E[X]²).
 * Backs `{side}.{vital}.zscore` signals; a side with no samples is omitted.
 */
async function loadBaselines(): Promise<BaselineMap> {
  const out: BaselineMap = {}
  const now = Date.now()
  const start = new Date(now - BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const end = new Date(now)
  const sd = (mean: unknown, sqMean: number | null): number | undefined => {
    if (mean == null || sqMean == null) return undefined
    const variance = Number(sqMean) - Number(mean) * Number(mean)
    return variance > 0 ? Math.sqrt(variance) : 0
  }
  const num = (x: unknown): number | undefined => (x == null ? undefined : Number(x))

  for (const side of ['left', 'right'] as const) {
    const [row] = await biometricsDb
      .select({
        hrMean: avg(vitals.heartRate),
        hrSqMean: sql<number | null>`AVG(${vitals.heartRate} * ${vitals.heartRate})`,
        hrvMean: avg(vitals.hrv),
        hrvSqMean: sql<number | null>`AVG(${vitals.hrv} * ${vitals.hrv})`,
        brMean: avg(vitals.breathingRate),
        brSqMean: sql<number | null>`AVG(${vitals.breathingRate} * ${vitals.breathingRate})`,
        sampleCount: count(),
      })
      .from(vitals)
      .where(and(eq(vitals.side, side), gte(vitals.timestamp, start), lte(vitals.timestamp, end)))
    if (!row || row.sampleCount === 0) continue
    out[side] = {
      hrMean: num(row.hrMean),
      hrSD: sd(row.hrMean, row.hrSqMean),
      hrvMean: num(row.hrvMean),
      hrvSD: sd(row.hrvMean, row.hrvSqMean),
      brMean: num(row.brMean),
      brSD: sd(row.brMean, row.brSqMean),
    }
  }
  return out
}

async function recordRun(automationId: number, outcome: RunOutcome, detail: unknown): Promise<void> {
  try {
    await db.insert(automationRuns).values({
      automationId,
      outcome,
      detail: detail as object,
    })
  }
  catch (e) {
    console.warn('[automation] failed to record run:', e instanceof Error ? e.message : e)
  }
}

async function disableRule(automationId: number): Promise<void> {
  await db
    .update(automations)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(automations.id, automationId))
}

async function hasActiveRunOnceSession(side: Side): Promise<boolean> {
  const [session] = await db
    .select({ id: runOnceSessions.id })
    .from(runOnceSessions)
    .where(and(
      eq(runOnceSessions.side, side),
      eq(runOnceSessions.status, 'active'),
      gt(runOnceSessions.expiresAt, new Date()),
    ))
    .limit(1)
  return !!session
}

export async function getAutomationEngine(): Promise<AutomationEngine> {
  if (engineInstance) return engineInstance
  if (engineInitPromise) return engineInitPromise

  engineInitPromise = (async () => {
    try {
      const timezone = await loadTimezone()
      const reader = new DeviceSignalReader()
      const engine = new AutomationEngine({
        signals: reader,
        now: () => Date.now(),
        clock: () => clockInTimezone(timezone, new Date()),
        getHardware: () => getSharedHardwareClient(),
        withSideLock,
        broadcast: (side, overlay) => broadcastMutationStatus(side, overlay),
        markMutated: markSideMutated,
        loadRules,
        loadBaselines,
        recordRun,
        disableRule,
        hasActiveRunOnceSession,
        notify: (id, message) => console.log(`[automation notify] rule ${id}: ${message}`),
        log: msg => console.log(`[automation] ${msg}`),
      })
      await engine.start()
      // Restore the global kill-switch from persisted settings (default on).
      try {
        const [settings] = await db.select({ on: deviceSettings.autopilotEnabled }).from(deviceSettings).limit(1)
        if (settings && settings.on === false) engine.setGlobalEnabled(false)
      }
      catch {
        // Settings unreadable (e.g. fresh DB) — leave autopilot enabled.
      }
      engineInstance = engine
      console.log('AutomationEngine initialized with timezone:', timezone)
      return engine
    }
    finally {
      engineInitPromise = null
    }
  })()

  return engineInitPromise
}

export function getAutomationEngineIfRunning(): AutomationEngine | null {
  return engineInstance
}

export async function shutdownAutomationEngine(): Promise<void> {
  if (engineInstance) {
    engineInstance.stop()
    engineInstance = null
    engineInitPromise = null
    cachedTimezone = null
    console.log('AutomationEngine shut down')
  }
}

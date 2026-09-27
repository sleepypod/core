/**
 * Global AutomationEngine singleton — mirrors `src/scheduler/instance.ts`.
 *
 * Wires the production dependencies (live signal reader, shared hardware client,
 * shared per-side lock, mutation broadcast, DB-backed rule load + audit log) and
 * ensures a single engine runs across the application. Booted beside the
 * JobManager from instrumentation.ts.
 */

import { and, eq, gt } from 'drizzle-orm'
import { db } from '@/src/db'
import { automationRuns, automations, deviceSettings, runOnceSessions, sideSettings } from '@/src/db/schema'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { markSideMutated } from '@/src/hardware/deviceStateSync'
import { shouldBlock as pumpStallShouldBlock } from '@/src/hardware/pumpStallGuard'
import { withSideLock } from '@/src/hardware/sideLock'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'
import { AutomationEngine } from './engine'
import { BiometricsSignalReader } from './signals.biometrics'
import { CompositeSignalReader, DeviceSignalReader, clockInTimezone } from './signals'
import type {
  Action,
  AutomationRule,
  Condition,
  RunOutcome,
  Side,
  Trigger,
} from './types'

const DEFAULT_TIMEZONE = 'America/Los_Angeles'

// API routes and instrumentation may load separate bundled copies of this module.
// Share both the engine and its initialization/control state across those copies.
const globalState = globalThis as typeof globalThis & {
  __sp_automation__?: {
    instance: AutomationEngine | null
    pending: Promise<AutomationEngine> | null
    shutdown: Promise<void> | null
    abort: AbortController | null
    cachedTimezone: string | null
    activeTimezone: string
  }
}
function state() {
  return globalState.__sp_automation__ ??= {
    instance: null, pending: null, shutdown: null, abort: null,
    cachedTimezone: null, activeTimezone: DEFAULT_TIMEZONE,
  }
}

async function loadTimezone(): Promise<string> {
  const cached = state().cachedTimezone
  if (cached) return cached
  try {
    const [settings] = await db.select().from(deviceSettings).limit(1)
    const timezone = settings?.timezone || DEFAULT_TIMEZONE
    state().cachedTimezone = timezone
    return timezone
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
    updatedAt: r.updatedAt,
    dryRun: r.dryRun,
    cooldownMin: r.cooldownMin,
    trigger: r.trigger as Trigger,
    conditions: r.conditions as Condition,
    actions: r.actions as Action[],
  }))
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
  const s = state()
  if (s.shutdown) throw new Error('AutomationEngine is shutting down')
  if (s.instance) return s.instance
  if (s.pending) return s.pending

  const controller = new AbortController()
  s.abort = controller
  s.pending = (async () => {
    let engine: AutomationEngine | null = null
    try {
      const timezone = await loadTimezone()
      controller.signal.throwIfAborted()
      s.activeTimezone = timezone
      // DAC status first, biometrics merged on top; the DAC reader stays
      // authoritative for any overlapping key (e.g. water.low).
      const reader = new CompositeSignalReader([
        new BiometricsSignalReader(),
        new DeviceSignalReader(),
      ])
      engine = new AutomationEngine({
        signals: reader,
        now: () => Date.now(),
        clock: () => clockInTimezone(s.activeTimezone, new Date()),
        getHardware: () => getSharedHardwareClient(),
        withSideLock,
        pumpStallShouldBlock,
        broadcast: (side, overlay) => broadcastMutationStatus(side, overlay),
        markMutated: markSideMutated,
        loadRules,
        recordRun,
        disableRule,
        hasActiveRunOnceSession,
        isAwayMode: async (side) => {
          const [settings] = await db.select({ awayMode: sideSettings.awayMode }).from(sideSettings).where(eq(sideSettings.side, side)).limit(1)
          return settings?.awayMode ?? false
        },
        notify: (id, message) => console.log(`[automation notify] rule ${id}: ${message}`),
        log: msg => console.log(`[automation] ${msg}`),
      })
      // Restore the global kill-switch from persisted settings (default on).
      try {
        const [settings] = await db.select({ on: deviceSettings.autopilotEnabled }).from(deviceSettings).limit(1)
        if (settings && settings.on === false) engine.setGlobalEnabled(false)
      }
      catch {
        // Fail closed when the persisted safety setting cannot be read.
        engine.setGlobalEnabled(false)
      }
      controller.signal.throwIfAborted()
      await engine.start()
      controller.signal.throwIfAborted()
      s.instance = engine
      console.log('AutomationEngine initialized with timezone:', timezone)
      return engine
    }
    catch (error) {
      engine?.stop()
      throw error
    }
    finally {
      s.pending = null
      s.abort = null
    }
  })()

  return s.pending
}

export function getAutomationEngineIfRunning(): AutomationEngine | null {
  return state().instance
}

/**
 * Propagate a device-settings timezone change to the running engine. The
 * clock closure reads activeTimezone on every tick, so timeOfDay triggers
 * evaluate in the new timezone immediately — previously the closure kept the
 * boot-time tz (and cachedTimezone was never invalidated) until restart.
 */
export function updateAutomationTimezone(timezone: string): void {
  state().cachedTimezone = timezone
  state().activeTimezone = timezone
  console.log('[automation] timezone updated to', timezone)
}

export function shutdownAutomationEngine(): Promise<void> {
  const s = state()
  if (s.shutdown) return s.shutdown
  s.abort?.abort()
  s.shutdown = (async () => {
    await s.pending?.catch(() => {})
    if (s.instance) {
      s.instance.setGlobalEnabled(false)
      s.instance.stop()
      console.log('AutomationEngine shut down')
    }
  })().finally(() => {
    s.instance = null
    s.pending = null
    s.abort = null
    s.cachedTimezone = null
    s.activeTimezone = DEFAULT_TIMEZONE
    s.shutdown = null
  })
  return s.shutdown
}

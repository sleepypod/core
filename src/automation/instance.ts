/**
 * Global AutomationEngine singleton — mirrors `src/scheduler/instance.ts`.
 *
 * Wires the production dependencies (live signal reader, shared hardware client,
 * shared per-side lock, mutation broadcast, DB-backed rule load + audit log) and
 * ensures a single engine runs across the application. Booted beside the
 * JobManager from instrumentation.ts.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { automationRuns, automations, deviceSettings } from '@/src/db/schema'
import { getTemperatureController } from '@/src/temperature/instance'
import { AutomationEngine } from './engine'
import { BiometricsSignalReader } from './signals.biometrics'
import { CompositeSignalReader, DeviceSignalReader, clockInTimezone } from './signals'
import type {
  Action,
  AutomationRule,
  Condition,
  RunOutcome,
  Trigger,
} from './types'

const DEFAULT_TIMEZONE = 'America/Los_Angeles'

const globals = globalThis as typeof globalThis & {
  __sp_automationState?: {
    engineInstance: AutomationEngine | null
    engineInitPromise: Promise<AutomationEngine> | null
    cachedTimezone: string | null
    activeTimezone: string
  }
}
const state = globals.__sp_automationState ??= {
  engineInstance: null, engineInitPromise: null, cachedTimezone: null, activeTimezone: DEFAULT_TIMEZONE,
}

async function loadTimezone(): Promise<string> {
  if (state.cachedTimezone) return state.cachedTimezone
  try {
    const [settings] = await db.select().from(deviceSettings).limit(1)
    state.cachedTimezone = settings?.timezone || DEFAULT_TIMEZONE
    return state.cachedTimezone
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

export async function getAutomationEngine(): Promise<AutomationEngine> {
  if (state.engineInstance) return state.engineInstance
  if (state.engineInitPromise) return state.engineInitPromise

  state.engineInitPromise = (async () => {
    try {
      const timezone = await loadTimezone()
      state.activeTimezone = timezone
      // DAC status first, biometrics merged on top; the DAC reader stays
      // authoritative for any overlapping key (e.g. water.low).
      const reader = new CompositeSignalReader([
        new BiometricsSignalReader(),
        new DeviceSignalReader(),
      ])
      const engine = new AutomationEngine({
        signals: reader,
        now: () => Date.now(),
        clock: () => clockInTimezone(state.activeTimezone, new Date()),
        control: getTemperatureController(),
        loadRules,
        recordRun,
        disableRule,
        notify: (id, message) => console.log(`[automation notify] rule ${id}: ${message}`),
        log: msg => console.log(`[automation] ${msg}`),
      })
      await engine.start()
      // Restore the global kill-switch from persisted settings (default on).
      try {
        const [settings] = await db.select({ on: deviceSettings.autopilotEnabled }).from(deviceSettings).limit(1)
        if (settings && settings.on === false) await engine.setGlobalEnabled(false)
      }
      catch {
        // Settings unreadable (e.g. fresh DB) — leave autopilot enabled.
      }
      await engine.tick()
      state.engineInstance = engine
      console.log('AutomationEngine initialized with timezone:', timezone)
      return engine
    }
    finally {
      state.engineInitPromise = null
    }
  })()

  return state.engineInitPromise
}

export function getAutomationEngineIfRunning(): AutomationEngine | null {
  return state.engineInstance
}

/**
 * Propagate a device-settings timezone change to the running engine. The
 * clock closure reads state.activeTimezone on every tick, so timeOfDay triggers
 * evaluate in the new timezone immediately — previously the closure kept the
 * boot-time tz (and state.cachedTimezone was never invalidated) until restart.
 */
export function updateAutomationTimezone(timezone: string): void {
  state.cachedTimezone = timezone
  state.activeTimezone = timezone
  console.log('[automation] timezone updated to', timezone)
}

export async function shutdownAutomationEngine(): Promise<void> {
  if (state.engineInstance) {
    await state.engineInstance.stop()
    state.engineInstance = null
    state.engineInitPromise = null
    state.cachedTimezone = null
    console.log('AutomationEngine shut down')
  }
}

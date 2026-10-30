import { eq } from 'drizzle-orm'
import { db, sqlite } from '@/src/db'
import { automations, deviceSettings } from '@/src/db/schema'
import { createNotificationStore } from './store'

const globals = globalThis as typeof globalThis & { __sp_notifications?: ReturnType<typeof createNotificationStore> }
export function getNotificationStore() {
  return globals.__sp_notifications ??= createNotificationStore(sqlite)
}

/** Persist the alert before an automation records it as queued. */
export function publishAutomationNotification(sourceId: number, message: string) {
  const rule = db.select().from(automations).where(eq(automations.id, sourceId)).get()
  const settings = db.select({ enabled: deviceSettings.autopilotEnabled }).from(deviceSettings).get()
  const actions = rule?.actions as Array<{ kind?: string, message?: string }> | undefined
  if (!settings?.enabled || !rule?.enabled || rule.dryRun || !actions?.some(action => action.kind === 'notify' && action.message === message)) {
    throw new Error('Notification source is no longer active')
  }
  return getNotificationStore().publish({ sourceId, title: rule.name, message })
}

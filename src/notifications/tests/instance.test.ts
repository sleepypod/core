// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/src/db', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const { migratedComfortDatabase } = await import('@/src/comfort/tests/databaseFixture')
  const sqlite = migratedComfortDatabase()
  return { sqlite, db: drizzle(sqlite) }
})
const { db, sqlite } = await import('@/src/db')
const { automations, deviceSettings, notificationInbox } = await import('@/src/db/schema')
const { getNotificationStore, publishAutomationNotification } = await import('../instance')
beforeEach(() => {
  db.delete(notificationInbox).run()
  db.delete(automations).run()
  db.delete(deviceSettings).run()
  db.insert(deviceSettings).values({ autopilotEnabled: true }).run()
  db.insert(automations).values({ id: 7, name: 'Bedroom', enabled: true, dryRun: false,
    trigger: { kind: 'tick', everyMin: 1 }, conditions: { kind: 'and', conditions: [] }, actions: [{ kind: 'notify', message: 'New alert' }] }).run()
})
afterAll(() => sqlite.close())
describe('production notification publisher', () => {
  it('persists the current rule title and keeps the inbox when that rule is deleted', () => {
    const receipt = publishAutomationNotification(7, 'New alert')
    expect(receipt.duplicate).toBe(false)
    db.delete(automations).run()
    expect(getNotificationStore().list().items[0]).toMatchObject({ title: 'Bedroom', sourceId: 7, message: 'New alert' })
    expect(() => publishAutomationNotification(7, 'New alert')).toThrow('no longer active')
  })
  it('rechecks global consent, rule enablement, dry-run and the current action before publishing', () => {
    for (const changed of [{ enabled: false }, { dryRun: true }, { actions: [] }]) {
      db.update(automations).set(changed).run()
      expect(() => publishAutomationNotification(7, 'New alert')).toThrow('no longer active')
      db.update(automations).set({ enabled: true, dryRun: false, actions: [{ kind: 'notify', message: 'New alert' }] }).run()
    }
    expect(() => publishAutomationNotification(7, 'Removed message')).toThrow('no longer active')
    db.update(deviceSettings).set({ autopilotEnabled: false }).run()
    expect(() => publishAutomationNotification(7, 'New alert')).toThrow('no longer active')
    db.delete(deviceSettings).run()
    expect(() => publishAutomationNotification(7, 'New alert')).toThrow('no longer active')
    expect(getNotificationStore().list().items).toEqual([])
  })
})

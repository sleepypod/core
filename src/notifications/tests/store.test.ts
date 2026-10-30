// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { createNotificationStore } from '../store'
import { MAX_NOTIFICATIONS, NOTIFICATION_LIFETIME_MS, NOTIFICATION_RETENTION_MS } from '../contract'

const start = 1_793_000_000_000
const input = { sourceId: 7, title: 'Bedroom humidity', message: 'Humidity is above your chosen threshold.' }
let directory: string
let database: ReturnType<typeof migratedComfortDatabase>
let store: ReturnType<typeof createNotificationStore>
let now: number
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'notification-store-'))
  database = migratedComfortDatabase(join(directory, 'config.db'))
  now = start
  store = createNotificationStore(database, () => now)
})
afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('durable automation inbox', () => {
  it('retains alerts, deduplication, and idempotent acknowledgment across a database reopen', () => {
    const receipt = store.publish(input)
    expect(receipt.duplicate).toBe(false)
    const initial = store.list()
    expect(initial).toMatchObject({ apiVersion: 1, unreadCount: 1, newestId: receipt.notificationId, nextBeforeId: null,
      delivery: { foregroundInbox: true, backgroundPush: false } })
    expect(initial.items[0]).toMatchObject({ ...input, source: 'automation', createdAt: start, expiresAt: start + NOTIFICATION_LIFETIME_MS, acknowledgedAt: null })
    now += 1000
    expect(store.acknowledge([receipt.notificationId, receipt.notificationId, 999])).toMatchObject({ acknowledgedIds: [receipt.notificationId], missingIds: [999] })
    database.close()
    database = migratedComfortDatabase(join(directory, 'config.db'))
    store = createNotificationStore(database, () => now)
    now += 1000
    expect(store.publish(input)).toEqual({ ...receipt, duplicate: true })
    store.acknowledge([receipt.notificationId])
    expect(store.list()).toMatchObject({ unreadCount: 0, items: [{ acknowledgedAt: start + 1000, expiresAt: start + NOTIFICATION_LIFETIME_MS }] })
    now = start + 60_000
    expect(store.publish(input)).toMatchObject({ duplicate: false })
  })

  it('expires unread badges at the deadline, retains history, and excludes future alerts after clock rollback', () => {
    const receipt = store.publish(input)
    now = start - 1
    expect(store.list()).toMatchObject({ items: [], unreadCount: 0, newestId: null })
    expect(store.acknowledge([receipt.notificationId]).missingIds).toEqual([receipt.notificationId])
    expect(store.publish(input)).toEqual({ ...receipt, duplicate: true })
    now = start + NOTIFICATION_LIFETIME_MS - 1
    expect(store.list().unreadCount).toBe(1)
    now++
    expect(store.list()).toMatchObject({ unreadCount: 0, items: [{ acknowledgedAt: null }] })
    now = start + NOTIFICATION_RETENTION_MS + 1
    expect(store.list().items).toEqual([])
    expect(store.acknowledge([receipt.notificationId]).missingIds).toEqual([receipt.notificationId])
    store.publish({ ...input, message: 'New event' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM notification_inbox').get()).toEqual({ count: 1 })
  })

  it('pages using stable IDs without losing new alerts or including them in a page acknowledgment', () => {
    for (let index = 0; index < 52; index++) store.publish({ ...input, message: `Alert ${index}` })
    const latest = store.list()
    expect(latest.items).toHaveLength(50)
    const inserted = store.publish({ ...input, message: 'Arrived while reading' })
    store.acknowledge(latest.items.map(item => item.id))
    const older = store.list(latest.nextBeforeId ?? undefined)
    expect(older.items).toHaveLength(2)
    expect(older.nextBeforeId).toBeNull()
    expect(older.unreadCount).toBe(3)
    expect(older.newestId).toBe(inserted.notificationId)
    expect(store.list().items[0].acknowledgedAt).toBeNull()
  })

  it('bounds retained data and isolates duplicate suppression by rule, title, and message', () => {
    store.publish(input)
    expect(store.publish({ ...input, sourceId: 8 }).duplicate).toBe(false)
    expect(store.publish({ ...input, title: 'Renamed rule' }).duplicate).toBe(false)
    for (let index = 0; index < MAX_NOTIFICATIONS; index++) store.publish({ ...input, message: `Alert ${index}` })
    expect(database.prepare('SELECT COUNT(*) AS count FROM notification_inbox').get()).toEqual({ count: MAX_NOTIFICATIONS })
    expect(store.list().unreadCount).toBe(MAX_NOTIFICATIONS)
  })

  it('rejects malformed input or clocks without partially writing the inbox', () => {
    for (const invalid of [-1, 0, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      now = invalid
      expect(() => store.publish(input)).toThrow()
      expect(() => store.list()).toThrow()
    }
    now = start
    for (const sourceId of [-1, 0, 1.5, Infinity]) expect(() => store.publish({ ...input, sourceId })).toThrow()
    expect(() => store.publish({ ...input, message: '' })).toThrow()
    expect(() => store.publish({ ...input, message: 'a'.repeat(2001) })).toThrow()
    for (const ids of [[], [0], Array.from({ length: 51 }, () => 1)]) expect(() => store.acknowledge(ids)).toThrow()
    expect(() => store.list(-1)).toThrow()
    expect(store.list().items).toEqual([])
  })

  it('does not return a delivery receipt when persistence fails', () => {
    database.pragma('query_only = ON')
    expect(() => store.publish(input)).toThrow()
    expect(store.list().items).toEqual([])
  })
})

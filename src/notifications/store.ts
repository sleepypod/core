import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  MAX_NOTIFICATIONS, NOTIFICATION_DEDUPLICATION_MS, NOTIFICATION_LIFETIME_MS,
  NOTIFICATION_PAGE_SIZE, NOTIFICATION_RETENTION_MS, notificationIdSchema,
  notificationPageSchema, notificationSchema, publishNotificationSchema,
} from './contract'

const columns = `id, source_id AS sourceId, title, message, created_at AS createdAt,
  expires_at AS expiresAt, acknowledged_at AS acknowledgedAt`

/** All writes are bounded SQLite transactions; reads never start hardware or timers. */
export function createNotificationStore(database: Database.Database, clock = Date.now) {
  function now() {
    const value = clock()
    if (!Number.isSafeInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER - NOTIFICATION_RETENTION_MS) {
      throw new Error('Notification clock is unavailable')
    }
    return value
  }

  return {
    publish(input: { sourceId: number, title: string, message: string }) {
      const message = publishNotificationSchema.parse(input)
      const createdAt = now()
      const fingerprint = createHash('sha256').update(JSON.stringify(message)).digest('hex')
      return database.transaction(() => {
        // A repeated event, including after restart or clock rollback, must not
        // re-arm an acknowledged alert or extend its original lifetime.
        const previous = database.prepare(`SELECT id FROM notification_inbox
          WHERE fingerprint = ? AND created_at > ? ORDER BY id DESC LIMIT 1`)
          .get(fingerprint, createdAt - NOTIFICATION_DEDUPLICATION_MS) as { id: number } | undefined
        if (previous) return { notificationId: previous.id, duplicate: true }
        const result = database.prepare(`INSERT INTO notification_inbox
          (source_id, title, message, fingerprint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(message.sourceId, message.title, message.message, fingerprint, createdAt, createdAt + NOTIFICATION_LIFETIME_MS)
        database.prepare('DELETE FROM notification_inbox WHERE created_at < ?').run(createdAt - NOTIFICATION_RETENTION_MS)
        database.prepare(`DELETE FROM notification_inbox WHERE id NOT IN
          (SELECT id FROM notification_inbox ORDER BY id DESC LIMIT ?)`).run(MAX_NOTIFICATIONS)
        return { notificationId: Number(result.lastInsertRowid), duplicate: false }
      })()
    },

    list(beforeId?: number) {
      if (beforeId !== undefined) notificationIdSchema.parse(beforeId)
      const generatedAt = now()
      return database.transaction(() => {
        const parameters = [generatedAt - NOTIFICATION_RETENTION_MS, generatedAt]
        const rows = database.prepare(`SELECT ${columns} FROM notification_inbox
          WHERE created_at >= ? AND created_at <= ? ${beforeId === undefined ? '' : 'AND id < ?'}
          ORDER BY id DESC LIMIT ?`)
          .all(...parameters, ...(beforeId === undefined ? [] : [beforeId]), NOTIFICATION_PAGE_SIZE + 1)
        const items = rows.slice(0, NOTIFICATION_PAGE_SIZE)
          .map(row => notificationSchema.parse({ ...row as object, source: 'automation' }))
        const summary = database.prepare(`SELECT MAX(id) AS newestId,
          SUM(CASE WHEN acknowledged_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS unreadCount
          FROM notification_inbox WHERE created_at >= ? AND created_at <= ?`)
          .get(generatedAt, ...parameters) as { newestId: number | null, unreadCount: number | null }
        return notificationPageSchema.parse({
          apiVersion: 1, generatedAt, items, newestId: summary.newestId,
          unreadCount: summary.unreadCount ?? 0,
          nextBeforeId: rows.length > NOTIFICATION_PAGE_SIZE ? items.at(-1)?.id ?? null : null,
          delivery: { foregroundInbox: true, backgroundPush: false },
        })
      })()
    },

    acknowledge(input: number[]) {
      if (!Array.isArray(input) || input.length < 1 || input.length > NOTIFICATION_PAGE_SIZE) throw new Error('Select between one and fifty alerts')
      const identifiers = [...new Set(input.map(identifier => notificationIdSchema.parse(identifier)))]
      const generatedAt = now()
      return database.transaction(() => {
        const acknowledgedIds: number[] = []
        const missingIds: number[] = []
        const update = database.prepare(`UPDATE notification_inbox
          SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ? AND created_at <= ? AND created_at >= ?`)
        for (const identifier of identifiers) {
          const result = update.run(generatedAt, identifier, generatedAt, generatedAt - NOTIFICATION_RETENTION_MS)
          if (result.changes) acknowledgedIds.push(identifier)
          else missingIds.push(identifier)
        }
        return { generatedAt, acknowledgedIds, missingIds }
      })()
    },
  }
}

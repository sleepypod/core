import { describe, expect, it } from 'vitest'
import type { NotificationItem, NotificationPage } from '../contract'
import { foregroundDelivery } from '../foreground'

const item: NotificationItem = { id: 2, sourceId: 1, source: 'automation', title: 'Rule', message: 'Alert', createdAt: 100, expiresAt: 200, acknowledgedAt: null }
const page: NotificationPage = { apiVersion: 1, generatedAt: 150, newestId: 2, nextBeforeId: null, unreadCount: 1, items: [item], delivery: { foregroundInbox: true, backgroundPush: false } }
describe('foreground delivery cursor', () => {
  it('does not replay existing alerts on first connection, duplicate polls, or restored databases', () => {
    expect(foregroundDelivery(page, undefined)).toEqual({ cursor: 2, items: [] })
    expect(foregroundDelivery(page, 2).items).toEqual([])
    expect(foregroundDelivery(page, 90)).toEqual({ cursor: 90, items: [] })
    expect(foregroundDelivery(page, null).items).toEqual([item])
    expect(foregroundDelivery(page, 1).items).toEqual([item])
  })
  it('never delivers expired, acknowledged, or future entries on reconnect', () => {
    for (const changed of [{ expiresAt: 150 }, { acknowledgedAt: 120 }, { createdAt: 151 }]) {
      expect(foregroundDelivery({ ...page, items: [{ ...item, ...changed }] }, 1).items).toEqual([])
    }
  })
})

import type { NotificationItem, NotificationPage } from './contract'

export function isUnreadAlert(item: NotificationItem, at: number) {
  return item.acknowledgedAt === null && item.createdAt <= at && item.expiresAt > at
}

/** Opening/reopening the app establishes a cursor without replaying old alerts. */
export function foregroundDelivery(page: NotificationPage, previousId: number | null | undefined) {
  const items = previousId === undefined || (page.newestId ?? 0) < (previousId ?? 0)
    ? []
    : page.items.filter(item => item.id > (previousId ?? 0) && isUnreadAlert(item, page.generatedAt))
  // Keep the high-water mark across clock rollback/restoration so an alert that
  // temporarily disappeared cannot be announced a second time in this session.
  const cursor = Math.max(previousId ?? 0, page.newestId ?? 0) || null
  return { cursor, items }
}

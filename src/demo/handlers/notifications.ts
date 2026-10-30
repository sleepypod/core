import type { DemoHandlers } from '../types'

export const notifications: DemoHandlers<'notifications'> = {
  list: () => ({
    apiVersion: 1, generatedAt: Date.now(), newestId: null, nextBeforeId: null, unreadCount: 0, items: [],
    delivery: { foregroundInbox: false, backgroundPush: false },
  }),
  acknowledge: () => { throw new Error('Connect to your Pod to acknowledge real alerts.') },
}

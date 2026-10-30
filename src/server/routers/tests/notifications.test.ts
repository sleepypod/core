import { beforeEach, describe, expect, it, vi } from 'vitest'
const store = vi.hoisted(() => ({ list: vi.fn(), acknowledge: vi.fn() }))
vi.mock('@/src/notifications/instance', () => ({ getNotificationStore: () => store }))
const { notificationsRouter } = await import('../notifications')
const caller = notificationsRouter.createCaller({})
beforeEach(() => {
  vi.resetAllMocks()
  store.list.mockReturnValue({ apiVersion: 1, generatedAt: 100, newestId: null, nextBeforeId: null, unreadCount: 0, items: [], delivery: { foregroundInbox: true, backgroundPush: false } })
  store.acknowledge.mockReturnValue({ generatedAt: 100, acknowledgedIds: [1], missingIds: [] })
})
describe('notification API validation', () => {
  it('provides versioned reads and explicit acknowledgments without starting an engine', async () => {
    expect(await caller.list({ beforeId: 5 })).toMatchObject({ apiVersion: 1 })
    expect(store.list).toHaveBeenCalledWith(5)
    expect(await caller.acknowledge({ ids: [1] })).toMatchObject({ acknowledgedIds: [1] })
    expect(store.acknowledge).toHaveBeenCalledWith([1])
  })
  it('rejects invalid pagination, oversized selections, and unsafe identifiers', async () => {
    for (const beforeId of [-1, 0, 1.1, Number.MAX_SAFE_INTEGER + 1]) await expect(caller.list({ beforeId })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    for (const ids of [[], [0], [Infinity], Array.from({ length: 51 }, () => 1)]) await expect(caller.acknowledge({ ids })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(store.list).not.toHaveBeenCalled()
    expect(store.acknowledge).not.toHaveBeenCalled()
  })
})

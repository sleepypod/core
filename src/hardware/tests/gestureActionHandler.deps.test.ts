/**
 * The deps module is a thin wiring layer between the GestureActionHandler
 * and the DB / shared-client singletons. The behaviour under test is "the
 * deps actually call the wired-up dependencies", so the test layer mocks
 * the imports it shouldn't pull in (DB + dacMonitor.instance) and exercises
 * each dep function.
 */

import { describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => {
  const limit = vi.fn(async () => [])
  const where = vi.fn(() => ({ limit }))
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  return { db: { select }, select, from, where, limit }
})

const sharedClient = { connect: vi.fn() }
const sharedMock = vi.hoisted(() => ({
  getSharedHardwareClient: vi.fn(() => sharedClient),
}))

vi.mock('@/src/db', () => ({ db: dbMock.db }))
vi.mock('@/src/db/schema', () => ({
  tapGestures: { side: 'side', tapType: 'tapType' },
  deviceState: { side: 'side' },
}))
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
}))
vi.mock('@/src/hardware/dacMonitor.instance', () => sharedMock)

const { defaultGestureActionDeps } = await import('@/src/hardware/gestureActionHandler.deps')

describe('defaultGestureActionDeps', () => {
  it('findGestureConfig returns the first row or null', async () => {
    dbMock.limit.mockResolvedValueOnce([{ actionType: 'alarm' }] as never)
    expect(await defaultGestureActionDeps.findGestureConfig('left', 'doubleTap'))
      .toEqual({ actionType: 'alarm' })

    dbMock.limit.mockResolvedValueOnce([] as never)
    expect(await defaultGestureActionDeps.findGestureConfig('right', 'tripleTap'))
      .toBeNull()
  })

  it('findDeviceState returns the first row or null', async () => {
    dbMock.limit.mockResolvedValueOnce([{ isPowered: true }] as never)
    expect(await defaultGestureActionDeps.findDeviceState('left'))
      .toEqual({ isPowered: true })

    dbMock.limit.mockResolvedValueOnce([] as never)
    expect(await defaultGestureActionDeps.findDeviceState('right')).toBeNull()
  })

  it('newHardwareClient ignores the socketPath and returns the shared client', () => {
    const client = defaultGestureActionDeps.newHardwareClient('/tmp/whatever.sock')
    expect(client).toBe(sharedClient)
    expect(sharedMock.getSharedHardwareClient).toHaveBeenCalled()
  })
})

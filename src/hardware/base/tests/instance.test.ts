import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ start: vi.fn().mockResolvedValue(undefined), construct: vi.fn(), transport: vi.fn() }))
vi.mock('../bluez', () => ({ BluezTransport: vi.fn(function () {
  mocks.transport()
}) }))
vi.mock('../configuration', () => ({ readBaseConfiguration: vi.fn() }))
vi.mock('../controller', () => ({ BaseController: class {
  constructor() { mocks.construct() }
  start = mocks.start
} }))
const { getBaseController, getBaseControllerIfRunning } = await import('../instance')
const globals = globalThis as typeof globalThis & { __sleepypodBase?: unknown }
beforeEach(() => {
  delete globals.__sleepypodBase
  vi.clearAllMocks()
})
afterEach(() => {
  delete globals.__sleepypodBase
})

describe('passive base discovery', () => {
  it('does not create a Bluetooth connection when the controller has not started', () => {
    expect(getBaseControllerIfRunning()).toBeNull()
    expect(mocks.construct).not.toHaveBeenCalled()
    expect(mocks.transport).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('returns the existing controller without starting it again', () => {
    const controller = getBaseController()
    expect(getBaseControllerIfRunning()).toBe(controller)
    expect(getBaseControllerIfRunning()).toBe(controller)
    expect(mocks.start).toHaveBeenCalledOnce()
  })
})

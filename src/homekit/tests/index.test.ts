import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const status = {
    running: false,
    pincode: null as string | null,
    setupId: null,
    setupURI: null,
    username: null,
    pairedControllers: [] as string[],
  }
  return {
    startBridge: vi.fn(async () => {
      status.running = true
      status.pincode = '123-45-678'
    }),
    stopBridge: vi.fn(async () => { status.running = false }),
    unpairAll: vi.fn(async () => { /* no-op */ }),
    regenerate: vi.fn(async () => ({ username: 'aa', pincode: 'bb', setupId: 'cc' })),
    getStatus: vi.fn(() => status),
    getDacMonitor: vi.fn(async () => ({ id: 'monitor' })),
    enabled: { value: true },
    dbThrows: { value: false },
    status,
  }
})

vi.mock('../bridge', () => ({
  startBridge: m.startBridge,
  stopBridge: m.stopBridge,
  unpairAll: m.unpairAll,
  regenerate: m.regenerate,
  getStatus: m.getStatus,
}))

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getDacMonitor: m.getDacMonitor,
}))

vi.mock('@/src/db', () => ({
  db: {
    select: () => {
      if (m.dbThrows.value) throw new Error('db down')
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ homekitEnabled: m.enabled.value ? 1 : 0 }]),
          }),
        }),
      }
    },
  },
}))

vi.mock('@/src/db/schema', () => ({
  deviceSettings: { id: {}, homekitEnabled: {} },
}))

describe('homekit lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules()
    m.startBridge.mockClear()
    m.stopBridge.mockClear()
    m.unpairAll.mockClear()
    m.regenerate.mockClear()
    m.getDacMonitor.mockClear()
    m.enabled.value = true
    m.dbThrows.value = false
    m.status.running = false
  })
  afterEach(() => {
    // Drain serializer between cases by re-importing fresh module.
  })

  it('startHomeKitIfEnabled is a no-op when flag is false', async () => {
    m.enabled.value = false
    const mod = await import('../index')
    await mod.startHomeKitIfEnabled()
    expect(m.startBridge).not.toHaveBeenCalled()
  })

  it('startHomeKitIfEnabled starts the bridge when flag is true', async () => {
    const mod = await import('../index')
    await mod.startHomeKitIfEnabled()
    expect(m.startBridge).toHaveBeenCalledTimes(1)
    expect(m.getDacMonitor).toHaveBeenCalledTimes(1)
  })

  it('readEnabled tolerates db errors and returns false', async () => {
    m.dbThrows.value = true
    const mod = await import('../index')
    await mod.startHomeKitIfEnabled()
    expect(m.startBridge).not.toHaveBeenCalled()
  })

  it('enable() is idempotent within the same module instance', async () => {
    const mod = await import('../index')
    await mod.enable()
    await mod.enable()
    expect(m.startBridge).toHaveBeenCalledTimes(1)
  })

  it('disable() stops bridge once started, then is idempotent', async () => {
    const mod = await import('../index')
    await mod.enable()
    await mod.disable()
    await mod.disable()
    expect(m.stopBridge).toHaveBeenCalledTimes(1)
  })

  it('shutdownHomeKit is a thin wrapper for disable()', async () => {
    const mod = await import('../index')
    await mod.enable()
    await mod.shutdownHomeKit()
    expect(m.stopBridge).toHaveBeenCalledTimes(1)
  })

  it('status() proxies bridge.getStatus()', async () => {
    const mod = await import('../index')
    expect(mod.status()).toBe(m.status)
    expect(m.getStatus).toHaveBeenCalled()
  })

  it('unpair() clears pairings and re-publishes when enabled', async () => {
    const mod = await import('../index')
    await mod.enable()
    m.startBridge.mockClear()
    await mod.unpair()
    expect(m.unpairAll).toHaveBeenCalledTimes(1)
    expect(m.startBridge).toHaveBeenCalledTimes(1)
  })

  it('unpair() does not re-publish when flag is off', async () => {
    const mod = await import('../index')
    await mod.enable()
    m.startBridge.mockClear()
    m.enabled.value = false
    await mod.unpair()
    expect(m.unpairAll).toHaveBeenCalledTimes(1)
    expect(m.startBridge).not.toHaveBeenCalled()
  })

  it('regeneratePairing() rotates identity, restarts bridge, and returns status', async () => {
    const mod = await import('../index')
    await mod.enable()
    m.startBridge.mockClear()
    const out = await mod.regeneratePairing()
    expect(m.regenerate).toHaveBeenCalledTimes(1)
    expect(m.startBridge).toHaveBeenCalledTimes(1)
    expect(out).toBe(m.status)
  })

  it('regeneratePairing() skips restart when flag is off', async () => {
    const mod = await import('../index')
    await mod.enable()
    m.startBridge.mockClear()
    m.enabled.value = false
    await mod.regeneratePairing()
    expect(m.startBridge).not.toHaveBeenCalled()
  })

  it('serializes overlapping enable() calls — only one startBridge', async () => {
    const mod = await import('../index')
    await Promise.all([mod.enable(), mod.enable(), mod.enable()])
    expect(m.startBridge).toHaveBeenCalledTimes(1)
  })

  it('serializes a stopBridge → startBridge cycle when disable then enable race', async () => {
    const mod = await import('../index')
    await mod.enable()
    await Promise.all([mod.disable(), mod.enable()])
    expect(m.stopBridge).toHaveBeenCalledTimes(1)
    expect(m.startBridge).toHaveBeenCalledTimes(2)
  })
})

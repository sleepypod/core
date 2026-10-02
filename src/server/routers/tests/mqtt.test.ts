/**
 * Tests for the MQTT router — getSettings shape, updateSettings field
 * discrimination + fire-and-forget restart, getStatus / testConnection
 * passthrough. The bridge module is fully mocked so no real socket is opened.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mocks for the bridge — the router calls these and we need to
// observe arguments / return values per test.
const bridgeMock = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  testConnection: vi.fn(),
  getBridgeStatus: vi.fn(),
  startMqttBridge: vi.fn(),
  shutdownMqttBridge: vi.fn(),
}))

// Hoisted DB mock — we capture the `set(updates)` argument from
// db.update(deviceSettings).set(...).where(...). The setSpy is typed via the
// generic so `mock.calls[N][0]` is `Record<string, unknown>` at the call sites.
const dbMock = vi.hoisted(() => {
  const setSpy = vi.fn<(updates: Record<string, unknown>) => { where: ReturnType<typeof vi.fn> }>(
    () => ({ where: vi.fn(async () => undefined) }),
  )
  const update = vi.fn(() => ({ set: setSpy }))
  return { update, setSpy }
})

vi.mock('@/src/streaming/mqttBridge', () => bridgeMock)

vi.mock('@/src/db', () => ({
  db: { update: dbMock.update },
  biometricsDb: {},
}))

const { mqttRouter } = await import('@/src/server/routers/mqtt')

const caller = mqttRouter.createCaller({})

beforeEach(() => {
  bridgeMock.resolveConfig.mockReset()
  bridgeMock.testConnection.mockReset()
  bridgeMock.getBridgeStatus.mockReset()
  bridgeMock.startMqttBridge.mockReset().mockResolvedValue(undefined)
  bridgeMock.shutdownMqttBridge.mockReset().mockResolvedValue(undefined)
  dbMock.update.mockClear()
  dbMock.setSpy.mockClear()
})

describe('mqtt.getSettings', () => {
  it('returns the flat shape with a single sources map', async () => {
    bridgeMock.resolveConfig.mockResolvedValue({
      config: {
        enabled: true,
        url: 'mqtt://broker:1883',
        username: 'u',
        password: 'p',
        topicPrefix: 'sp',
        haDiscovery: true,
        tlsEnabled: false,
        tlsInsecure: false,
      },
      sources: {
        enabled: 'db',
        url: 'db',
        username: 'env',
        password: 'db',
        topicPrefix: 'default',
        haDiscovery: 'default',
        tlsEnabled: 'default',
        tlsInsecure: 'default',
      },
    })

    const result = await caller.getSettings({})

    // Flat shape — top-level fields are the resolved config minus password
    // (replaced by passwordIsSet) and minus tlsInsecure (router-internal).
    expect(result).toEqual({
      enabled: true,
      url: 'mqtt://broker:1883',
      username: 'u',
      passwordIsSet: true,
      topicPrefix: 'sp',
      haDiscovery: true,
      tlsEnabled: false,
      sources: {
        enabled: 'db',
        url: 'db',
        username: 'env',
        password: 'db',
        topicPrefix: 'default',
        haDiscovery: 'default',
        tlsEnabled: 'default',
      },
    })
    // The router never leaks the password field itself.
    expect(result).not.toHaveProperty('password')
  })

  it('passwordIsSet is false and source is "default" when password is null', async () => {
    bridgeMock.resolveConfig.mockResolvedValue({
      config: {
        enabled: false, url: null, username: null, password: null,
        topicPrefix: 'sp', haDiscovery: true, tlsEnabled: false, tlsInsecure: false,
      },
      // resolveConfig may report password source as 'env' if MQTT_PASSWORD was
      // checked; the router collapses absent passwords to 'default' so the UI
      // doesn't claim the value came from somewhere it didn't.
      sources: {
        enabled: 'default', url: 'default', username: 'default', password: 'env',
        topicPrefix: 'default', haDiscovery: 'default', tlsEnabled: 'default', tlsInsecure: 'default',
      },
    })

    const result = await caller.getSettings({})

    expect(result.passwordIsSet).toBe(false)
    expect(result.sources.password).toBe('default')
  })

  it('passwordIsSet is false when password resolves to an empty string', async () => {
    bridgeMock.resolveConfig.mockResolvedValue({
      config: {
        enabled: false, url: null, username: null, password: '',
        topicPrefix: 'sp', haDiscovery: true, tlsEnabled: false, tlsInsecure: false,
      },
      sources: {
        enabled: 'default', url: 'default', username: 'default', password: 'db',
        topicPrefix: 'default', haDiscovery: 'default', tlsEnabled: 'default', tlsInsecure: 'default',
      },
    })

    const result = await caller.getSettings({})

    expect(result.passwordIsSet).toBe(false)
    expect(result.sources.password).toBe('default')
  })

  it('passwordIsSet is true and password source is preserved when a password is present', async () => {
    bridgeMock.resolveConfig.mockResolvedValue({
      config: {
        enabled: false, url: null, username: null, password: 'secret',
        topicPrefix: 'sp', haDiscovery: true, tlsEnabled: false, tlsInsecure: false,
      },
      sources: {
        enabled: 'default', url: 'default', username: 'default', password: 'env',
        topicPrefix: 'default', haDiscovery: 'default', tlsEnabled: 'default', tlsInsecure: 'default',
      },
    })

    const result = await caller.getSettings({})

    expect(result.passwordIsSet).toBe(true)
    expect(result.sources.password).toBe('env')
  })
})

describe('mqtt.updateSettings — field discrimination', () => {
  it('only writes fields present in the input — undefined keys are left untouched', async () => {
    await caller.updateSettings({ url: 'mqtt://broker:1883' })

    expect(dbMock.setSpy).toHaveBeenCalledTimes(1)
    const updates = dbMock.setSpy.mock.calls[0][0]

    expect(updates).toHaveProperty('mqttUrl', 'mqtt://broker:1883')
    expect(updates).toHaveProperty('updatedAt')
    expect(updates.updatedAt).toBeInstanceOf(Date)

    // Every other mqtt* column must be absent — undefined keys leave stored
    // values alone, matching ADR 0019's PATCH semantics.
    expect(updates).not.toHaveProperty('mqttEnabled')
    expect(updates).not.toHaveProperty('mqttUsername')
    expect(updates).not.toHaveProperty('mqttPassword')
    expect(updates).not.toHaveProperty('mqttTopicPrefix')
    expect(updates).not.toHaveProperty('mqttHaDiscovery')
    expect(updates).not.toHaveProperty('mqttTlsEnabled')
  })

  it('null clears a field (password → mqttPassword: null)', async () => {
    await caller.updateSettings({ password: null })

    const updates = dbMock.setSpy.mock.calls[0][0]
    expect(updates).toHaveProperty('mqttPassword', null)
  })

  it('null clears a boolean field (enabled → mqttEnabled: null)', async () => {
    await caller.updateSettings({ enabled: null })

    const updates = dbMock.setSpy.mock.calls[0][0]
    expect(updates).toHaveProperty('mqttEnabled', null)
  })

  it('writes every field when each is present in the input', async () => {
    await caller.updateSettings({
      enabled: true,
      url: 'mqtt://broker:1883',
      username: 'u',
      password: 'p',
      topicPrefix: 'sp',
      haDiscovery: false,
      tlsEnabled: true,
    })

    const updates = dbMock.setSpy.mock.calls[0][0]
    expect(updates).toMatchObject({
      mqttEnabled: true,
      mqttUrl: 'mqtt://broker:1883',
      mqttUsername: 'u',
      mqttPassword: 'p',
      mqttTopicPrefix: 'sp',
      mqttHaDiscovery: false,
      mqttTlsEnabled: true,
    })
  })

  it('does not write mqttUrl when url is omitted', async () => {
    await caller.updateSettings({ enabled: true })
    const updates = dbMock.setSpy.mock.calls[0][0]
    expect(updates).toMatchObject({ mqttEnabled: true, updatedAt: expect.any(Date) })
    expect(updates).not.toHaveProperty('mqttUrl')
  })

  it('preserves haDiscovery=true rather than treating it as a nullish clear', async () => {
    await caller.updateSettings({ haDiscovery: true })
    expect(dbMock.setSpy.mock.calls[0][0]).toMatchObject({ mqttHaDiscovery: true })
  })

  it('wraps database Error details and does not restart the bridge', async () => {
    dbMock.setSpy.mockReturnValueOnce({
      where: vi.fn(async () => { throw new Error('sqlite read-only') }),
    })
    await expect(caller.updateSettings({ enabled: true })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update MQTT settings: sqlite read-only',
    })
    expect(bridgeMock.shutdownMqttBridge).not.toHaveBeenCalled()
  })

  it('uses Unknown error for a non-Error database rejection', async () => {
    dbMock.setSpy.mockReturnValueOnce({
      where: vi.fn(async () => { throw 'database offline' }),
    })
    await expect(caller.updateSettings({ enabled: false })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update MQTT settings: Unknown error',
    })
  })
})

describe('mqtt.updateSettings — restart is fire-and-forget', () => {
  it('mutation resolves before bridge restart awaits', async () => {
    // shutdownMqttBridge never resolves in this test — if the mutation awaited
    // it the call would hang forever. Resolution proves fire-and-forget.
    bridgeMock.shutdownMqttBridge.mockImplementation(() => new Promise(() => { /* never */ }))
    bridgeMock.startMqttBridge.mockImplementation(() => new Promise(() => { /* never */ }))

    const result = await caller.updateSettings({ enabled: true })

    expect(result).toEqual({ success: true })
    // Restart was kicked off but startMqttBridge can't have run yet because
    // shutdown is still pending — confirms shutdown→start is awaited
    // sequentially inside the IIFE while the mutation returned immediately.
    expect(bridgeMock.shutdownMqttBridge).toHaveBeenCalledTimes(1)
    expect(bridgeMock.startMqttBridge).not.toHaveBeenCalled()
  })

  it('mutation still resolves when the bridge restart throws', async () => {
    bridgeMock.shutdownMqttBridge.mockRejectedValue(new Error('shutdown boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await caller.updateSettings({ enabled: false })

    expect(result).toEqual({ success: true })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('[mqtt] restart after settings update failed:', 'shutdown boom')
    })
    warn.mockRestore()
  })

  it('logs a non-Error start failure after shutdown completes', async () => {
    bridgeMock.startMqttBridge.mockRejectedValueOnce({ refused: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(caller.updateSettings({ enabled: true })).resolves.toEqual({ success: true })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('[mqtt] restart after settings update failed:', { refused: true })
    })
    expect(bridgeMock.shutdownMqttBridge).toHaveBeenCalledOnce()
    expect(bridgeMock.startMqttBridge).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('mqtt.getStatus', () => {
  it('passes through getBridgeStatus()', async () => {
    bridgeMock.getBridgeStatus.mockReturnValue({
      runState: 'connected',
      connected: true,
      lastError: null,
      deviceId: 'sleepypod-test',
      topicPrefix: 'sp',
      messagesPublished: 17,
      lastPublishAt: '2026-04-01T00:00:00.000Z',
    })

    const result = await caller.getStatus({})

    expect(bridgeMock.getBridgeStatus).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      runState: 'connected',
      connected: true,
      lastError: null,
      deviceId: 'sleepypod-test',
      topicPrefix: 'sp',
      messagesPublished: 17,
      lastPublishAt: '2026-04-01T00:00:00.000Z',
    })
  })
})

describe('mqtt.testConnection', () => {
  it('passes input through to bridge.testConnection and returns its result', async () => {
    bridgeMock.testConnection.mockResolvedValue({ ok: true })

    const result = await caller.testConnection({
      url: 'mqtt://broker:1883',
      username: 'u',
      password: 'p',
      tlsEnabled: true,
    })

    expect(result).toEqual({ ok: true })
    expect(bridgeMock.testConnection).toHaveBeenCalledTimes(1)
    expect(bridgeMock.testConnection).toHaveBeenCalledWith({
      url: 'mqtt://broker:1883',
      username: 'u',
      password: 'p',
      tlsEnabled: true,
    })
  })

  it('normalises optional fields — missing username/password become null, tlsEnabled defaults to false', async () => {
    bridgeMock.testConnection.mockResolvedValue({ ok: false, error: 'connect timeout' })

    const result = await caller.testConnection({ url: 'mqtt://broker:1883' })

    expect(result).toEqual({ ok: false, error: 'connect timeout' })
    expect(bridgeMock.testConnection).toHaveBeenCalledWith({
      url: 'mqtt://broker:1883',
      username: null,
      password: null,
      tlsEnabled: false,
    })
  })
})

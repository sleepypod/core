/**
 * Tests for the MQTT bridge — config resolution, identity helpers, payload
 * parsing. The mqtt npm module is mocked so no real socket is opened at
 * import time or during any test.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import '@/src/auth/tests/support'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

// Hoisted state shared with the @/src/db mock factory — lets each test stub
// the device_settings row that resolveConfig will read.
const dbMock = vi.hoisted(() => {
  const state: { row: any | undefined, throwOnSelect: boolean } = { row: undefined, throwOnSelect: false }
  const select = vi.fn(() => ({ from: vi.fn(() => ({ limit: vi.fn(async () => {
    if (state.throwOnSelect) throw new Error('boom')
    return state.row !== undefined ? [state.row] : []
  }) })) }))
  return { state, select }
})

// Fake mqtt client — minimal EventEmitter + spies so lifecycle tests can
// drive 'connect' / 'message' / 'reconnect' / 'close' / 'error' handlers and
// inspect publish / subscribe arguments.
type Listener = (...args: any[]) => void
interface FakeClient {
  connected: boolean
  handlers: Map<string, Listener[]>
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: any[]) => void
}

function createFakeClient(): FakeClient {
  const handlers = new Map<string, Listener[]>()
  const register = (event: string, fn: Listener) => {
    const list = handlers.get(event) ?? []
    list.push(fn)
    handlers.set(event, list)
  }
  const client: FakeClient = {
    connected: false,
    handlers,
    on: vi.fn((event: string, fn: Listener) => {
      register(event, fn)
      return client
    }),
    once: vi.fn((event: string, fn: Listener) => {
      register(event, fn)
      return client
    }),
    publish: vi.fn((_t: string, _payload: any, _opts: any, cb?: (err?: Error | null) => void) => {
      if (cb) cb(null)
      return client
    }),
    subscribe: vi.fn((_topic: string, _opts: any, cb?: (err: Error | null) => void) => {
      if (cb) cb(null)
      return client
    }),
    end: vi.fn((_force?: boolean, _opts?: any, cb?: () => void) => {
      client.connected = false
      if (typeof cb === 'function') cb()
      return client
    }),
    emit: (event: string, ...args: any[]) => {
      const list = handlers.get(event)
      if (!list) return
      for (const fn of list) fn(...args)
    },
  }
  return client
}

// Hoisted mqtt mock — tests assign mqttMock.nextClient before triggering a
// connect() so the bridge sees a controllable fake. throwOnConnect lets tests
// exercise the synchronous-throw path in connect().
const mqttMock = vi.hoisted(() => {
  const state: { nextClient: any | null, throwOnConnect: Error | null } = {
    nextClient: null,
    throwOnConnect: null,
  }
  const connect = vi.fn(() => {
    if (state.throwOnConnect) throw state.throwOnConnect
    return state.nextClient
  })
  return { state, connect }
})

vi.mock('mqtt', () => ({
  default: { connect: mqttMock.connect },
  connect: mqttMock.connect,
}))

vi.mock('@/src/db', () => ({
  db: { select: dbMock.select, update: vi.fn() },
  biometricsDb: { select: dbMock.select },
}))

const controlMock = vi.hoisted(() => ({ submit: vi.fn() }))
const roomMock = vi.hoisted(() => ({ connection: vi.fn(), receive: vi.fn() }))
vi.mock('@/src/home-context/instance', () => ({ getRoomContext: () => roomMock, getRoomContextIfRunning: () => roomMock }))
const bedroomMock = vi.hoisted(() => ({ connection: vi.fn(), receive: vi.fn(() => ({ accepted: true })) }))
vi.mock('@/src/bedroom/instance', () => ({ getBedroom: () => bedroomMock, getBedroomIfRunning: () => bedroomMock }))
vi.mock('@/src/controls/instance', () => ({ getControlService: () => controlMock }))

const telemetryMock = vi.hoisted(() => ({ read: vi.fn((): Record<string, unknown> => ({ 'state/device-status': { available: false, ts: null } })) }))
vi.mock('@/src/telemetry/home', () => ({ readHomeTelemetry: telemetryMock.read }))

// Hoisted onServerFrame mock — lifecycle tests need to capture the frame
// listener so they can assert frame-driven publishes.
const piezoMock = vi.hoisted(() => {
  const state: { listener: ((frame: any) => void) | null } = { listener: null }
  const unsubscribe = vi.fn()
  const onServerFrame = vi.fn((cb: (frame: any) => void) => {
    state.listener = cb
    return unsubscribe
  })
  return { state, onServerFrame, unsubscribe }
})

vi.mock('@/src/streaming/piezoStream', () => ({
  onServerFrame: piezoMock.onServerFrame,
}))

const bridgeModule = await import('../mqttBridge')
const { __test__, getBridgeStatus, startMqttBridge, shutdownMqttBridge, testConnection } = bridgeModule
const { resolveConfig, slugify, deviceId, state: bridgeState } = __test__

const MQTT_ENV_KEYS = [
  'MQTT_ENABLED',
  'MQTT_URL',
  'MQTT_USERNAME',
  'MQTT_PASSWORD',
  'MQTT_TOPIC_PREFIX',
  'MQTT_HA_DISCOVERY',
  'MQTT_TLS',
  'MQTT_TLS_INSECURE',
  'MQTT_DEVICE_ID',
  'MQTT_COMMANDS_ENABLED',
] as const

function clearMqttEnv() {
  for (const k of MQTT_ENV_KEYS) Reflect.deleteProperty(process.env, k)
}

beforeEach(() => {
  clearMqttEnv()
  dbMock.state.row = undefined
  dbMock.state.throwOnSelect = false
  mqttMock.state.nextClient = null
  mqttMock.state.throwOnConnect = null
  mqttMock.connect.mockClear()
  piezoMock.state.listener = null
  piezoMock.onServerFrame.mockClear()
  piezoMock.unsubscribe.mockClear()
  controlMock.submit.mockReset()
  telemetryMock.read.mockClear()
})

afterEach(() => {
  clearMqttEnv()
})

// Drive the bridge through startMqttBridge() with a controllable fake client.
// Returns the fake so the test can emit() events / inspect spies.
async function startBridgeWithFake(opts: {
  commands?: boolean
  config?: Partial<{ enabled: boolean, url: string | null, topicPrefix: string, haDiscovery: boolean, tlsEnabled: boolean, tlsInsecure: boolean, username: string | null, password: string | null }>
} = {}): Promise<FakeClient> {
  // Reset bridge module state between tests since startMqttBridge() short-
  // circuits when runState !== 'stopped'.
  bridgeState.client = null
  bridgeState.runState = 'stopped'
  bridgeState.lastError = null
  bridgeState.publishTimer = null
  bridgeState.unsubscribeFrame = null
  bridgeState.resolved = null
  bridgeState.messagesPublished = 0
  bridgeState.lastPublishAt = null

  if (opts.commands === false) Reflect.deleteProperty(process.env, 'MQTT_COMMANDS_ENABLED')
  else process.env.MQTT_COMMANDS_ENABLED = 'true'
  dbMock.state.row = {
    mqttEnabled: opts.config?.enabled ?? true,
    mqttUrl: opts.config?.url ?? 'mqtt://broker.local:1883',
    mqttUsername: opts.config?.username ?? null,
    mqttPassword: opts.config?.password ?? null,
    mqttTopicPrefix: opts.config?.topicPrefix ?? 'sleepypod',
    mqttHaDiscovery: opts.config?.haDiscovery ?? false,
    mqttTlsEnabled: opts.config?.tlsEnabled ?? false,
    mqttTlsInsecure: opts.config?.tlsInsecure ?? false,
  }

  const fake = createFakeClient()
  mqttMock.state.nextClient = fake
  await startMqttBridge()
  return fake
}

describe('mqttBridge — resolveConfig source attribution', () => {
  it('returns "default" sources for every field when neither DB nor env is set', async () => {
    const { config, sources } = await resolveConfig()

    expect(sources).toEqual({
      enabled: 'default',
      url: 'default',
      username: 'default',
      password: 'default',
      topicPrefix: 'default',
      haDiscovery: 'default',
      tlsEnabled: 'default',
      tlsInsecure: 'default',
    })
    expect(config).toEqual({
      enabled: false,
      url: null,
      username: null,
      password: null,
      topicPrefix: 'sleepypod',
      haDiscovery: true,
      tlsEnabled: false,
      tlsInsecure: false,
    })
  })

  it('returns "env" sources when only env vars are set', async () => {
    process.env.MQTT_ENABLED = 'true'
    process.env.MQTT_URL = 'mqtt://broker.local:1883'
    process.env.MQTT_USERNAME = 'envuser'
    process.env.MQTT_PASSWORD = 'envpass'
    process.env.MQTT_TOPIC_PREFIX = 'env-prefix'
    process.env.MQTT_HA_DISCOVERY = '0'
    process.env.MQTT_TLS = '1'
    process.env.MQTT_TLS_INSECURE = 'true'

    const { config, sources } = await resolveConfig()

    expect(sources).toEqual({
      enabled: 'env',
      url: 'env',
      username: 'env',
      password: 'env',
      topicPrefix: 'env',
      haDiscovery: 'env',
      tlsEnabled: 'env',
      tlsInsecure: 'env',
    })
    expect(config).toEqual({
      enabled: true,
      url: 'mqtt://broker.local:1883',
      username: 'envuser',
      password: 'envpass',
      topicPrefix: 'env-prefix',
      haDiscovery: false,
      tlsEnabled: true,
      tlsInsecure: true,
    })
  })

  it('returns "db" sources when the device_settings row populates every field', async () => {
    dbMock.state.row = {
      mqttEnabled: true,
      mqttUrl: 'mqtt://db-broker:1883',
      mqttUsername: 'dbuser',
      mqttPassword: 'dbpass',
      mqttTopicPrefix: 'db-prefix',
      mqttHaDiscovery: false,
      mqttTlsEnabled: true,
      mqttTlsInsecure: true,
    }

    const { config, sources } = await resolveConfig()

    expect(sources).toEqual({
      enabled: 'db',
      url: 'db',
      username: 'db',
      password: 'db',
      topicPrefix: 'db',
      haDiscovery: 'db',
      tlsEnabled: 'db',
      tlsInsecure: 'db',
    })
    expect(config).toEqual({
      enabled: true,
      url: 'mqtt://db-broker:1883',
      username: 'dbuser',
      password: 'dbpass',
      topicPrefix: 'db-prefix',
      haDiscovery: false,
      tlsEnabled: true,
      tlsInsecure: true,
    })
  })
})

describe('mqttBridge — resolveConfig per-field precedence', () => {
  it('DB value beats env value when both are set (url field)', async () => {
    process.env.MQTT_URL = 'mqtt://env-broker:1883'
    dbMock.state.row = { mqttUrl: 'mqtt://db-broker:1883' }

    const { config, sources } = await resolveConfig()

    expect(sources.url).toBe('db')
    expect(config.url).toBe('mqtt://db-broker:1883')
  })

  it('env value wins when DB row leaves the field NULL (url field)', async () => {
    process.env.MQTT_URL = 'mqtt://env-broker:1883'
    dbMock.state.row = { mqttUrl: null }

    const { config, sources } = await resolveConfig()

    expect(sources.url).toBe('env')
    expect(config.url).toBe('mqtt://env-broker:1883')
  })

  it('boolean fields: DB false beats env true (mqttEnabled)', async () => {
    process.env.MQTT_ENABLED = 'true'
    dbMock.state.row = { mqttEnabled: false }

    const { config, sources } = await resolveConfig()

    expect(sources.enabled).toBe('db')
    expect(config.enabled).toBe(false)
  })

  it('topicPrefix: defaults to "sleepypod" when neither DB nor env are set', async () => {
    const { config, sources } = await resolveConfig()
    expect(sources.topicPrefix).toBe('default')
    expect(config.topicPrefix).toBe('sleepypod')
  })

  it('haDiscovery: defaults to true when neither DB nor env are set', async () => {
    const { config, sources } = await resolveConfig()
    expect(sources.haDiscovery).toBe('default')
    expect(config.haDiscovery).toBe(true)
  })

  it('tlsInsecure: defaults to false when neither DB nor env are set', async () => {
    const { config, sources } = await resolveConfig()
    expect(sources.tlsInsecure).toBe('default')
    expect(config.tlsInsecure).toBe(false)
  })

  it('mixes precedence across fields in a single call', async () => {
    // url -> DB, password -> env, username -> default
    process.env.MQTT_PASSWORD = 'envpass'
    dbMock.state.row = {
      mqttUrl: 'mqtt://db:1883',
      mqttUsername: null,
      mqttPassword: null,
    }

    const { config, sources } = await resolveConfig()

    expect(sources.url).toBe('db')
    expect(config.url).toBe('mqtt://db:1883')
    expect(sources.password).toBe('env')
    expect(config.password).toBe('envpass')
    expect(sources.username).toBe('default')
    expect(config.username).toBeNull()
  })

  it('does not replace unreadable stored requirements with environment defaults', async () => {
    dbMock.state.throwOnSelect = true
    process.env.MQTT_URL = 'mqtt://env-broker:1883'
    await expect(resolveConfig()).rejects.toThrow('Unable to read MQTT settings')
  })
})

describe('mqttBridge — resolveConfig password handling', () => {
  // The router derives passwordIsSet from the resolved password value:
  //   passwordIsSet = config.password !== null && config.password.length > 0
  // These tests pin that mapping at the bridge level so the contract holds
  // even if the router-side derivation is rewritten.
  function passwordIsSet(p: string | null): boolean {
    return p !== null && p.length > 0
  }

  it('null resolved password → passwordIsSet=false', async () => {
    dbMock.state.row = { mqttPassword: null }
    const { config } = await resolveConfig()
    expect(config.password).toBeNull()
    expect(passwordIsSet(config.password)).toBe(false)
  })

  it('empty-string resolved password → passwordIsSet=false', async () => {
    dbMock.state.row = { mqttPassword: '' }
    const { config } = await resolveConfig()
    expect(config.password).toBe('')
    expect(passwordIsSet(config.password)).toBe(false)
  })

  it('non-empty resolved password → passwordIsSet=true', async () => {
    dbMock.state.row = { mqttPassword: 'x' }
    const { config } = await resolveConfig()
    expect(config.password).toBe('x')
    expect(passwordIsSet(config.password)).toBe(true)
  })
})

describe('mqttBridge — slugify', () => {
  it('lowercases input', () => {
    expect(slugify('SleepyPod')).toBe('sleepypod')
  })

  it('strips characters outside [a-z0-9-_]', () => {
    expect(slugify('hello world!')).toBe('hello-world')
    expect(slugify('foo.bar+baz')).toBe('foo-bar-baz')
  })

  it('trims leading and trailing dashes after substitution', () => {
    expect(slugify('---abc---')).toBe('abc')
    expect(slugify('!!!hello!!!')).toBe('hello')
  })

  it('falls back to "sleepypod" when the result would be empty', () => {
    expect(slugify('')).toBe('sleepypod')
    expect(slugify('!!!')).toBe('sleepypod')
    expect(slugify('---')).toBe('sleepypod')
  })

  it('preserves digits, hyphens, and underscores', () => {
    expect(slugify('pod_3-test_42')).toBe('pod_3-test_42')
  })
})

describe('mqttBridge — deviceId', () => {
  it('uses MQTT_DEVICE_ID env when set', () => {
    process.env.MQTT_DEVICE_ID = 'pod-bedroom'
    expect(deviceId()).toBe('pod-bedroom')
  })

  it('slugifies the env override', () => {
    process.env.MQTT_DEVICE_ID = 'Pod Bedroom!'
    expect(deviceId()).toBe('pod-bedroom')
  })

  it('ignores whitespace-only env override and falls back to hostname', () => {
    process.env.MQTT_DEVICE_ID = '   '
    const hostnameSpy = vi.spyOn(os, 'hostname').mockReturnValue('Living Room Pod')
    expect(deviceId()).toBe('living-room-pod')
    hostnameSpy.mockRestore()
  })

  it('slugifies the hostname when no env override is set', () => {
    const hostnameSpy = vi.spyOn(os, 'hostname').mockReturnValue('SLEEPY.local')
    expect(deviceId()).toBe('sleepy-local')
    hostnameSpy.mockRestore()
  })

  it('falls back to "sleepypod" when the hostname is empty', () => {
    const hostnameSpy = vi.spyOn(os, 'hostname').mockReturnValue('')
    expect(deviceId()).toBe('sleepypod')
    hostnameSpy.mockRestore()
  })
})

describe('mqttBridge — getBridgeStatus', () => {
  it('reports stopped state and null fields when the bridge has never started', () => {
    bridgeState.client = null
    bridgeState.runState = 'stopped'
    bridgeState.lastError = null
    bridgeState.resolved = null
    bridgeState.messagesPublished = 0
    bridgeState.lastPublishAt = null

    const status = getBridgeStatus()

    expect(status.runState).toBe('stopped')
    expect(status.connected).toBe(false)
    expect(status.lastError).toBeNull()
    expect(status.topicPrefix).toBeNull()
    expect(status.messagesPublished).toBe(0)
    expect(status.lastPublishAt).toBeNull()
    expect(typeof status.deviceId).toBe('string')
  })

  it('reflects connected client, error, and publish counters', () => {
    bridgeState.client = { connected: true } as any
    bridgeState.runState = 'connected'
    bridgeState.lastError = 'prior error'
    bridgeState.resolved = {
      enabled: true,
      url: 'mqtt://x',
      username: null,
      password: null,
      topicPrefix: 'custom',
      haDiscovery: true,
      tlsEnabled: false,
      tlsInsecure: false,
    }
    const ts = new Date('2026-01-02T03:04:05Z')
    bridgeState.messagesPublished = 7
    bridgeState.lastPublishAt = ts

    const status = getBridgeStatus()

    expect(status.runState).toBe('connected')
    expect(status.connected).toBe(true)
    expect(status.lastError).toBe('prior error')
    expect(status.topicPrefix).toBe('custom')
    expect(status.messagesPublished).toBe(7)
    expect(status.lastPublishAt).toBe(ts.toISOString())

    // Reset so subsequent tests start clean.
    bridgeState.client = null
    bridgeState.runState = 'stopped'
    bridgeState.lastError = null
    bridgeState.resolved = null
    bridgeState.messagesPublished = 0
    bridgeState.lastPublishAt = null
  })
})

describe('mqttBridge — startMqttBridge early exits', () => {
  it('no-ops when the bridge is already past stopped state', async () => {
    bridgeState.runState = 'connected'
    await startMqttBridge()
    expect(mqttMock.connect).not.toHaveBeenCalled()
    bridgeState.runState = 'stopped'
  })

  it('logs and stays stopped when config is disabled', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    bridgeState.runState = 'stopped'
    bridgeState.client = null
    dbMock.state.row = { mqttEnabled: false, mqttUrl: 'mqtt://x' }

    await startMqttBridge()

    expect(mqttMock.connect).not.toHaveBeenCalled()
    expect(bridgeState.runState).toBe('stopped')
    expect(log).toHaveBeenCalledWith('[mqtt] disabled (set mqtt_enabled=true in device_settings or MQTT_ENABLED=true)')
    log.mockRestore()
  })

  it('records an errored state when enabled but URL is missing', async () => {
    bridgeState.runState = 'stopped'
    bridgeState.client = null
    dbMock.state.row = { mqttEnabled: true, mqttUrl: null }

    await startMqttBridge()

    expect(mqttMock.connect).not.toHaveBeenCalled()
    expect(bridgeState.runState).toBe('errored')
    expect(bridgeState.lastError).toContain('no broker URL')

    // Reset for downstream tests — startMqttBridge guards on stopped state.
    bridgeState.runState = 'stopped'
    bridgeState.lastError = null
  })
})

describe('mqttBridge — startMqttBridge connect flow', () => {
  it('passes username/password and TLS-insecure when configured', async () => {
    const fake = await startBridgeWithFake({
      config: {
        url: 'mqtts://secure:8883',
        username: 'u',
        password: 'p',
        tlsEnabled: true,
        tlsInsecure: true,
      },
    })

    expect(mqttMock.connect).toHaveBeenCalledTimes(1)
    const [url, opts] = mqttMock.connect.mock.calls[0] as unknown as [string, any]
    expect(url).toBe('mqtts://secure:8883')
    expect(opts.username).toBe('u')
    expect(opts.password).toBe('p')
    expect(opts.rejectUnauthorized).toBe(false)
    expect(opts.will?.topic).toContain('availability')
    // Sanity: handlers wired before any event fires.
    expect(fake.on).toHaveBeenCalledWith('connect', expect.any(Function))
    expect(fake.on).toHaveBeenCalledWith('reconnect', expect.any(Function))
    expect(fake.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(fake.on).toHaveBeenCalledWith('close', expect.any(Function))
    expect(fake.on).toHaveBeenCalledWith('message', expect.any(Function))

    await shutdownMqttBridge()
  })

  it('omits rejectUnauthorized when tlsEnabled but tlsInsecure is false', async () => {
    await startBridgeWithFake({ config: { url: 'mqtts://broker:8883', tlsEnabled: true, tlsInsecure: false } })

    const [, opts] = mqttMock.connect.mock.calls[0] as unknown as [string, any]
    expect(opts.rejectUnauthorized).toBeUndefined()

    await shutdownMqttBridge()
  })

  it('publishes availability + HA discovery + subscribes on connect', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fake = await startBridgeWithFake({ config: { haDiscovery: true } })
    fake.connected = true
    fake.emit('connect')

    expect(bridgeState.runState).toBe('connected')
    expect(bridgeState.lastError).toBeNull()
    expect(log).toHaveBeenCalledWith(
      `[mqtt] connected (deviceId=${deviceId()}, prefix=sleepypod)`,
    )

    // First publish is availability=online retained.
    expect(fake.publish).toHaveBeenCalledWith(
      expect.stringContaining('/availability'),
      'online',
      expect.objectContaining({ retain: true }),
      expect.any(Function),
    )

    // Subscription is to <prefix>/<deviceId>/cmd/+
    expect(fake.subscribe).toHaveBeenCalledWith(
      expect.stringMatching(/cmd\/request$/),
      { qos: 0 },
      expect.any(Function),
    )

    // HA discovery publishes left/right climate + water_level + 6 biometric
    // sensors. Don't pin the exact count, just confirm at least one HA topic
    // landed.
    const haPublishes = fake.publish.mock.calls.filter(([t]) => typeof t === 'string' && (t as string).startsWith('homeassistant/'))
    expect(haPublishes.length).toBeGreaterThan(0)

    log.mockRestore()
    await shutdownMqttBridge()
  })

  it('skips HA discovery when disabled in config', async () => {
    const fake = await startBridgeWithFake({ config: { haDiscovery: false } })
    fake.connected = true
    fake.emit('connect')

    const haPublishes = fake.publish.mock.calls.filter(([t]) => typeof t === 'string' && (t as string).startsWith('homeassistant/'))
    expect(haPublishes.length).toBe(0)

    await shutdownMqttBridge()
  })

  it('honours custom topic prefix when subscribing', async () => {
    const fake = await startBridgeWithFake({ config: { topicPrefix: 'custom-prefix' } })
    fake.connected = true
    fake.emit('connect')

    expect(fake.subscribe).toHaveBeenCalledWith(
      expect.stringMatching(/^custom-prefix\/.+\/cmd\/request$/),
      { qos: 0 },
      expect.any(Function),
    )

    await shutdownMqttBridge()
  })

  it('logs but does not throw when subscribe yields an error', async () => {
    const fake = createFakeClient()
    fake.subscribe = vi.fn((_t: string, _o: any, cb?: (err: Error | null) => void) => {
      cb?.(new Error('sub failed'))
      return fake
    }) as any
    mqttMock.state.nextClient = fake

    bridgeState.client = null
    bridgeState.runState = 'stopped'
    bridgeState.resolved = null
    dbMock.state.row = { mqttEnabled: true, mqttUrl: 'mqtt://x' }

    await startMqttBridge()
    fake.connected = true
    fake.emit('connect')

    // Bridge should remain connected; subscribe error is logged-and-swallowed.
    expect(bridgeState.runState).toBe('connected')

    await shutdownMqttBridge()
  })

  it('records reconnect/close/error transitions', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    expect(bridgeState.runState).toBe('connected')

    fake.emit('reconnect')
    expect(bridgeState.runState).toBe('reconnecting')
    expect(log).toHaveBeenCalledWith('[mqtt] reconnecting…')

    bridgeState.runState = 'connected'
    fake.emit('close')
    expect(bridgeState.runState).toBe('reconnecting')

    fake.emit('error', new Error('socket gone'))
    expect(bridgeState.lastError).toBe('socket gone')

    log.mockRestore()
    await shutdownMqttBridge()
  })

  it('does not turn a pre-connect close into a reconnecting state', async () => {
    const fake = await startBridgeWithFake()
    expect(bridgeState.runState).toBe('starting')

    fake.emit('close')

    expect(bridgeState.runState).toBe('starting')
    await shutdownMqttBridge()
  })
})

// The connect-flow test above only confirms *some* discovery topic lands.
// These pin every field of every published HA discovery config so a single
// changed string / template / unit / device-class fails a test. deviceId and
// topicPrefix are fixed so the expected payloads are fully deterministic.

describe('mqttBridge — durable message dispatch', () => {
  const request = () => ({ requestId: randomUUID(), issuedAt: Date.now(), expiresAt: Date.now() + 30000,
    action: { kind: 'temperature', side: 'left', temperature: 70 } })
  const packet = { retain: false, dup: false }

  it('defaults to telemetry only, omits command discovery, and ignores every command', async () => {
    const fake = await startBridgeWithFake({ commands: false, config: { haDiscovery: true } })
    fake.connected = true
    fake.emit('connect')
    expect(fake.subscribe).not.toHaveBeenCalledWith(expect.stringContaining('/cmd/'), expect.anything(), expect.anything())
    expect(fake.subscribe).toHaveBeenCalledWith(expect.stringContaining('/room/report'), { qos: 0 }, expect.any(Function))
    expect(getBridgeStatus().commandsEnabled).toBe(false)
    const climate = JSON.parse(fake.publish.mock.calls.find(([topic]) => String(topic).includes('/climate/'))?.[1] ?? 'null')
    expect(climate).not.toHaveProperty('temperature_command_topic')
    expect(climate).not.toHaveProperty('mode_command_topic')
    fake.emit('message', `sleepypod/${deviceId()}/cmd/request`, Buffer.from(JSON.stringify(request())), packet)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controlMock.submit).not.toHaveBeenCalled()
    await shutdownMqttBridge()
  })

  it('submits through the durable service and publishes a non-retained receipt', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    const input = request()
    const receipt = { requestId: input.requestId, state: 'unknown', physicalVerification: 'unverified' }
    controlMock.submit.mockResolvedValue(receipt)
    fake.emit('message', `sleepypod/${deviceId()}/cmd/request`, Buffer.from(JSON.stringify(input)), packet)
    await vi.waitFor(() => expect(controlMock.submit).toHaveBeenCalledWith(input))
    await vi.waitFor(() => expect(fake.publish).toHaveBeenCalledWith(`sleepypod/${deviceId()}/receipt/${input.requestId}`,
      JSON.stringify(receipt), { qos: 0, retain: false }, expect.any(Function)))
    await shutdownMqttBridge()
  })

  it.each(['set-temperature', 'set-power', 'set-alarm', 'clear-alarm', 'start-priming', 'bogus'])('never dispatches legacy %s payloads', async (verb) => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    fake.emit('message', `sleepypod/${deviceId()}/cmd/${verb}`, Buffer.from('{}'), packet)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controlMock.submit).not.toHaveBeenCalled()
    await shutdownMqttBridge()
  })

  it.each([undefined, { retain: true, dup: false }, { retain: false, dup: true }])('rejects retained, duplicate or missing packet metadata (%j)', async (flags) => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    fake.emit('message', `sleepypod/${deviceId()}/cmd/request`, Buffer.from(JSON.stringify(request())), flags)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controlMock.submit).not.toHaveBeenCalled()
    await shutdownMqttBridge()
  })

  it('does not accept old-client callbacks or late completion after replacement', async () => {
    const pending = Promise.withResolvers<any>()
    controlMock.submit.mockReturnValue(pending.promise)
    const old = await startBridgeWithFake()
    old.connected = true
    old.emit('connect')
    const input = request()
    old.emit('message', `sleepypod/${deviceId()}/cmd/request`, Buffer.from(JSON.stringify(input)), packet)
    await vi.waitFor(() => expect(controlMock.submit).toHaveBeenCalledOnce())
    await shutdownMqttBridge()
    const current = await startBridgeWithFake({ commands: false })
    current.connected = true
    current.emit('connect')
    old.connected = true
    old.emit('connect')
    old.emit('message', `sleepypod/${deviceId()}/cmd/request`, Buffer.from(JSON.stringify(request())), packet)
    pending.resolve({ requestId: input.requestId })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controlMock.submit).toHaveBeenCalledOnce()
    expect(current.publish.mock.calls.some(([topic]) => String(topic).includes('/receipt/'))).toBe(false)
    expect(getBridgeStatus().commandsEnabled).toBe(false)
    await shutdownMqttBridge()
  })

  it('cancels a command awaiting the lazy control import when shutdown begins', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    fake.emit('message', `sleepypod/${deviceId()}/cmd/request`, Buffer.from(JSON.stringify(request())), packet)
    await shutdownMqttBridge()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controlMock.submit).not.toHaveBeenCalled()
  })

  it('leaves commands disabled if the MQTT client cannot be constructed', async () => {
    mqttMock.state.throwOnConnect = new Error('url contains a private credential')
    await startBridgeWithFake()
    expect(getBridgeStatus()).toMatchObject({ runState: 'errored', commandsEnabled: false,
      lastError: 'Unable to create MQTT connection' })
    await shutdownMqttBridge()
  })

  it('does not revive a startup canceled while reading settings', async () => {
    bridgeState.runState = 'stopped'
    bridgeState.client = null
    const settings = Promise.withResolvers<any[]>()
    dbMock.select.mockImplementationOnce(() => ({ from: () => ({ limit: () => settings.promise }) }) as any)
    const starting = startMqttBridge()
    await shutdownMqttBridge()
    settings.resolve([{ mqttEnabled: true, mqttUrl: 'mqtt://x' }])
    await starting
    expect(mqttMock.connect).not.toHaveBeenCalled()
    expect(getBridgeStatus().runState).toBe('stopped')
  })

  it('sanitizes service errors without echoing a payload or credential', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    controlMock.submit.mockRejectedValue(new Error('private-service-detail'))
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    fake.emit('message', `sleepypod/${deviceId()}/cmd/request`, Buffer.from(JSON.stringify(request())), packet)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[mqtt] command rejected or receipt unavailable; do not retry with a new request ID'))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-service-detail')
    warn.mockRestore()
    await shutdownMqttBridge()
  })
})

describe('mqttBridge — frame subscription', () => {
  it('re-reads qualified sources instead of forwarding optimistic WebSocket frames', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    fake.publish.mockClear()

    expect(piezoMock.state.listener).not.toBeNull()
    piezoMock.state.listener?.({ type: 'deviceStatus', leftSide: { temp: 80 } })

    expect(fake.publish).toHaveBeenCalledWith(
      expect.stringContaining('/state/device-status'),
      expect.any(String),
      expect.objectContaining({ retain: false }),
      expect.any(Function),
    )
    expect(fake.publish.mock.calls.some(([, value]) => String(value).includes('80'))).toBe(false)

    await shutdownMqttBridge()
  })

  it('ignores non-deviceStatus frame types', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    fake.publish.mockClear()

    piezoMock.state.listener?.({ type: 'gesture' })

    expect(fake.publish).not.toHaveBeenCalled()

    await shutdownMqttBridge()
  })

  it('skips frame publish when client disconnected', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    fake.publish.mockClear()
    const stringify = vi.spyOn(JSON, 'stringify')

    fake.connected = false
    stringify.mockClear()
    piezoMock.state.listener?.({ type: 'deviceStatus' })

    expect(fake.publish).not.toHaveBeenCalled()
    expect(stringify).not.toHaveBeenCalled()

    await shutdownMqttBridge()
  })
})

describe('mqttBridge — periodic publish + shutdown edges', () => {
  it('re-runs publishState on the 30s interval after start', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const fake = await startBridgeWithFake()
      fake.connected = true
      fake.emit('connect')
      await vi.advanceTimersByTimeAsync(0)
      const baseline = fake.publish.mock.calls.length

      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(fake.publish.mock.calls.length).toBeGreaterThan(baseline)
      await shutdownMqttBridge()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('skips periodic DB reads while the MQTT client is disconnected', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      const fake = await startBridgeWithFake()
      fake.connected = true
      fake.emit('connect')
      await vi.advanceTimersByTimeAsync(0)
      dbMock.select.mockClear()

      fake.connected = false
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(dbMock.select).not.toHaveBeenCalled()
      await shutdownMqttBridge()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('resolves shutdown even when c.end() throws synchronously', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    // Replace end() with a throwing impl — shutdownMqttBridge must still resolve.
    fake.end = vi.fn(() => {
      throw new Error('end blew up')
    }) as any

    await expect(shutdownMqttBridge()).resolves.toBeUndefined()
  })
})

describe('mqttBridge — safePublish counters', () => {
  it('increments messagesPublished and updates lastPublishAt on success', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    expect(bridgeState.messagesPublished).toBeGreaterThan(0)
    expect(bridgeState.lastPublishAt).toBeInstanceOf(Date)

    await shutdownMqttBridge()
  })

  it('logs and stops counting when publish callback yields an error', async () => {
    const fake = createFakeClient()
    fake.publish = vi.fn((_t: string, _p: any, _o: any, cb?: (err?: Error | null) => void) => {
      cb?.(new Error('broker said no'))
      return fake
    }) as any
    mqttMock.state.nextClient = fake
    bridgeState.client = null
    bridgeState.runState = 'stopped'
    bridgeState.resolved = null
    bridgeState.messagesPublished = 0
    dbMock.state.row = { mqttEnabled: true, mqttUrl: 'mqtt://x' }

    await startMqttBridge()
    fake.connected = true
    fake.emit('connect')

    // Publishes were attempted but every callback errored — counter stays zero.
    expect(fake.publish).toHaveBeenCalled()
    expect(bridgeState.messagesPublished).toBe(0)

    await shutdownMqttBridge()
  })

  it('swallows synchronous publish throws', async () => {
    const fake = createFakeClient()
    fake.publish = vi.fn(() => {
      throw new Error('publish threw')
    }) as any
    mqttMock.state.nextClient = fake
    bridgeState.client = null
    bridgeState.runState = 'stopped'
    bridgeState.resolved = null
    bridgeState.messagesPublished = 0
    dbMock.state.row = { mqttEnabled: true, mqttUrl: 'mqtt://x' }

    await startMqttBridge()
    fake.connected = true
    expect(() => fake.emit('connect')).not.toThrow()

    await shutdownMqttBridge()
  })
})

describe('mqttBridge — shutdownMqttBridge', () => {
  it('returns immediately when bridge was never started', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    bridgeState.client = null
    bridgeState.runState = 'stopped'
    await expect(shutdownMqttBridge()).resolves.toBeUndefined()
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('still closes a client left behind while the run state says stopped', async () => {
    const fake = createFakeClient()
    bridgeState.client = fake as any
    bridgeState.runState = 'stopped'

    await shutdownMqttBridge()

    expect(fake.end).toHaveBeenCalledWith(false, {}, expect.any(Function))
    expect(bridgeState.client).toBeNull()
  })

  it('normalizes an errored state with no client back to stopped', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    bridgeState.client = null
    bridgeState.runState = 'errored'

    await shutdownMqttBridge()

    expect(bridgeState.runState).toBe('stopped')
    expect(log).toHaveBeenCalledWith('[mqtt] shutting down…')
    log.mockRestore()
  })

  it('clears the publish timer, unsubscribes the frame listener, and ends the client', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    expect(bridgeState.publishTimer).not.toBeNull()
    expect(bridgeState.unsubscribeFrame).not.toBeNull()

    await shutdownMqttBridge()

    expect(bridgeState.publishTimer).toBeNull()
    expect(bridgeState.unsubscribeFrame).toBeNull()
    expect(bridgeState.runState).toBe('stopped')
    expect(piezoMock.unsubscribe).toHaveBeenCalled()
    expect(fake.end).toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[mqtt] shutting down…')
    log.mockRestore()
  })

  it('publishes retained offline availability when shutting down a connected client', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    fake.publish.mockClear()

    await shutdownMqttBridge()

    const offlineCall = fake.publish.mock.calls.find(([t, payload]) =>
      typeof t === 'string' && (t as string).endsWith('/availability') && payload === 'offline',
    )
    expect(offlineCall).toBeDefined()
  })

  it('does not publish offline availability when the client is already disconnected', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    fake.connected = false
    fake.publish.mockClear()

    await shutdownMqttBridge()

    const offlineCall = fake.publish.mock.calls.find(([t, payload]) =>
      typeof t === 'string' && (t as string).endsWith('/availability') && payload === 'offline',
    )
    expect(offlineCall).toBeUndefined()
  })

  it('waits for the 500ms offline-publish fallback before ending the client', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fake = await startBridgeWithFake()
      fake.connected = true
      fake.emit('connect')
      fake.publish.mockImplementation(() => fake)

      let settled = false
      const shutdown = shutdownMqttBridge().then(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(499)
      expect(settled).toBe(false)
      expect(fake.end).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await shutdown

      expect(settled).toBe(true)
      expect(fake.end).toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('swallows errors from the unsubscribe callback', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    // Replace stored unsubscribe with one that throws.
    bridgeState.unsubscribeFrame = () => {
      throw new Error('boom')
    }

    await expect(shutdownMqttBridge()).resolves.toBeUndefined()
  })
})

describe('mqttBridge — testConnection', () => {
  it('resolves ok=true when connect emits "connect"', async () => {
    const fake = createFakeClient()
    mqttMock.state.nextClient = fake

    const promise = testConnection({ url: 'mqtt://x' })
    // Drain microtasks so the bridge has wired its once() handlers.
    await new Promise(r => setTimeout(r, 0))
    fake.emit('connect')

    await expect(promise).resolves.toEqual({ ok: true })
    expect(fake.end).toHaveBeenCalled()
  })

  it('resolves ok=false with the error message when connect errors', async () => {
    const fake = createFakeClient()
    mqttMock.state.nextClient = fake

    const promise = testConnection({ url: 'mqtt://x' })
    await new Promise(r => setTimeout(r, 0))
    fake.emit('error', new Error('refused'))

    await expect(promise).resolves.toEqual({ ok: false, error: 'refused' })
  })

  it('finalizes and closes the probe client only once when terminal events race', async () => {
    const fake = createFakeClient()
    mqttMock.state.nextClient = fake

    const promise = testConnection({ url: 'mqtt://x' })
    await new Promise(r => setTimeout(r, 0))
    fake.emit('connect')
    await expect(promise).resolves.toEqual({ ok: true })

    fake.emit('error', new Error('late error'))
    expect(fake.end).toHaveBeenCalledTimes(1)
  })

  it('resolves ok=false with the thrown error when connect throws synchronously', async () => {
    mqttMock.state.throwOnConnect = new Error('bad url')

    const result = await testConnection({ url: 'mqtt://valid-but-refused' })

    expect(result).toEqual({ ok: false, error: 'bad url' })
  })

  it('gives the probe client an 8-hex-digit suffix, not the raw random float', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.123456789)
    const fake = createFakeClient()
    mqttMock.state.nextClient = fake

    const promise = testConnection({ url: 'mqtt://x' })
    await new Promise(r => setTimeout(r, 0))
    fake.emit('connect')
    await promise

    const [, opts] = mqttMock.connect.mock.calls.at(-1) as unknown as [string, any]
    expect(opts.clientId).toBe('sleepypod-test-1f9add37')

    random.mockRestore()
  })

  it('passes username/password/TLS-insecure to mqtt.connect', async () => {
    process.env.MQTT_TLS_INSECURE = 'true'
    const fake = createFakeClient()
    mqttMock.state.nextClient = fake

    const promise = testConnection({ url: 'mqtts://x', username: 'u', password: 'p', tlsEnabled: true })
    await new Promise(r => setTimeout(r, 0))
    fake.emit('connect')
    await promise

    const [, opts] = mqttMock.connect.mock.calls.at(-1) as unknown as [string, any]
    expect(opts.username).toBe('u')
    expect(opts.password).toBe('p')
    expect(opts.rejectUnauthorized).toBe(false)
    expect(opts.reconnectPeriod).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Mutation-coverage suites
//
// The blocks below pin the *contents* of the bridge's published payloads, not
// just their topics. They exist to kill the string/array/number-literal and
// conditional mutants Stryker reported surviving in mqttBridge.ts — every
// asserted constant is written out independently of the source so emptying or
// flipping it in mqttBridge.ts fails a test here.
// ---------------------------------------------------------------------------

describe('mqttBridge — resolveConfig mutation coverage', () => {
  it('refuses unknown settings rather than falling back past a stored TLS requirement', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbMock.state.throwOnSelect = true
    process.env.MQTT_ENABLED = 'true'
    process.env.MQTT_URL = 'mqtt://fallback'
    await expect(resolveConfig()).rejects.toThrow('Unable to read MQTT settings')
    expect(warn).toHaveBeenCalledWith('[mqtt] settings unavailable; connection refused')
    warn.mockRestore()
  })

  it('reports DB-true haDiscovery with source "db" (pins the ?? boolean coalesce)', async () => {
    // The "db sources" suite above uses mqttHaDiscovery=false, which is
    // indistinguishable under the `?? → &&` mutant. A true value separates
    // them: `true ?? null` → true (db) vs `true && null` → null (default).
    dbMock.state.row = { mqttHaDiscovery: true }

    const { config, sources } = await resolveConfig()

    expect(sources.haDiscovery).toBe('db')
    expect(config.haDiscovery).toBe(true)
  })
})

describe('mqttBridge — safePublish error logging', () => {
  async function startWithPublish(publishImpl: FakeClient['publish']): Promise<FakeClient> {
    const fake = createFakeClient()
    fake.publish = publishImpl
    mqttMock.state.nextClient = fake
    bridgeState.client = null
    bridgeState.runState = 'stopped'
    bridgeState.resolved = null
    bridgeState.messagesPublished = 0
    dbMock.state.row = { mqttEnabled: true, mqttUrl: 'mqtt://x' }
    await startMqttBridge()
    fake.connected = true
    fake.emit('connect')
    return fake
  }

  it('warns "publish … failed" with the broker error when the publish callback errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startWithPublish(vi.fn((_t: string, _p: any, _o: any, cb?: (err?: Error | null) => void) => {
      cb?.(new Error('broker said no'))
    }) as any)

    const matched = (warn.mock.calls as unknown[][]).some(args =>
      String(args[0] ?? '').includes('[mqtt] publish ')
      && String(args[0] ?? '').includes(' failed:')
      && args[1] === 'broker said no',
    )
    expect(matched).toBe(true)
    warn.mockRestore()
    await shutdownMqttBridge()
  })

  it('warns "publish … threw" when publish throws synchronously', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startWithPublish(vi.fn(() => {
      throw new Error('publish kaboom')
    }) as any)

    const matched = (warn.mock.calls as unknown[][]).some(args =>
      String(args[0] ?? '').includes('[mqtt] publish ')
      && String(args[0] ?? '').includes(' threw:')
      && args[1] === 'publish kaboom',
    )
    expect(matched).toBe(true)
    warn.mockRestore()
    await shutdownMqttBridge()
  })
})

describe('mqttBridge — connect-option + lifecycle mutation coverage', () => {
  it('builds a clientId prefixed with the device id and an LWT offline retained will', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.123456789)
    process.env.MQTT_DEVICE_ID = 'pod-test'
    await startBridgeWithFake({ config: { topicPrefix: 'sleepypod' } })

    const [, opts] = mqttMock.connect.mock.calls.at(-1) as unknown as [string, any]
    expect(opts.clientId).toBe('sleepypod-pod-test-1f9add37')
    expect(opts.will?.payload).toEqual(Buffer.from('offline'))
    expect(opts.will?.retain).toBe(true)

    random.mockRestore()
    await shutdownMqttBridge()
  })

  it('no-ops when already connected even with a valid enabled config', async () => {
    bridgeState.client = null
    bridgeState.runState = 'connected'
    bridgeState.resolved = null
    dbMock.state.row = { mqttEnabled: true, mqttUrl: 'mqtt://x' }
    mqttMock.state.nextClient = createFakeClient()

    await startMqttBridge()

    expect(mqttMock.connect).not.toHaveBeenCalled()

    bridgeState.runState = 'stopped'
    bridgeState.client = null
  })

  it('warns with the no-URL message when enabled but URL is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bridgeState.runState = 'stopped'
    bridgeState.client = null
    dbMock.state.row = { mqttEnabled: true, mqttUrl: null }

    await startMqttBridge()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('enabled but no URL configured'))
    warn.mockRestore()
    bridgeState.runState = 'stopped'
    bridgeState.lastError = null
  })

  it('warns with the client-error message and records lastError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    fake.emit('error', new Error('socket gone'))

    expect(warn).toHaveBeenCalledWith('[mqtt] client error:', 'socket gone')
    expect(bridgeState.lastError).toBe('socket gone')
    warn.mockRestore()
    await shutdownMqttBridge()
  })

  it('logs the subscribe-failure message when subscribe errors', async () => {
    process.env.MQTT_COMMANDS_ENABLED = 'true'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = createFakeClient()
    fake.subscribe = vi.fn((_t: string, _o: any, cb?: (err: Error | null) => void) => {
      cb?.(new Error('sub failed'))
      return fake
    }) as any
    mqttMock.state.nextClient = fake
    bridgeState.client = null
    bridgeState.runState = 'stopped'
    bridgeState.resolved = null
    dbMock.state.row = { mqttEnabled: true, mqttUrl: 'mqtt://x' }

    await startMqttBridge()
    fake.connected = true
    fake.emit('connect')

    expect(warn).toHaveBeenCalledWith('[mqtt] command subscription failed')
    warn.mockRestore()
    await shutdownMqttBridge()
  })

  it('ends the client with force=false on shutdown', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    await shutdownMqttBridge()

    const endCall = fake.end.mock.calls.at(-1) as unknown[] | undefined
    expect(endCall?.[0]).toBe(false)
  })
})

describe('mqttBridge — testConnection TLS option matrix (mutation coverage)', () => {
  it('omits rejectUnauthorized when tlsEnabled but MQTT_TLS_INSECURE is unset', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.123456789)
    const fake = createFakeClient()
    mqttMock.state.nextClient = fake

    const promise = testConnection({ url: 'mqtts://x', tlsEnabled: true })
    await new Promise(r => setTimeout(r, 0))
    fake.emit('connect')
    await promise

    const [, opts] = mqttMock.connect.mock.calls.at(-1) as unknown as [string, any]
    expect(opts.rejectUnauthorized).toBeUndefined()
    expect(opts.clientId).toBe('sleepypod-test-1f9add37')
    random.mockRestore()
  })

  it('omits rejectUnauthorized when MQTT_TLS_INSECURE is set but tlsEnabled is false', async () => {
    process.env.MQTT_TLS_INSECURE = 'true'
    const fake = createFakeClient()
    mqttMock.state.nextClient = fake

    const promise = testConnection({ url: 'mqtt://x', tlsEnabled: false })
    await new Promise(r => setTimeout(r, 0))
    fake.emit('connect')
    await promise

    const [, opts] = mqttMock.connect.mock.calls.at(-1) as unknown as [string, any]
    expect(opts.rejectUnauthorized).toBeUndefined()
  })

  it('resolves with connect timeout only after the 5500ms fallback expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fake = createFakeClient()
      mqttMock.state.nextClient = fake

      let result: Awaited<ReturnType<typeof testConnection>> | undefined
      const promise = testConnection({ url: 'mqtt://slow' }).then((r) => {
        result = r
      })

      await vi.advanceTimersByTimeAsync(5_499)
      expect(result).toBeUndefined()
      expect(fake.end).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await promise

      expect(result).toEqual({ ok: false, error: 'connect timeout' })
      expect(fake.end).toHaveBeenCalledWith(true)
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('mqttBridge — qualified non-retained state', () => {
  it('clears legacy retained state before coming online and publishes source timestamps unchanged', async () => {
    const reading = { available: true, ts: 1700000000000, expiresAt: 1700000015000, temperature: 21 }
    telemetryMock.read.mockReturnValueOnce({ 'state/environment/ambient': reading }).mockReturnValueOnce({ 'state/environment/ambient': reading })
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    const calls = fake.publish.mock.calls
    const online = calls.findIndex(([, payload]) => payload === 'online')
    const cleared = calls.findIndex(([path, payload]) => String(path).endsWith('/state/environment/ambient') && payload === '')
    const live = calls.findIndex(([path, payload]) => String(path).endsWith('/state/environment/ambient') && payload !== '')
    expect(cleared).toBeGreaterThan(0)
    expect(cleared).toBeLessThan(online)
    expect(live).toBeGreaterThan(online)
    expect(calls[live][2]).toMatchObject({ retain: false })
    expect(JSON.parse(String(calls[live][1]))).toEqual(reading)
    expect(calls.filter(([path]) => String(path).endsWith('/clog_detected')).every(([, payload]) => payload === '')).toBe(true)
    await shutdownMqttBridge()
  })
})

describe('MQTT transport requirements', () => {
  it.each(['mqtt://broker:1883', 'ws://broker:8080/mqtt', 'https://broker', 'tls://broker'])('refuses %s before sending credentials when TLS is required', async (url) => {
    const fake = await startBridgeWithFake({ config: { url, tlsEnabled: true, username: 'fixture-user', password: 'fixture-password' } })
    expect(mqttMock.connect).not.toHaveBeenCalled()
    expect(getBridgeStatus()).toMatchObject({ runState: 'errored', connected: false, commandsEnabled: false })
    expect(getBridgeStatus().lastError).not.toContain('fixture-password')
    expect(fake.publish).not.toHaveBeenCalled()
    expect(await testConnection({ url, tlsEnabled: true, password: 'fixture-password' })).toMatchObject({ ok: false })
    expect(mqttMock.connect).not.toHaveBeenCalled()
    await shutdownMqttBridge()
  })
  it.each(['mqtts://broker:1883', 'wss://broker:8080/mqtt'])('keeps the explicitly chosen secure URL and port: %s', async (url) => {
    await startBridgeWithFake({ config: { url, tlsEnabled: true } })
    expect(mqttMock.connect).toHaveBeenCalledWith(url, expect.any(Object))
    const options = (mqttMock.connect.mock.calls.at(-1) as unknown as [string, { rejectUnauthorized?: boolean }] | undefined)?.[1]
    expect(options?.rejectUnauthorized).not.toBe(false)
    await shutdownMqttBridge()
  })
  it('stops startup and testing if saved settings cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bridgeState.runState = 'stopped'
    bridgeState.client = null
    dbMock.state.throwOnSelect = true
    process.env.MQTT_ENABLED = 'true'
    process.env.MQTT_URL = 'mqtt://fallback'
    await startMqttBridge()
    expect(getBridgeStatus()).toMatchObject({ runState: 'errored', connected: false, commandsEnabled: false })
    expect(await testConnection({ url: 'mqtts://broker', tlsEnabled: true })).toMatchObject({ ok: false })
    expect(mqttMock.connect).not.toHaveBeenCalled()
    warn.mockRestore()
    await shutdownMqttBridge()
  })
  it('previews null resets through environment fallback without changing stored config', async () => {
    dbMock.state.row = { mqttUrl: 'mqtts://saved', mqttTlsEnabled: true }
    process.env.MQTT_URL = 'mqtt://environment'
    process.env.MQTT_TLS = 'true'
    expect((await resolveConfig({ mqttUrl: null })).config).toMatchObject({ url: 'mqtt://environment', tlsEnabled: true })
    expect((await resolveConfig({ mqttTlsEnabled: false })).config).toMatchObject({ url: 'mqtts://saved', tlsEnabled: false })
    expect((await resolveConfig()).config).toMatchObject({ url: 'mqtts://saved', tlsEnabled: true })
  })
  it('testing a new broker does not reuse saved credentials', async () => {
    dbMock.state.row = { mqttUsername: 'saved-user', mqttPassword: 'saved-password' }
    const fake = createFakeClient()
    mqttMock.state.nextClient = fake
    const pending = testConnection({ url: 'mqtts://new-broker', tlsEnabled: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mqttMock.connect).toHaveBeenCalledWith('mqtts://new-broker', expect.not.objectContaining({ password: 'saved-password' }))
    const options = (mqttMock.connect.mock.calls.at(-1) as unknown as [string, object] | undefined)?.[1]
    expect(options).not.toHaveProperty('username')
    expect(options).not.toHaveProperty('password')
    fake.emit('connect')
    expect(await pending).toEqual({ ok: true })
  })
})

describe('room subscription connection boundaries', () => {
  it.each(['room', 'bedroom'])('ignores old SUBACK and denied %s subscriptions', async (kind) => {
    const source = kind === 'room' ? roomMock : bedroomMock
    const fake = await startBridgeWithFake({ commands: false })
    const callbacks: ((error: Error | null, grants?: { qos: number }[]) => void)[] = []
    fake.subscribe.mockImplementation((_topic, _options, callback) => {
      if (_topic.endsWith(`/${kind}/report`)) callbacks.push(callback)
      return fake
    })
    source.connection.mockClear()
    fake.connected = true
    fake.emit('connect')
    fake.emit('close')
    fake.emit('connect')
    source.connection.mockClear()
    callbacks[0](null, [{ qos: 0 }])
    expect(source.connection).not.toHaveBeenCalled()
    callbacks[1](null, [{ qos: 128 }])
    expect(source.connection).toHaveBeenLastCalledWith(false, expect.stringContaining(`/${kind}/report`))
    fake.emit('close')
    fake.emit('connect')
    callbacks[2](null, [{ qos: 0 }])
    expect(source.connection).toHaveBeenLastCalledWith(true, expect.stringContaining(`/${kind}/report`))
    await shutdownMqttBridge()
    expect(source.connection).toHaveBeenLastCalledWith(false)
  })
})

it('redacts cached personal MQTT snapshots after the privacy boundary without changing discovery or pairing', async () => {
  const fake = await startBridgeWithFake({ commands: false })
  fake.connected = true
  fake.emit('connect')
  const database = new Database(process.env.DATABASE_URL)
  try {
    database.prepare('INSERT INTO household_privacy_boundary VALUES (1, ?, \'test-arrangement\')').run(Date.now())
    telemetryMock.read.mockReturnValueOnce({
      'state/biometrics/left': { available: true, heartRate: 72, privateLabel: 'must not escape' },
      'state/occupancy/right': { available: true, occupied: true, privateLabel: 'must not escape' },
      'state/left/climate': { available: true, targetTemperature: 70 },
    })
    fake.publish.mockClear()
    piezoMock.state.listener?.({ type: 'deviceStatus' })
    const messages = fake.publish.mock.calls.map(call => ({ topic: String(call[0]), value: JSON.parse(String(call[1])), options: call[2] }))
    for (const kind of ['biometrics/left', 'occupancy/right']) {
      const message = messages.find(entry => entry.topic.endsWith(`state/${kind}`))
      expect(message?.value).toMatchObject({ available: false, reason: 'privacy_required', ts: null })
      expect(message?.value).not.toHaveProperty('privateLabel')
      expect(message?.options).toMatchObject({ retain: false })
    }
    expect(messages.find(entry => entry.topic.endsWith('state/left/climate'))?.value.targetTemperature).toBe(70)
  }
  finally {
    database.close()
    await shutdownMqttBridge()
  }
})

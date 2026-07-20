/**
 * Tests for the MQTT bridge — config resolution, identity helpers, payload
 * parsing. The mqtt npm module is mocked so no real socket is opened at
 * import time or during any test.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

// Hoisted state shared with the @/src/db mock factory — lets each test stub
// the device_settings row that resolveConfig will read.
const dbMock = vi.hoisted(() => {
  const state: {
    row: any | undefined
    throwOnSelect: boolean
    biometricsRow: any | null
    deviceStateRows: any[]
    bedTempRow: any | null
    throwOnBedTemp: false | true | string
    throwOnDeviceState: false | true | string
    throwOnBiometrics: false | true | string
  } = {
    row: undefined,
    throwOnSelect: false,
    biometricsRow: null,
    deviceStateRows: [],
    bedTempRow: null,
    throwOnBedTemp: false,
    throwOnDeviceState: false,
    throwOnBiometrics: false,
  }
  // The bridge calls db.select() four ways:
  //   1. .from(deviceSettings).limit(1)         — resolveConfig
  //   2. .from(deviceState)                     — publishState (iterable of rows)
  //   3. .from(vitals).where(...).orderBy(...).limit(1) — biometrics fetch
  //   4. .from(bedTemp).orderBy(...).limit(1)   — ambient environment fetch
  // The mock returns a thenable from .from() so case 2 (await of the from()
  // result) iterates state.deviceStateRows; cases 1/3/4 chain through.
  const select = vi.fn(() => ({
    from: vi.fn(() => {
      const fromObj: any = {
        limit: vi.fn(async () => {
          if (state.throwOnSelect) throw new Error('boom')
          return state.row !== undefined ? [state.row] : []
        }),
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => {
              if (state.throwOnBiometrics !== false) {
                throw typeof state.throwOnBiometrics === 'string'
                  ? state.throwOnBiometrics
                  : new Error('biometrics boom')
              }
              return state.biometricsRow ? [state.biometricsRow] : []
            }),
          })),
        })),
        orderBy: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (state.throwOnBedTemp !== false) {
              throw typeof state.throwOnBedTemp === 'string'
                ? state.throwOnBedTemp
                : new Error('bed_temp boom')
            }
            return state.bedTempRow ? [state.bedTempRow] : []
          }),
        })),
        // Make `.from(deviceState)` itself awaitable so `for (const row of
        // sides)` after `await db.select().from(deviceState)` iterates rows.
        then: (resolve: (rows: any[]) => any, reject?: (err: unknown) => any) => {
          if (state.throwOnDeviceState !== false) {
            const err = typeof state.throwOnDeviceState === 'string'
              ? state.throwOnDeviceState
              : new Error('device_state boom')
            if (reject) return reject(err)
            throw err as Error
          }
          return resolve(state.deviceStateRows)
        },
      }
      return fromObj
    }),
  }))
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

// Hoisted device caller mock — lifecycle tests assert that messages route to
// the right tRPC procedure based on the topic verb.
const deviceMock = vi.hoisted(() => ({
  setTemperature: vi.fn(async () => undefined),
  setPower: vi.fn(async () => undefined),
  setAlarm: vi.fn(async () => undefined),
  clearAlarm: vi.fn(async () => undefined),
  startPriming: vi.fn(async () => undefined),
}))

// Stub the heavy app-router import — mqttBridge only needs createCaller({}) to
// resolve at module load. Lifecycle tests below additionally exercise command
// dispatch and so need real-looking spies.
vi.mock('@/src/server/routers/app', () => ({
  appRouter: { createCaller: () => ({ device: deviceMock }) },
}))

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

const dacMock = vi.hoisted(() => ({
  getLastStatus: vi.fn<() => any>(() => null),
  getDacMonitorIfRunning: vi.fn<() => any>(() => null),
}))

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getDacMonitorIfRunning: dacMock.getDacMonitorIfRunning,
}))

const bridgeModule = await import('../mqttBridge')
const { __test__, getBridgeStatus, startMqttBridge, shutdownMqttBridge, testConnection } = bridgeModule
const { resolveConfig, slugify, deviceId, parsePayload, state: bridgeState } = __test__

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
] as const

function clearMqttEnv() {
  for (const k of MQTT_ENV_KEYS) Reflect.deleteProperty(process.env, k)
}

beforeEach(() => {
  clearMqttEnv()
  dbMock.state.row = undefined
  dbMock.state.throwOnSelect = false
  dbMock.state.biometricsRow = null
  dbMock.state.deviceStateRows = []
  dbMock.state.bedTempRow = null
  dbMock.state.throwOnBedTemp = false
  dbMock.state.throwOnDeviceState = false
  dbMock.state.throwOnBiometrics = false
  mqttMock.state.nextClient = null
  mqttMock.state.throwOnConnect = null
  mqttMock.connect.mockClear()
  piezoMock.state.listener = null
  piezoMock.onServerFrame.mockClear()
  piezoMock.unsubscribe.mockClear()
  dacMock.getDacMonitorIfRunning.mockReset().mockReturnValue(null)
  dacMock.getLastStatus.mockReset().mockReturnValue(null)
  deviceMock.setTemperature.mockClear()
  deviceMock.setPower.mockClear()
  deviceMock.setAlarm.mockClear()
  deviceMock.clearAlarm.mockClear()
  deviceMock.startPriming.mockClear()
})

afterEach(() => {
  clearMqttEnv()
})

// Drive the bridge through startMqttBridge() with a controllable fake client.
// Returns the fake so the test can emit() events / inspect spies.
async function startBridgeWithFake(opts: {
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

  it('falls back to env / default when reading device_settings throws', async () => {
    dbMock.state.throwOnSelect = true
    process.env.MQTT_URL = 'mqtt://env-only:1883'

    const { config, sources } = await resolveConfig()

    expect(sources.url).toBe('env')
    expect(config.url).toBe('mqtt://env-only:1883')
    expect(sources.enabled).toBe('default')
    expect(config.enabled).toBe(false)
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

describe('mqttBridge — parsePayload', () => {
  it('parses a valid JSON object', () => {
    const buf = Buffer.from(JSON.stringify({ side: 'left', powered: true }))
    expect(parsePayload(buf)).toEqual({ side: 'left', powered: true })
  })

  it('returns {} for an empty buffer', () => {
    expect(parsePayload(Buffer.alloc(0))).toEqual({})
  })

  it('returns {} for whitespace-only payloads', () => {
    expect(parsePayload(Buffer.from('   \n  '))).toEqual({})
  })

  // A retained payload republished by some brokers carries a UTF-8 BOM, which
  // JSON.parse rejects but String.trim() strips — the trim is load-bearing.
  it('parses a payload wrapped in BOM / non-breaking whitespace', () => {
    expect(parsePayload(Buffer.from('﻿{"side":"left"} '))).toEqual({ side: 'left' })
  })

  it('returns {} for malformed JSON', () => {
    expect(parsePayload(Buffer.from('{not json'))).toEqual({})
    expect(parsePayload(Buffer.from('{"a":'))).toEqual({})
  })

  it('returns {} for JSON primitive values (string / number / boolean / null)', () => {
    expect(parsePayload(Buffer.from('"hello"'))).toEqual({})
    expect(parsePayload(Buffer.from('42'))).toEqual({})
    expect(parsePayload(Buffer.from('true'))).toEqual({})
    expect(parsePayload(Buffer.from('null'))).toEqual({})
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
    await startBridgeWithFake({ config: { tlsEnabled: true, tlsInsecure: false } })

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
      `[mqtt] connected to mqtt://broker.local:1883 (deviceId=${deviceId()}, prefix=sleepypod)`,
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
      expect.stringMatching(/cmd\/\+$/),
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
      expect.stringMatching(/^custom-prefix\/.+\/cmd\/\+$/),
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
describe('mqttBridge — HA discovery payload content', () => {
  const DEVICE = {
    identifiers: ['testpod'],
    name: 'Sleepypod testpod',
    manufacturer: 'Sleepypod',
    model: 'Pod',
  }
  const AVAILABILITY = 'sleepypod/testpod/availability'

  // Shared sensor shape; name + topic + template + unit/device_class vary per call.
  function sensorCfg(
    name: string,
    objectId: string,
    stateTopic: string,
    template: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      name,
      unique_id: `testpod_${objectId}`,
      availability_topic: AVAILABILITY,
      payload_available: 'online',
      payload_not_available: 'offline',
      state_topic: stateTopic,
      value_template: template,
      state_class: 'measurement',
      device: DEVICE,
      ...extra,
    }
  }

  function climateCfg(side: 'left' | 'right'): Record<string, unknown> {
    const label = side === 'left' ? 'Left' : 'Right'
    return {
      name: `${label} side`,
      unique_id: `testpod_${side}_climate`,
      availability_topic: AVAILABILITY,
      payload_available: 'online',
      payload_not_available: 'offline',
      current_temperature_topic: `sleepypod/testpod/state/${side}/climate`,
      current_temperature_template: '{{ value_json.currentTemperature }}',
      temperature_state_topic: `sleepypod/testpod/state/${side}/climate`,
      temperature_state_template: '{{ value_json.targetTemperature }}',
      mode_state_topic: `sleepypod/testpod/state/${side}/climate`,
      mode_state_template: '{{ value_json.mode }}',
      temperature_command_topic: 'sleepypod/testpod/cmd/set-temperature',
      temperature_command_template: `{ "side": "${side}", "temperature": {{ value | int }} }`,
      mode_command_topic: 'sleepypod/testpod/cmd/set-power',
      mode_command_template: `{ "side": "${side}", "powered": {{ "true" if value == "heat" else "false" }} }`,
      modes: ['off', 'heat'],
      min_temp: 55,
      max_temp: 110,
      temp_step: 1,
      temperature_unit: 'F',
      device: DEVICE,
    }
  }

  function binaryCfg(side: 'left' | 'right', kind: 'stall' | 'clog'): Record<string, unknown> {
    const label = side === 'left' ? 'Left' : 'Right'
    return {
      name: kind === 'stall' ? `${label} pump stall` : `${label} pump clog detected`,
      unique_id: `testpod_pump_${side}_${kind}`,
      availability_topic: AVAILABILITY,
      payload_available: 'online',
      payload_not_available: 'offline',
      state_topic: kind === 'stall'
        ? `sleepypod/testpod/pump/${side}/stall`
        : `sleepypod/testpod/pump/${side}/clog_detected`,
      payload_on: 'on',
      payload_off: 'off',
      device_class: 'problem',
      device: DEVICE,
    }
  }

  let configs: Map<string, Record<string, unknown>>

  beforeEach(async () => {
    process.env.MQTT_DEVICE_ID = 'testpod'
    const fake = await startBridgeWithFake({ config: { haDiscovery: true, topicPrefix: 'sleepypod' } })
    fake.connected = true
    fake.emit('connect')
    configs = new Map()
    for (const call of fake.publish.mock.calls) {
      const [t, payload] = call as [string, unknown]
      if (typeof t === 'string' && t.startsWith('homeassistant/') && typeof payload === 'string') {
        configs.set(t, JSON.parse(payload))
      }
    }
    await shutdownMqttBridge()
  })

  it.each(['left', 'right'] as const)('publishes the full %s climate config', (side) => {
    expect(configs.get(`homeassistant/climate/testpod/${side}/config`)).toEqual(climateCfg(side))
  })

  it('publishes the full water_level sensor config', () => {
    expect(configs.get('homeassistant/sensor/testpod/water_level/config')).toEqual(
      sensorCfg('Water level', 'water_level', 'sleepypod/testpod/state/water-level', '{{ value_json.level }}'),
    )
  })

  it('publishes the full ambient temperature + humidity sensor configs', () => {
    expect(configs.get('homeassistant/sensor/testpod/ambient_temperature/config')).toEqual(
      sensorCfg('Ambient temperature', 'ambient_temperature', 'sleepypod/testpod/state/environment/ambient',
        '{{ value_json.temperature }}', { unit_of_measurement: '°C', device_class: 'temperature' }),
    )
    expect(configs.get('homeassistant/sensor/testpod/ambient_humidity/config')).toEqual(
      sensorCfg('Ambient humidity', 'ambient_humidity', 'sleepypod/testpod/state/environment/ambient',
        '{{ value_json.humidity }}', { unit_of_measurement: '%', device_class: 'humidity' }),
    )
  })

  it.each(['left', 'right'] as const)('publishes the full %s pump rpm + loop-temp sensor configs', (side) => {
    const label = side === 'left' ? 'Left' : 'Right'
    expect(configs.get(`homeassistant/sensor/testpod/pump_${side}_rpm/config`)).toEqual(
      sensorCfg(`${label} pump RPM`, `pump_${side}_rpm`, `sleepypod/testpod/pump/${side}/rpm`,
        '{{ value_json.rpm }}', { unit_of_measurement: 'rpm' }),
    )
    expect(configs.get(`homeassistant/sensor/testpod/pump_${side}_loop_temp/config`)).toEqual(
      sensorCfg(`${label} pump loop temp`, `pump_${side}_loop_temp`, `sleepypod/testpod/pump/${side}/loop_temp_c`,
        '{{ value_json.temperature }}', { unit_of_measurement: '°C', device_class: 'temperature' }),
    )
  })

  it.each(['left', 'right'] as const)('publishes the full %s pump stall + clog binary-sensor configs', (side) => {
    expect(configs.get(`homeassistant/binary_sensor/testpod/pump_${side}_stall/config`)).toEqual(binaryCfg(side, 'stall'))
    expect(configs.get(`homeassistant/binary_sensor/testpod/pump_${side}_clog/config`)).toEqual(binaryCfg(side, 'clog'))
  })

  it.each(['left', 'right'] as const)('publishes the full %s biometric sensor configs', (side) => {
    const label = side === 'left' ? 'Left' : 'Right'
    const bioTopic = `sleepypod/testpod/state/biometrics/${side}`
    expect(configs.get(`homeassistant/sensor/testpod/${side}_heart_rate/config`)).toEqual(
      sensorCfg(`${label} heart rate`, `${side}_heart_rate`, bioTopic, '{{ value_json.heartRate }}', { unit_of_measurement: 'bpm' }),
    )
    expect(configs.get(`homeassistant/sensor/testpod/${side}_breathing_rate/config`)).toEqual(
      sensorCfg(`${label} breathing rate`, `${side}_breathing_rate`, bioTopic, '{{ value_json.breathingRate }}', { unit_of_measurement: 'br/min' }),
    )
    expect(configs.get(`homeassistant/sensor/testpod/${side}_hrv/config`)).toEqual(
      sensorCfg(`${label} HRV`, `${side}_hrv`, bioTopic, '{{ value_json.hrv }}', { unit_of_measurement: 'ms' }),
    )
  })

  it('attaches the shared device identity block to every published config', () => {
    expect(configs.size).toBeGreaterThan(0)
    for (const cfg of configs.values()) {
      expect(cfg.device).toEqual(DEVICE)
    }
  })
})

describe('mqttBridge — message dispatch', () => {
  it('routes set-temperature payload to caller.device.setTemperature', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    const cmdTopic = `sleepypod/${deviceId()}/cmd/set-temperature`
    fake.emit('message', cmdTopic, Buffer.from(JSON.stringify({ side: 'left', temperature: 70 })))

    await new Promise(r => setTimeout(r, 0))
    expect(deviceMock.setTemperature).toHaveBeenCalledWith({ side: 'left', temperature: 70 })

    await shutdownMqttBridge()
  })

  it('routes set-power, set-alarm, clear-alarm, start-priming verbs', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    const id = deviceId()
    fake.emit('message', `sleepypod/${id}/cmd/set-power`, Buffer.from(JSON.stringify({ side: 'left', powered: true })))
    await vi.waitFor(() => expect(deviceMock.setPower).toHaveBeenCalled())

    fake.emit('message', `sleepypod/${id}/cmd/set-alarm`, Buffer.from(JSON.stringify({ side: 'left' })))
    await vi.waitFor(() => expect(deviceMock.setAlarm).toHaveBeenCalled())

    fake.emit('message', `sleepypod/${id}/cmd/clear-alarm`, Buffer.from(JSON.stringify({ side: 'left' })))
    await vi.waitFor(() => expect(deviceMock.clearAlarm).toHaveBeenCalled())

    fake.emit('message', `sleepypod/${id}/cmd/start-priming`, Buffer.from(''))
    await vi.waitFor(() => expect(deviceMock.startPriming).toHaveBeenCalledWith({}))

    await shutdownMqttBridge()
  })

  it('ignores topics outside the cmd/ prefix', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    fake.emit('message', `sleepypod/${deviceId()}/state/device-status`, Buffer.from('{}'))

    await new Promise(r => setTimeout(r, 0))
    expect(deviceMock.setTemperature).not.toHaveBeenCalled()
    expect(deviceMock.setPower).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('[mqtt] unknown command verb:'),
    )

    warn.mockRestore()
    await shutdownMqttBridge()
  })

  it('logs unknown verbs without throwing', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    fake.emit('message', `sleepypod/${deviceId()}/cmd/unknown-verb`, Buffer.from('{}'))

    await new Promise(r => setTimeout(r, 0))
    expect(deviceMock.setTemperature).not.toHaveBeenCalled()

    await shutdownMqttBridge()
  })

  it('catches caller errors and logs without crashing the handler', async () => {
    deviceMock.setTemperature.mockRejectedValueOnce(new Error('zod rejected'))
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    fake.emit('message', `sleepypod/${deviceId()}/cmd/set-temperature`, Buffer.from('{}'))
    await new Promise(r => setTimeout(r, 0))

    expect(deviceMock.setTemperature).toHaveBeenCalled()

    await shutdownMqttBridge()
  })
})

describe('mqttBridge — frame subscription', () => {
  it('publishes deviceStatus frames as retained state', async () => {
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    fake.publish.mockClear()

    expect(piezoMock.state.listener).not.toBeNull()
    piezoMock.state.listener?.({ type: 'deviceStatus', leftSide: { temp: 80 } })

    expect(fake.publish).toHaveBeenCalledWith(
      expect.stringContaining('/state/device-status'),
      expect.any(String),
      expect.objectContaining({ retain: true }),
      expect.any(Function),
    )

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

describe('mqttBridge — ambient environment', () => {
  it('publishes HA discovery for ambient temperature and humidity sensors', async () => {
    const fake = await startBridgeWithFake({ config: { haDiscovery: true } })
    fake.connected = true
    fake.emit('connect')

    const topics = fake.publish.mock.calls.map(([t]) => t as string)
    const tempCfg = topics.find(t => t.endsWith('/ambient_temperature/config'))
    const humCfg = topics.find(t => t.endsWith('/ambient_humidity/config'))
    expect(tempCfg).toBeDefined()
    expect(humCfg).toBeDefined()

    // Confirm device_class + state_class fields are wired so HA renders the
    // right icons and enables long-term statistics.
    const tempPayloadCall = fake.publish.mock.calls.find(([t]) => typeof t === 'string' && (t as string).endsWith('/ambient_temperature/config'))
    const tempPayload = JSON.parse(tempPayloadCall?.[1] as string)
    expect(tempPayload.device_class).toBe('temperature')
    expect(tempPayload.state_class).toBe('measurement')
    expect(tempPayload.unit_of_measurement).toBe('°C')
    expect(tempPayload.state_topic).toMatch(/state\/environment\/ambient$/)

    const humPayloadCall = fake.publish.mock.calls.find(([t]) => typeof t === 'string' && (t as string).endsWith('/ambient_humidity/config'))
    const humPayload = JSON.parse(humPayloadCall?.[1] as string)
    expect(humPayload.device_class).toBe('humidity')
    expect(humPayload.state_class).toBe('measurement')
    expect(humPayload.unit_of_measurement).toBe('%')

    await shutdownMqttBridge()
  })

  it('converts centidegrees + centipercent into the published state payload', async () => {
    dbMock.state.bedTempRow = {
      timestamp: new Date('2026-05-01T12:00:00Z'),
      ambientTemp: 2150, // 21.5°C
      humidity: 4530, // 45.30%
    }
    const fake = await startBridgeWithFake({ config: { haDiscovery: false } })
    fake.connected = true
    fake.emit('connect')

    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const ambientCall = fake.publish.mock.calls.find(([t]) => typeof t === 'string' && (t as string).endsWith('/state/environment/ambient'))
    expect(ambientCall).toBeDefined()
    const payload = JSON.parse(ambientCall?.[1] as string)
    expect(payload.temperature).toBeCloseTo(21.5, 2)
    expect(payload.humidity).toBeCloseTo(45.3, 2)
    expect(payload.ts).toBe(new Date('2026-05-01T12:00:00Z').getTime())

    await shutdownMqttBridge()
  })

  it('publishes nulls when bed_temp columns are NULL', async () => {
    dbMock.state.bedTempRow = {
      timestamp: new Date('2026-05-01T12:00:00Z'),
      ambientTemp: null,
      humidity: null,
    }
    const fake = await startBridgeWithFake({ config: { haDiscovery: false } })
    fake.connected = true
    fake.emit('connect')

    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const ambientCall = fake.publish.mock.calls.find(([t]) => typeof t === 'string' && (t as string).endsWith('/state/environment/ambient'))
    const payload = JSON.parse(ambientCall?.[1] as string)
    expect(payload.temperature).toBeNull()
    expect(payload.humidity).toBeNull()

    await shutdownMqttBridge()
  })

  it('skips ambient publish when no bed_temp row exists yet', async () => {
    dbMock.state.bedTempRow = null
    const fake = await startBridgeWithFake({ config: { haDiscovery: false } })
    fake.connected = true
    fake.emit('connect')

    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const ambientCall = fake.publish.mock.calls.find(([t]) => typeof t === 'string' && (t as string).endsWith('/state/environment/ambient'))
    expect(ambientCall).toBeUndefined()

    await shutdownMqttBridge()
  })

  it('logs but does not throw when the bed_temp query fails', async () => {
    dbMock.state.throwOnBedTemp = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = await startBridgeWithFake({ config: { haDiscovery: false } })
    fake.connected = true
    fake.emit('connect')

    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    expect(warnSpy).toHaveBeenCalledWith(
      '[mqtt] ambient environment publish failed:',
      expect.stringContaining('bed_temp boom'),
    )
    warnSpy.mockRestore()

    await shutdownMqttBridge()
  })

  it('logs the raw value when a non-Error is thrown from the bed_temp query', async () => {
    dbMock.state.throwOnBedTemp = 'plain string boom'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = await startBridgeWithFake({ config: { haDiscovery: false } })
    fake.connected = true
    fake.emit('connect')

    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    expect(warnSpy).toHaveBeenCalledWith(
      '[mqtt] ambient environment publish failed:',
      'plain string boom',
    )
    warnSpy.mockRestore()

    await shutdownMqttBridge()
  })
})

describe('mqttBridge — publishState content', () => {
  it('publishes device-status, water-level, climate, and biometrics when data is present', async () => {
    dacMock.getDacMonitorIfRunning.mockReturnValue({
      getLastStatus: () => ({
        leftSide: { temp: 80 },
        rightSide: { temp: 82 },
        waterLevel: 'ok',
        isPriming: false,
        podVersion: '1.2.3',
      }),
    })
    dbMock.state.deviceStateRows = [
      {
        side: 'left',
        currentTemperature: 70,
        targetTemperature: 72,
        isPowered: true,
        isAlarmVibrating: false,
        waterLevel: 'ok',
        lastUpdated: new Date('2026-01-01T00:00:00Z'),
      },
    ]
    dbMock.state.biometricsRow = {
      side: 'left',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      heartRate: 60,
      hrv: 50,
      breathingRate: 14,
    }

    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    // Wait a tick for publishState() promise chain.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const topics = fake.publish.mock.calls.map(([t]) => t as string)
    expect(topics.some(t => t.endsWith('/state/device-status'))).toBe(true)
    expect(topics.some(t => t.endsWith('/state/water-level'))).toBe(true)
    expect(topics.some(t => t.endsWith('/state/left/climate'))).toBe(true)
    expect(topics.some(t => t.endsWith('/state/biometrics/left'))).toBe(true)

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

describe('mqttBridge — publishState DB failures', () => {
  it('does not report query failures when optional state tables have no rows yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbMock.state.biometricsRow = null
    dbMock.state.bedTempRow = null

    const fake = await startBridgeWithFake({ config: { haDiscovery: false } })
    fake.connected = true
    fake.emit('connect')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const unexpected = warn.mock.calls.filter((args) => {
      const message = String(args[0] ?? '')
      return message.includes('biometrics publish')
        || message.includes('ambient environment publish failed')
        || message.includes('pump rpm publish failed')
    })
    expect(unexpected).toEqual([])

    warn.mockRestore()
    await shutdownMqttBridge()
  })

  it('warns and continues when the device_state query throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbMock.state.throwOnDeviceState = true

    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[mqtt] device_state publish failed'),
      expect.anything(),
    )
    warn.mockRestore()
    await shutdownMqttBridge()
  })

  it('warns per-side when the biometrics query throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbMock.state.throwOnBiometrics = 'bio crash'

    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const warned = (warn.mock.calls as unknown[][]).filter(args =>
      String(args[0] ?? '').includes('biometrics publish'),
    )
    expect(warned.length).toBeGreaterThanOrEqual(1)
    warn.mockRestore()
    await shutdownMqttBridge()
  })

  it('logs the raw value when device_state query throws a non-Error', async () => {
    // Covers the `err instanceof Error ? err.message : err` non-Error arm.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbMock.state.throwOnDeviceState = 'ds-string-err'

    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const matched = (warn.mock.calls as unknown[][]).some(args =>
      String(args[0] ?? '').includes('[mqtt] device_state publish failed')
      && args[1] === 'ds-string-err',
    )
    expect(matched).toBe(true)
    warn.mockRestore()
    await shutdownMqttBridge()
  })

  it('logs Error.message when the biometrics query throws an Error instance', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbMock.state.throwOnBiometrics = true // throws new Error('biometrics boom')

    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const matched = (warn.mock.calls as unknown[][]).some(args =>
      String(args[0] ?? '').includes('biometrics publish')
      && args[1] === 'biometrics boom',
    )
    expect(matched).toBe(true)
    warn.mockRestore()
    await shutdownMqttBridge()
  })

  it('publishes null loop_temp_c when flow row has null flowrate', async () => {
    // Mock returns the same row for bedTemp & flowReadings (both use the
    // .orderBy().limit() chain). Carry both shapes so each publish picks
    // what it needs.
    dbMock.state.bedTempRow = {
      timestamp: new Date('2026-01-01T00:00:00Z'),
      ambientTemp: 2000,
      humidity: 5000,
      leftPumpRpm: 1900,
      rightPumpRpm: 1900,
      leftFlowrateCd: null,
      rightFlowrateCd: null,
    }

    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const loopTempLeft = fake.publish.mock.calls.find(([t]) =>
      String(t).endsWith('/pump/left/loop_temp_c'),
    )
    expect(loopTempLeft).toBeDefined()
    const payload = JSON.parse(String(loopTempLeft?.[1]))
    expect(payload.temperature).toBeNull()

    await shutdownMqttBridge()
  })

  it('publishes scaled loop_temp_c when flow row has numeric flowrate', async () => {
    dbMock.state.bedTempRow = {
      timestamp: new Date('2026-01-01T00:00:00Z'),
      ambientTemp: 2000,
      humidity: 5000,
      leftPumpRpm: 1900,
      rightPumpRpm: 1900,
      leftFlowrateCd: 2050, // 20.5°C
      rightFlowrateCd: 2150, // 21.5°C
    }

    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const loopTempLeft = fake.publish.mock.calls.find(([t]) =>
      String(t).endsWith('/pump/left/loop_temp_c'),
    )
    const loopTempRight = fake.publish.mock.calls.find(([t]) =>
      String(t).endsWith('/pump/right/loop_temp_c'),
    )
    expect(loopTempLeft).toBeDefined()
    expect(loopTempRight).toBeDefined()
    expect(JSON.parse(String(loopTempLeft?.[1])).temperature).toBeCloseTo(20.5, 2)
    expect(JSON.parse(String(loopTempRight?.[1])).temperature).toBeCloseTo(21.5, 2)

    await shutdownMqttBridge()
  })

  it('publishes pump stall as "on" when a notice is active', async () => {
    const { setPumpStallNotice, resetPumpStallNotifications } = await import('@/src/hardware/pumpStallNotification')
    resetPumpStallNotifications()
    setPumpStallNotice('left', { alertId: 1, trippedAt: 100, rpm: 50, restore: null })

    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const stallLeft = fake.publish.mock.calls.find(([t]) =>
      String(t).endsWith('/pump/left/stall'),
    )
    expect(stallLeft?.[1]).toBe('on')

    resetPumpStallNotifications()
    await shutdownMqttBridge()
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

    const result = await testConnection({ url: 'not-a-url' })

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
  it('warns with the device_settings fallback message when the row read throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbMock.state.throwOnSelect = true

    await resolveConfig()

    expect(warn).toHaveBeenCalledWith(
      '[mqtt] failed to read device_settings — falling back to env:',
      expect.anything(),
    )
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

describe('mqttBridge — HA discovery payload contents (mutation coverage)', () => {
  const ID = 'pod-test'
  const AVAIL = `sleepypod/${ID}/availability`
  const DEVICE = { identifiers: [ID], name: `Sleepypod ${ID}`, manufacturer: 'Sleepypod', model: 'Pod' }

  function sensorCfg(o: { name: string, unique_id: string, state_topic: string, value_template: string, unit?: string, device_class?: string }) {
    const cfg: Record<string, unknown> = {
      name: o.name,
      unique_id: o.unique_id,
      availability_topic: AVAIL,
      payload_available: 'online',
      payload_not_available: 'offline',
      state_topic: o.state_topic,
      value_template: o.value_template,
      state_class: 'measurement',
      device: DEVICE,
    }
    if (o.unit) cfg.unit_of_measurement = o.unit
    if (o.device_class) cfg.device_class = o.device_class
    return cfg
  }

  function binaryCfg(o: { name: string, unique_id: string, state_topic: string }) {
    return {
      name: o.name,
      unique_id: o.unique_id,
      availability_topic: AVAIL,
      payload_available: 'online',
      payload_not_available: 'offline',
      state_topic: o.state_topic,
      payload_on: 'on',
      payload_off: 'off',
      device_class: 'problem',
      device: DEVICE,
    }
  }

  function climateCfg(side: 'left' | 'right') {
    const Side = side === 'left' ? 'Left' : 'Right'
    const climateTopic = `sleepypod/${ID}/state/${side}/climate`
    return {
      name: `${Side} side`,
      unique_id: `${ID}_${side}_climate`,
      availability_topic: AVAIL,
      payload_available: 'online',
      payload_not_available: 'offline',
      current_temperature_topic: climateTopic,
      current_temperature_template: '{{ value_json.currentTemperature }}',
      temperature_state_topic: climateTopic,
      temperature_state_template: '{{ value_json.targetTemperature }}',
      mode_state_topic: climateTopic,
      mode_state_template: '{{ value_json.mode }}',
      temperature_command_topic: `sleepypod/${ID}/cmd/set-temperature`,
      temperature_command_template: `{ "side": "${side}", "temperature": {{ value | int }} }`,
      mode_command_topic: `sleepypod/${ID}/cmd/set-power`,
      mode_command_template: `{ "side": "${side}", "powered": {{ "true" if value == "heat" else "false" }} }`,
      modes: ['off', 'heat'],
      min_temp: 55,
      max_temp: 110,
      temp_step: 1,
      temperature_unit: 'F',
      device: DEVICE,
    }
  }

  it('publishes the full HA discovery config set with exact payloads', async () => {
    process.env.MQTT_DEVICE_ID = ID
    const fake = await startBridgeWithFake({ config: { haDiscovery: true, topicPrefix: 'sleepypod' } })
    fake.connected = true
    fake.emit('connect')
    await new Promise(r => setTimeout(r, 0))

    const got: Record<string, unknown> = {}
    for (const [t, payload] of fake.publish.mock.calls as [string, string][]) {
      if (typeof t === 'string' && t.startsWith('homeassistant/')) got[t] = JSON.parse(payload)
    }

    const expected: Record<string, unknown> = {
      [`homeassistant/climate/${ID}/left/config`]: climateCfg('left'),
      [`homeassistant/climate/${ID}/right/config`]: climateCfg('right'),
      [`homeassistant/sensor/${ID}/water_level/config`]: sensorCfg({
        name: 'Water level',
        unique_id: `${ID}_water_level`,
        state_topic: `sleepypod/${ID}/state/water-level`,
        value_template: '{{ value_json.level }}',
      }),
      [`homeassistant/sensor/${ID}/ambient_temperature/config`]: sensorCfg({
        name: 'Ambient temperature',
        unique_id: `${ID}_ambient_temperature`,
        state_topic: `sleepypod/${ID}/state/environment/ambient`,
        value_template: '{{ value_json.temperature }}',
        unit: '°C',
        device_class: 'temperature',
      }),
      [`homeassistant/sensor/${ID}/ambient_humidity/config`]: sensorCfg({
        name: 'Ambient humidity',
        unique_id: `${ID}_ambient_humidity`,
        state_topic: `sleepypod/${ID}/state/environment/ambient`,
        value_template: '{{ value_json.humidity }}',
        unit: '%',
        device_class: 'humidity',
      }),
    }

    for (const side of ['left', 'right'] as const) {
      const Side = side === 'left' ? 'Left' : 'Right'
      expected[`homeassistant/sensor/${ID}/pump_${side}_rpm/config`] = sensorCfg({
        name: `${Side} pump RPM`,
        unique_id: `${ID}_pump_${side}_rpm`,
        state_topic: `sleepypod/${ID}/pump/${side}/rpm`,
        value_template: '{{ value_json.rpm }}',
        unit: 'rpm',
      })
      expected[`homeassistant/sensor/${ID}/pump_${side}_loop_temp/config`] = sensorCfg({
        name: `${Side} pump loop temp`,
        unique_id: `${ID}_pump_${side}_loop_temp`,
        state_topic: `sleepypod/${ID}/pump/${side}/loop_temp_c`,
        value_template: '{{ value_json.temperature }}',
        unit: '°C',
        device_class: 'temperature',
      })
      expected[`homeassistant/binary_sensor/${ID}/pump_${side}_stall/config`] = binaryCfg({
        name: `${Side} pump stall`,
        unique_id: `${ID}_pump_${side}_stall`,
        state_topic: `sleepypod/${ID}/pump/${side}/stall`,
      })
      expected[`homeassistant/binary_sensor/${ID}/pump_${side}_clog/config`] = binaryCfg({
        name: `${Side} pump clog detected`,
        unique_id: `${ID}_pump_${side}_clog`,
        state_topic: `sleepypod/${ID}/pump/${side}/clog_detected`,
      })
      expected[`homeassistant/sensor/${ID}/${side}_heart_rate/config`] = sensorCfg({
        name: `${Side} heart rate`,
        unique_id: `${ID}_${side}_heart_rate`,
        state_topic: `sleepypod/${ID}/state/biometrics/${side}`,
        value_template: '{{ value_json.heartRate }}',
        unit: 'bpm',
      })
      expected[`homeassistant/sensor/${ID}/${side}_breathing_rate/config`] = sensorCfg({
        name: `${Side} breathing rate`,
        unique_id: `${ID}_${side}_breathing_rate`,
        state_topic: `sleepypod/${ID}/state/biometrics/${side}`,
        value_template: '{{ value_json.breathingRate }}',
        unit: 'br/min',
      })
      expected[`homeassistant/sensor/${ID}/${side}_hrv/config`] = sensorCfg({
        name: `${Side} HRV`,
        unique_id: `${ID}_${side}_hrv`,
        state_topic: `sleepypod/${ID}/state/biometrics/${side}`,
        value_template: '{{ value_json.hrv }}',
        unit: 'ms',
      })
    }

    expect(got).toEqual(expected)
    await shutdownMqttBridge()
  })
})

describe('mqttBridge — publishState payload contents (mutation coverage)', () => {
  const ID = 'pod-test'

  function setupData() {
    dacMock.getDacMonitorIfRunning.mockReturnValue({
      getLastStatus: () => ({
        leftSide: { temp: 80 },
        rightSide: { temp: 82 },
        waterLevel: 'ok',
        isPriming: false,
        podVersion: '1.2.3',
      }),
    })
    dbMock.state.deviceStateRows = [
      { side: 'left', currentTemperature: 70, targetTemperature: 72, isPowered: true, isAlarmVibrating: false, waterLevel: 'ok', lastUpdated: new Date('2026-01-01T00:00:00Z') },
      { side: 'right', currentTemperature: 68, targetTemperature: 66, isPowered: false, isAlarmVibrating: true, waterLevel: 'low', lastUpdated: new Date('2026-01-02T00:00:00Z') },
    ]
    dbMock.state.biometricsRow = { side: 'left', timestamp: new Date('2026-04-04T00:00:00Z'), heartRate: 60, hrv: 50, breathingRate: 14 }
    dbMock.state.bedTempRow = { timestamp: new Date('2026-03-03T00:00:00Z'), ambientTemp: 2000, humidity: 5000, leftPumpRpm: 1800, rightPumpRpm: 1900, leftFlowrateCd: 2050, rightFlowrateCd: 2150 }
  }

  async function capture(): Promise<{ fake: FakeClient, map: Record<string, string> }> {
    process.env.MQTT_DEVICE_ID = ID
    setupData()
    const fake = await startBridgeWithFake({ config: { haDiscovery: false, topicPrefix: 'sleepypod' } })
    fake.connected = true
    fake.emit('connect')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    const map: Record<string, string> = {}
    for (const [t, payload] of fake.publish.mock.calls as [string, string][]) {
      if (typeof t === 'string') map[t] = payload
    }
    return { fake, map }
  }

  it('device-status mirrors the DAC monitor status fields', async () => {
    const { map } = await capture()
    const payload = JSON.parse(map[`sleepypod/${ID}/state/device-status`])
    expect(payload).toMatchObject({
      leftSide: { temp: 80 },
      rightSide: { temp: 82 },
      waterLevel: 'ok',
      isPriming: false,
      podVersion: '1.2.3',
    })
    expect(typeof payload.ts).toBe('number')
    await shutdownMqttBridge()
  })

  it('water-level carries the DAC waterLevel', async () => {
    const { map } = await capture()
    const payload = JSON.parse(map[`sleepypod/${ID}/state/water-level`])
    expect(payload.level).toBe('ok')
    await shutdownMqttBridge()
  })

  it('per-side climate payload maps isPowered → mode heat/off', async () => {
    const { map } = await capture()
    expect(JSON.parse(map[`sleepypod/${ID}/state/left/climate`])).toEqual({
      ts: new Date('2026-01-01T00:00:00Z').getTime(),
      currentTemperature: 70,
      targetTemperature: 72,
      isPowered: true,
      isAlarmVibrating: false,
      mode: 'heat',
      waterLevel: 'ok',
    })
    expect(JSON.parse(map[`sleepypod/${ID}/state/right/climate`])).toEqual({
      ts: new Date('2026-01-02T00:00:00Z').getTime(),
      currentTemperature: 68,
      targetTemperature: 66,
      isPowered: false,
      isAlarmVibrating: true,
      mode: 'off',
      waterLevel: 'low',
    })
    await shutdownMqttBridge()
  })

  it('biometrics payload carries heartRate / hrv / breathingRate', async () => {
    const { map } = await capture()
    expect(JSON.parse(map[`sleepypod/${ID}/state/biometrics/left`])).toEqual({
      ts: new Date('2026-04-04T00:00:00Z').getTime(),
      heartRate: 60,
      hrv: 50,
      breathingRate: 14,
    })
    await shutdownMqttBridge()
  })

  it('pump rpm payloads carry per-side rpm; loop_temp_c is scaled by /100', async () => {
    const { map } = await capture()
    expect(JSON.parse(map[`sleepypod/${ID}/pump/left/rpm`])).toEqual({
      ts: new Date('2026-03-03T00:00:00Z').getTime(),
      rpm: 1800,
    })
    expect(JSON.parse(map[`sleepypod/${ID}/pump/right/rpm`])).toEqual({
      ts: new Date('2026-03-03T00:00:00Z').getTime(),
      rpm: 1900,
    })
    expect(JSON.parse(map[`sleepypod/${ID}/pump/left/loop_temp_c`]).temperature).toBeCloseTo(20.5, 2)
    expect(JSON.parse(map[`sleepypod/${ID}/pump/right/loop_temp_c`]).temperature).toBeCloseTo(21.5, 2)
    await shutdownMqttBridge()
  })

  it('pump stall + clog publish "off" when no stall notice is active', async () => {
    const { resetPumpStallNotifications } = await import('@/src/hardware/pumpStallNotification')
    resetPumpStallNotifications()
    const { map } = await capture()
    expect(map[`sleepypod/${ID}/pump/left/stall`]).toBe('off')
    expect(map[`sleepypod/${ID}/pump/right/stall`]).toBe('off')
    expect(map[`sleepypod/${ID}/pump/left/clog_detected`]).toBe('off')
    expect(map[`sleepypod/${ID}/pump/right/clog_detected`]).toBe('off')
    resetPumpStallNotifications()
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

    expect(warn).toHaveBeenCalledWith('[mqtt] subscribe cmd/* failed:', 'sub failed')
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

describe('mqttBridge — command-dispatch + error-log mutation coverage', () => {
  it('warns with the unknown-verb message for an unrecognised command', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    fake.emit('message', `sleepypod/${deviceId()}/cmd/bogus`, Buffer.from('{}'))
    await new Promise(r => setTimeout(r, 0))

    expect(warn).toHaveBeenCalledWith('[mqtt] unknown command verb: bogus')
    warn.mockRestore()
    await shutdownMqttBridge()
  })

  it('warns with the command-failed message when a handler rejects', async () => {
    deviceMock.setTemperature.mockRejectedValueOnce(new Error('zod nope'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = await startBridgeWithFake()
    fake.connected = true
    fake.emit('connect')

    fake.emit('message', `sleepypod/${deviceId()}/cmd/set-temperature`, Buffer.from('{}'))
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    expect(warn).toHaveBeenCalledWith('[mqtt] command set-temperature failed:', 'zod nope')
    warn.mockRestore()
    await shutdownMqttBridge()
  })

  it('warns with the pump-rpm-failure message when the flow query throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbMock.state.throwOnBedTemp = true

    const fake = await startBridgeWithFake({ config: { haDiscovery: false } })
    fake.connected = true
    fake.emit('connect')
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const matched = (warn.mock.calls as unknown[][]).some(args =>
      String(args[0] ?? '').includes('[mqtt] pump rpm publish failed')
      && String(args[1] ?? '').includes('bed_temp boom'),
    )
    expect(matched).toBe(true)
    warn.mockRestore()
    await shutdownMqttBridge()
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

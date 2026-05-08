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
  const state: { row: any | undefined, throwOnSelect: boolean } = {
    row: undefined,
    throwOnSelect: false,
  }
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      limit: vi.fn(async () => {
        if (state.throwOnSelect) throw new Error('boom')
        return state.row !== undefined ? [state.row] : []
      }),
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    })),
  }))
  return { state, select }
})

// The bridge imports `mqtt` at module load. The package is provided by the
// frontend agent's PR (sleepypod-core-28); on this branch it isn't installed
// yet. Mocking the import keeps the bridge loadable and guarantees no real
// connect() ever runs during tests.
vi.mock('mqtt', () => ({
  default: { connect: vi.fn() },
  connect: vi.fn(),
}))

vi.mock('@/src/db', () => ({
  db: { select: dbMock.select, update: vi.fn() },
  biometricsDb: { select: dbMock.select },
}))

// Stub the heavy app-router import — mqttBridge only needs createCaller({}) to
// resolve at module load. None of these tests exercise command dispatch.
vi.mock('@/src/server/routers/app', () => ({
  appRouter: { createCaller: () => ({ device: {} }) },
}))

vi.mock('@/src/streaming/piezoStream', () => ({
  onServerFrame: vi.fn(() => () => { /* unsubscribe */ }),
}))

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getDacMonitorIfRunning: vi.fn(() => null),
}))

const { __test__ } = await import('../mqttBridge')
const { resolveConfig, slugify, deviceId, parsePayload } = __test__

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
})

afterEach(() => {
  clearMqttEnv()
})

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

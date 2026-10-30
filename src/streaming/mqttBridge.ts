/**
 * MQTT bridge — exposes the Pod on a user-supplied MQTT broker so Home
 * Assistant (or any generic MQTT consumer) can read state and issue
 * commands without touching the tRPC HTTP API.
 *
 * Lifecycle (managed by instrumentation.ts):
 *   1. startMqttBridge()    — resolve config, connect, publish HA discovery,
 *                             start state-mirror loop, subscribe to cmd/*
 *   2. shutdownMqttBridge() — publish offline retained, end client cleanly
 *
 * Configuration precedence per field: device_settings row > MQTT_* env > default.
 * If the resolved row leaves both NULL the field falls back to env, and finally
 * to a fixed default. Sources are surfaced via getResolvedConfig() so the
 * Settings UI can show why a value is what it is.
 *
 * Topic layout (configurable prefix; default "sleepypod"):
 *   <prefix>/<device-id>/availability                — LWT (online | offline)
 *   <prefix>/<device-id>/state/device-status         — full deviceStatus mirror
 *   <prefix>/<device-id>/state/<side>/climate        — per-side temperature/mode
 *   <prefix>/<device-id>/state/water-level           — low | ok | unknown
 *   <prefix>/<device-id>/state/biometrics/<side>     — latest HR/HRV/BR summary
 *   <prefix>/<device-id>/state/environment/ambient   — ambient temp (°C) + humidity (%)
 *   <prefix>/<device-id>/cmd/request               — expiring v1 control request
 *   <prefix>/<device-id>/receipt/<request-id>      — non-retained control receipt
 *
 * Command reception requires MQTT_COMMANDS_ENABLED=true, broker topic ACLs and
 * the durable control service. Legacy unversioned actuator topics are ignored.
 */

import os from 'node:os'
import { getRoomContext, getRoomContextIfRunning } from '@/src/home-context/instance'
import { getBedroom, getBedroomIfRunning } from '@/src/bedroom/instance'
import { receiveBedroomMqtt } from '@/src/bedroom/mqtt'
import type { ControlRequest } from '@/src/controls/contract'
import { MqttCommandGateway, type MqttPacketFlags } from './mqttCommands'
import mqtt, { type IClientOptions, type IClientPublishOptions, type MqttClient } from 'mqtt'
import { db } from '@/src/db'
import { deviceSettings } from '@/src/db/schema'
import { onServerFrame } from './piezoStream'
import { readHomeTelemetry } from '@/src/telemetry/home'
import { homeDiscovery } from './mqttDiscovery'
import { mqttEndpointIssue } from './mqttEndpoint'
import { legacyPrivacyState } from '@/src/household/legacyPrivacy'

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

const DEFAULT_TOPIC_PREFIX = 'sleepypod'
const STATE_PUBLISH_INTERVAL_MS = 5_000
const RECONNECT_PERIOD_MS = 5_000
const CONNECT_TIMEOUT_MS = 10_000
const TEST_CONNECT_TIMEOUT_MS = 5_000
const CONFIG_UNAVAILABLE = 'Unable to read MQTT settings. No connection was started.'

export type ConfigSource = 'db' | 'env' | 'default'

export interface ResolvedMqttConfig {
  enabled: boolean
  url: string | null
  username: string | null
  password: string | null
  topicPrefix: string
  haDiscovery: boolean
  tlsEnabled: boolean
  tlsInsecure: boolean
}

export interface ResolvedMqttSources {
  enabled: ConfigSource
  url: ConfigSource
  username: ConfigSource
  password: ConfigSource
  topicPrefix: ConfigSource
  haDiscovery: ConfigSource
  tlsEnabled: ConfigSource
  tlsInsecure: ConfigSource
}

function envBool(value: string | undefined): boolean | null {
  if (value === undefined) return null
  return value === '1' || value.toLowerCase() === 'true'
}

export async function resolveConfig(overrides: Partial<typeof deviceSettings.$inferSelect> = {}): Promise<{
  config: ResolvedMqttConfig
  sources: ResolvedMqttSources
}> {
  let row: typeof deviceSettings.$inferSelect | undefined
  try {
    [row] = await db.select().from(deviceSettings).limit(1)
  }
  catch {
    // An unreadable DB is not an absent override: falling back could discard a stored TLS requirement.
    console.warn('[mqtt] settings unavailable; connection refused')
    throw new Error(CONFIG_UNAVAILABLE)
  }

  // Preview partial writes through the same DB > environment > default resolution as startup.
  const resolvedRow = { ...row, ...overrides }
  const envEnabled = envBool(process.env.MQTT_ENABLED)
  const envHaDiscovery = envBool(process.env.MQTT_HA_DISCOVERY)
  const envTls = envBool(process.env.MQTT_TLS)
  const envTlsInsecure = envBool(process.env.MQTT_TLS_INSECURE)

  const pick = <T>(dbVal: T | null | undefined, envVal: T | null, fallback: T): { value: T, source: ConfigSource } => {
    if (dbVal !== null && dbVal !== undefined) return { value: dbVal, source: 'db' }
    if (envVal !== null && envVal !== undefined) return { value: envVal, source: 'env' }
    return { value: fallback, source: 'default' }
  }

  const enabled = pick<boolean>(resolvedRow.mqttEnabled ?? null, envEnabled, false)
  const url = pick<string | null>(resolvedRow.mqttUrl ?? null, process.env.MQTT_URL ?? null, null)
  const username = pick<string | null>(resolvedRow.mqttUsername ?? null, process.env.MQTT_USERNAME ?? null, null)
  const password = pick<string | null>(resolvedRow.mqttPassword ?? null, process.env.MQTT_PASSWORD ?? null, null)
  const topicPrefix = pick<string>(resolvedRow.mqttTopicPrefix ?? null, process.env.MQTT_TOPIC_PREFIX ?? null, DEFAULT_TOPIC_PREFIX)
  const haDiscovery = pick<boolean>(resolvedRow.mqttHaDiscovery ?? null, envHaDiscovery, true)
  const tlsEnabled = pick<boolean>(resolvedRow.mqttTlsEnabled ?? null, envTls, false)
  const tlsInsecure = pick<boolean>(resolvedRow.mqttTlsInsecure ?? null, envTlsInsecure, false)

  return {
    config: {
      enabled: enabled.value,
      url: url.value,
      username: username.value,
      password: password.value,
      topicPrefix: topicPrefix.value,
      haDiscovery: haDiscovery.value,
      tlsEnabled: tlsEnabled.value,
      tlsInsecure: tlsInsecure.value,
    },
    sources: {
      enabled: enabled.source,
      url: url.source,
      username: username.source,
      password: password.source,
      topicPrefix: topicPrefix.source,
      haDiscovery: haDiscovery.source,
      tlsEnabled: tlsEnabled.source,
      tlsInsecure: tlsInsecure.source,
    },
  }
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

function deviceId(): string {
  const override = process.env.MQTT_DEVICE_ID
  if (override && override.trim().length > 0) return slugify(override)
  return slugify(os.hostname() || 'sleepypod')
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '') || 'sleepypod'
}

// ---------------------------------------------------------------------------
// Bridge state
// ---------------------------------------------------------------------------

type BridgeRunState = 'stopped' | 'starting' | 'connected' | 'reconnecting' | 'errored'

interface BridgeState {
  client: MqttClient | null
  runState: BridgeRunState
  lastError: string | null
  publishTimer: ReturnType<typeof setInterval> | null
  unsubscribeFrame: (() => void) | null
  resolved: ResolvedMqttConfig | null
  messagesPublished: number
  lastPublishAt: Date | null
  commandsEnabled: boolean
  generation: number
}

const globals = globalThis as typeof globalThis & { __sp_mqttBridge?: BridgeState }
const state: BridgeState = globals.__sp_mqttBridge ??= {
  client: null,
  runState: 'stopped',
  lastError: null,
  publishTimer: null,
  unsubscribeFrame: null,
  resolved: null,
  messagesPublished: 0,
  lastPublishAt: null,
  commandsEnabled: false,
  generation: 0,
}

export interface BridgeStatus {
  runState: BridgeRunState
  connected: boolean
  lastError: string | null
  deviceId: string
  topicPrefix: string | null
  messagesPublished: number
  lastPublishAt: string | null
  commandsEnabled: boolean
}

export function getBridgeStatus(): BridgeStatus {
  return {
    runState: state.runState,
    connected: state.client?.connected === true,
    lastError: state.lastError,
    deviceId: deviceId(),
    topicPrefix: state.resolved?.topicPrefix ?? null,
    messagesPublished: state.messagesPublished,
    lastPublishAt: state.lastPublishAt?.toISOString() ?? null,
    commandsEnabled: state.commandsEnabled,
  }
}

// ---------------------------------------------------------------------------
// Publishing helpers
// ---------------------------------------------------------------------------

const RETAINED_QOS_0: IClientPublishOptions = { qos: 0, retain: true }
const VOLATILE_QOS_0: IClientPublishOptions = { qos: 0, retain: false }

function topic(...parts: string[]): string {
  const prefix = state.resolved?.topicPrefix ?? DEFAULT_TOPIC_PREFIX
  return [prefix, deviceId(), ...parts].join('/')
}

function safePublish(t: string, payload: string | Buffer, opts: IClientPublishOptions): void {
  const c = state.client
  if (!c || !c.connected) return
  // Recheck at the output boundary even if a telemetry snapshot was collected
  // just before a separate worker committed the personal arrangement.
  const personalTopic = (['left', 'right'] as const).some(side =>
    t === topic('state', 'biometrics', side) || t === topic('state', 'occupancy', side))
  if (payload.length > 0 && personalTopic && legacyPrivacyState() !== 'legacy') {
    payload = JSON.stringify({ schemaVersion: 1, source: 'personal_privacy_boundary', available: false, ts: null, expiresAt: null,
      reason: 'privacy_required', heartRate: null, breathingRate: null, hrv: null, occupied: null, classification: null })
  }
  try {
    c.publish(t, payload, opts, (err?: Error | null) => {
      if (err) {
        console.warn(`[mqtt] publish ${t} failed:`, err.message)
        return
      }
      state.messagesPublished += 1
      state.lastPublishAt = new Date()
    })
  }
  catch (err) {
    console.warn(`[mqtt] publish ${t} threw:`, err instanceof Error ? err.message : err)
  }
}

// ---------------------------------------------------------------------------
// HA discovery
// ---------------------------------------------------------------------------

function publishHaDiscovery(): void {
  if (!state.resolved?.haDiscovery) return
  for (const [path, config] of homeDiscovery(deviceId(), topic(), state.commandsEnabled)) {
    safePublish(`${process.env.MQTT_HA_DISCOVERY_PREFIX || 'homeassistant'}/${path}`,
      config === null ? '' : JSON.stringify(config), RETAINED_QOS_0)
  }
}

// Live measurements are deliberately not retained: a subscriber restart must
// wait for fresh publication, not resurrect yesterday's retained observation.
function publishState(clearRetained = false): void {
  if (!state.client?.connected) return
  const readings = readHomeTelemetry()
  for (const [path, reading] of Object.entries(readings)) {
    if (clearRetained) safePublish(topic(path), '', RETAINED_QOS_0)
    else safePublish(topic(path), JSON.stringify(reading), VOLATILE_QOS_0)
  }
  if (clearRetained) {
    for (const side of ['left', 'right']) safePublish(topic('pump', side, 'clog_detected'), '', RETAINED_QOS_0)
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

// Lazy import avoids the router -> MQTT settings -> bridge initialization cycle.
async function submitControl(request: ControlRequest, current: () => boolean) {
  const { getControlService } = await import('@/src/controls/instance')
  if (!current()) throw new Error('command_connection_closed')
  return getControlService().submit(request)
}

// ---------------------------------------------------------------------------
// Test connection (used by tRPC mqtt.testConnection)
// ---------------------------------------------------------------------------

export interface TestConnectionInput {
  url: string
  username?: string | null
  password?: string | null
  tlsEnabled?: boolean
}

export interface TestConnectionResult {
  ok: boolean
  error?: string
}

export async function testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
  const issue = mqttEndpointIssue(input.url, input.tlsEnabled ?? false)
  if (issue) return { ok: false, error: issue }
  // Test connection resolves tlsInsecure through the same db-then-env
  // precedence as the running bridge (resolveConfig), so the "Test" button
  // surfaces the same cert-trust outcome — env-only reads disagreed with a
  // db-configured bridge. tlsEnabled on its own does not relax cert
  // verification — mqtt.js defaults to strict.
  let config: ResolvedMqttConfig
  try {
    ({ config } = await resolveConfig())
  }
  catch { return { ok: false, error: CONFIG_UNAVAILABLE } }
  const tlsInsecure = config.tlsInsecure
  return new Promise((resolve) => {
    let settled = false
    const finalize = (result: TestConnectionResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try {
        testClient.end(true)
      }
      catch { /* ignore */ }
      resolve(result)
    }

    const opts: IClientOptions = {
      reconnectPeriod: 0,
      connectTimeout: TEST_CONNECT_TIMEOUT_MS,
      clientId: `sleepypod-test-${Math.random().toString(16).slice(2, 10)}`,
      ...(input.username ? { username: input.username } : {}),
      ...(input.password ? { password: input.password } : {}),
      ...(input.tlsEnabled && tlsInsecure ? { rejectUnauthorized: false } : {}),
    }

    let testClient: MqttClient
    try {
      testClient = mqtt.connect(input.url, opts)
    }
    catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      return
    }

    const timeout = setTimeout(() => finalize({ ok: false, error: 'connect timeout' }), TEST_CONNECT_TIMEOUT_MS + 500)
    testClient.once('connect', () => finalize({ ok: true }))
    testClient.once('error', (err: Error) => finalize({ ok: false, error: err.message }))
  })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startMqttBridge(): Promise<void> {
  if (state.runState !== 'stopped') return

  const generation = ++state.generation
  state.runState = 'starting'
  state.commandsEnabled = false
  state.lastError = null

  let config: ResolvedMqttConfig
  try {
    ({ config } = await resolveConfig())
  }
  catch {
    if (state.generation === generation) {
      state.runState = 'errored'
      state.lastError = CONFIG_UNAVAILABLE
    }
    return
  }
  if (state.generation !== generation) return
  state.resolved = config

  if (!config.enabled) {
    console.log('[mqtt] disabled (set mqtt_enabled=true in device_settings or MQTT_ENABLED=true)')
    state.runState = 'stopped'
    return
  }
  if (!config.url) {
    console.warn('[mqtt] enabled but no URL configured — set mqtt_url in device_settings or MQTT_URL')
    state.runState = 'errored'
    state.lastError = 'no broker URL configured'
    return
  }

  const issue = mqttEndpointIssue(config.url, config.tlsEnabled)
  if (issue) {
    state.runState = 'errored'
    state.lastError = issue
    return
  }

  const id = deviceId()
  const availabilityTopic = topic('availability')
  const opts: IClientOptions = {
    clientId: `sleepypod-${id}-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: RECONNECT_PERIOD_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    keepalive: 30,
    clean: true,
    resubscribe: false,
    will: {
      topic: availabilityTopic,
      payload: Buffer.from('offline'),
      qos: 0,
      retain: true,
    },
    ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password } : {}),
    // tlsEnabled on its own keeps mqtt.js default rejectUnauthorized:true.
    // Self-signed-cert deployments must opt in via mqttTlsInsecure /
    // MQTT_TLS_INSECURE — see ADR 0019.
    ...(config.tlsEnabled && config.tlsInsecure ? { rejectUnauthorized: false } : {}),
  }

  let client: MqttClient
  try {
    client = mqtt.connect(config.url, opts)
  }
  catch {
    state.runState = 'errored'
    state.lastError = 'Unable to create MQTT connection'
    return
  }
  state.client = client
  state.commandsEnabled = envBool(process.env.MQTT_COMMANDS_ENABLED) === true

  const current = () => state.client === client && state.generation === generation
  let connectionGeneration = 0
  const commands = new MqttCommandGateway(async (request) => {
    if (!current() || !client.connected || !state.commandsEnabled) throw new Error('command_connection_closed')
    return submitControl(request, () => current() && client.connected && state.commandsEnabled)
  })

  client.on('connect', () => {
    if (!current()) return
    const connection = ++connectionGeneration
    state.runState = 'connected'
    state.lastError = null
    console.log(`[mqtt] connected (deviceId=${id}, prefix=${config.topicPrefix})`)
    // Clear legacy retained measurements while still offline to avoid a stale
    // availability flash when upgrading or reconnecting an existing discovery.
    safePublish(availabilityTopic, 'offline', RETAINED_QOS_0)
    publishState(true)
    publishHaDiscovery()
    safePublish(availabilityTopic, 'online', RETAINED_QOS_0)
    // Room telemetry is independent of actuator permissions. The store checks
    // owner mappings and revision; a SUBACK is not proof of a sensor reading.
    client.subscribe(topic('room', 'report'), { qos: 0 }, (err, granted) => {
      if (!current() || !client.connected || connection !== connectionGeneration) return
      getRoomContext().connection(!err && granted?.some(item => item.qos !== 128) === true, topic('room', 'report'))
    })
    client.subscribe(topic('bedroom', 'report'), { qos: 0 }, (err, granted) => {
      if (!current() || !client.connected || connection !== connectionGeneration) return
      getBedroom().connection(!err && granted?.some(item => item.qos !== 128) === true, topic('bedroom', 'report'))
    })
    if (state.commandsEnabled) {
      client.subscribe(topic('cmd', 'request'), { qos: 0 }, (err: Error | null) => {
        if (err && current()) console.warn('[mqtt] command subscription failed')
      })
    }
    publishState()
  })

  client.on('reconnect', () => {
    if (!current()) return
    connectionGeneration++
    getRoomContext().connection(false)
    getBedroomIfRunning()?.connection(false)
    state.runState = 'reconnecting'
    console.log('[mqtt] reconnecting…')
  })

  client.on('error', (err: Error) => {
    if (!current()) return
    state.lastError = err.message
    console.warn('[mqtt] client error:', err.message)
  })

  client.on('close', () => {
    if (!current()) return
    connectionGeneration++
    getRoomContext().connection(false)
    getBedroomIfRunning()?.connection(false)
    if (state.runState === 'connected') state.runState = 'reconnecting'
  })

  client.on('message', (incomingTopic: string, payload: Buffer, packet: MqttPacketFlags) => {
    if (!current() || !client.connected) return
    if (incomingTopic === topic('bedroom', 'report')) {
      receiveBedroomMqtt(getBedroom(), payload, packet)
      return
    }
    if (incomingTopic === topic('room', 'report')) {
      try {
        getRoomContext().receive(payload, packet)
      }
      catch { console.warn('[mqtt] room input unavailable') }
      return
    }
    if (!state.commandsEnabled || incomingTopic !== topic('cmd', 'request')) return
    void commands.receive(payload, packet).then((receipt) => {
      if (current() && client.connected) {
        safePublish(topic('receipt', receipt.requestId), JSON.stringify(receipt), VOLATILE_QOS_0)
      }
    }).catch(() => {
      // Broker URLs, payloads and raw service errors may contain credentials.
      console.warn('[mqtt] command rejected or receipt unavailable; do not retry with a new request ID')
    })
  })

  state.publishTimer = setInterval(() => {
    if (current()) void publishState()
  }, STATE_PUBLISH_INTERVAL_MS)

  // React to live status frames so HA sees temperature changes immediately
  // rather than waiting for the periodic re-publish.
  state.unsubscribeFrame = onServerFrame((frame) => {
    if (!current() || frame.type !== 'deviceStatus') return
    if (!state.client?.connected) return
    // A WebSocket frame may contain optimistic overlays; re-read verified sources.
    publishState()
  })
}

export async function shutdownMqttBridge(): Promise<void> {
  getRoomContextIfRunning()?.connection(false)
  getBedroomIfRunning()?.connection(false)
  state.generation++
  state.commandsEnabled = false
  if (state.runState === 'stopped' && !state.client) return
  console.log('[mqtt] shutting down…')

  if (state.publishTimer) {
    clearInterval(state.publishTimer)
    state.publishTimer = null
  }
  if (state.unsubscribeFrame) {
    try {
      state.unsubscribeFrame()
    }
    catch { /* ignore */ }
    state.unsubscribeFrame = null
  }

  const c = state.client
  state.client = null
  state.runState = 'stopped'
  if (!c) return

  // Best-effort retained-offline so HA reflects the pod going down.
  try {
    if (c.connected) {
      await new Promise<void>((resolve) => {
        c.publish(topic('availability'), 'offline', RETAINED_QOS_0, () => resolve())
        setTimeout(resolve, VOLATILE_QOS_0.qos === 0 ? 500 : 1000)
      })
    }
  }
  catch { /* ignore */ }

  await new Promise<void>((resolve) => {
    try {
      c.end(false, {}, () => resolve())
      setTimeout(resolve, 1500)
    }
    catch {
      resolve()
    }
  })
}

// ---------------------------------------------------------------------------
// Internal hooks for unit tests
// ---------------------------------------------------------------------------

export const __test__ = {
  resolveConfig,
  deviceId,
  slugify,
  state,
}

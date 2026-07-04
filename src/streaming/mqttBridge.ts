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
 *   <prefix>/<device-id>/cmd/set-temperature         — JSON {side, temperature, duration?}
 *   <prefix>/<device-id>/cmd/set-power               — JSON {side, powered, temperature?}
 *   <prefix>/<device-id>/cmd/set-alarm               — JSON {side, vibrationIntensity, vibrationPattern, duration}
 *   <prefix>/<device-id>/cmd/clear-alarm             — JSON {side}
 *   <prefix>/<device-id>/cmd/start-priming           — JSON {} (or empty payload)
 *
 * Commands route through the existing tRPC procedures via createCaller, so the
 * Zod input schemas are the single source of truth for argument validation —
 * the bridge never reimplements business logic.
 *
 * TODO: depends on the `mqtt` npm package owned by sleepypod-core-28
 * (frontend agent). The @ts-ignore on the import resolves once that lands.
 */

import os from 'node:os'
import mqtt, { type IClientOptions, type IClientPublishOptions, type MqttClient } from 'mqtt'
import { eq, desc } from 'drizzle-orm'
import { db, biometricsDb } from '@/src/db'
import { deviceSettings, deviceState } from '@/src/db/schema'
import { bedTemp, flowReadings, vitals } from '@/src/db/biometrics-schema'
import { getPumpStallNotice } from '@/src/hardware/pumpStallNotification'
import { centiDegreesToC, centiPercentToPercent } from '@/src/lib/tempUtils'
import { onServerFrame } from './piezoStream'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

const DEFAULT_TOPIC_PREFIX = 'sleepypod'
const STATE_PUBLISH_INTERVAL_MS = 30_000
const RECONNECT_PERIOD_MS = 5_000
const CONNECT_TIMEOUT_MS = 10_000
const TEST_CONNECT_TIMEOUT_MS = 5_000

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

export async function resolveConfig(): Promise<{
  config: ResolvedMqttConfig
  sources: ResolvedMqttSources
}> {
  let row: typeof deviceSettings.$inferSelect | undefined
  try {
    [row] = await db.select().from(deviceSettings).limit(1)
  }
  catch (err) {
    console.warn('[mqtt] failed to read device_settings — falling back to env:', err instanceof Error ? err.message : err)
  }

  const envEnabled = envBool(process.env.MQTT_ENABLED)
  const envHaDiscovery = envBool(process.env.MQTT_HA_DISCOVERY)
  const envTls = envBool(process.env.MQTT_TLS)
  const envTlsInsecure = envBool(process.env.MQTT_TLS_INSECURE)

  const pick = <T>(dbVal: T | null | undefined, envVal: T | null, fallback: T): { value: T, source: ConfigSource } => {
    if (dbVal !== null && dbVal !== undefined) return { value: dbVal, source: 'db' }
    if (envVal !== null && envVal !== undefined) return { value: envVal, source: 'env' }
    return { value: fallback, source: 'default' }
  }

  const enabled = pick<boolean>(row?.mqttEnabled ?? null, envEnabled, false)
  const url = pick<string | null>(row?.mqttUrl ?? null, process.env.MQTT_URL ?? null, null)
  const username = pick<string | null>(row?.mqttUsername ?? null, process.env.MQTT_USERNAME ?? null, null)
  const password = pick<string | null>(row?.mqttPassword ?? null, process.env.MQTT_PASSWORD ?? null, null)
  const topicPrefix = pick<string>(row?.mqttTopicPrefix ?? null, process.env.MQTT_TOPIC_PREFIX ?? null, DEFAULT_TOPIC_PREFIX)
  const haDiscovery = pick<boolean>(row?.mqttHaDiscovery ?? null, envHaDiscovery, true)
  const tlsEnabled = pick<boolean>(row?.mqttTlsEnabled ?? null, envTls, false)
  const tlsInsecure = pick<boolean>(row?.mqttTlsInsecure ?? null, envTlsInsecure, false)

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
}

const state: BridgeState = {
  client: null,
  runState: 'stopped',
  lastError: null,
  publishTimer: null,
  unsubscribeFrame: null,
  resolved: null,
  messagesPublished: 0,
  lastPublishAt: null,
}

export interface BridgeStatus {
  runState: BridgeRunState
  connected: boolean
  lastError: string | null
  deviceId: string
  topicPrefix: string | null
  messagesPublished: number
  lastPublishAt: string | null
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

interface HaDiscoveryDevice {
  identifiers: string[]
  name: string
  manufacturer: string
  model: string
  sw_version?: string
}

function haDevice(): HaDiscoveryDevice {
  const id = deviceId()
  return {
    identifiers: [id],
    name: `Sleepypod ${id}`,
    manufacturer: 'Sleepypod',
    model: 'Pod',
  }
}

function publishHaDiscovery(): void {
  if (!state.resolved?.haDiscovery) return
  const id = deviceId()
  const dev = haDevice()
  const availability = topic('availability')
  const haPrefix = process.env.MQTT_HA_DISCOVERY_PREFIX || 'homeassistant'

  const climate = (side: 'left' | 'right') => ({
    name: `${side === 'left' ? 'Left' : 'Right'} side`,
    unique_id: `${id}_${side}_climate`,
    availability_topic: availability,
    payload_available: 'online',
    payload_not_available: 'offline',
    current_temperature_topic: topic('state', side, 'climate'),
    current_temperature_template: '{{ value_json.currentTemperature }}',
    temperature_state_topic: topic('state', side, 'climate'),
    temperature_state_template: '{{ value_json.targetTemperature }}',
    mode_state_topic: topic('state', side, 'climate'),
    mode_state_template: '{{ value_json.mode }}',
    temperature_command_topic: topic('cmd', 'set-temperature'),
    temperature_command_template: `{ "side": "${side}", "temperature": {{ value | int }} }`,
    mode_command_topic: topic('cmd', 'set-power'),
    mode_command_template: `{ "side": "${side}", "powered": {{ "true" if value == "heat" else "false" }} }`,
    modes: ['off', 'heat'],
    min_temp: 55,
    max_temp: 110,
    temp_step: 1,
    temperature_unit: 'F',
    device: dev,
  })

  const sensor = (objectId: string, name: string, stateTopic: string, template: string, unit?: string) => {
    const cfg: Record<string, unknown> = {
      name,
      unique_id: `${id}_${objectId}`,
      availability_topic: availability,
      payload_available: 'online',
      payload_not_available: 'offline',
      state_topic: stateTopic,
      value_template: template,
      state_class: 'measurement',
      device: dev,
    }
    if (unit) cfg.unit_of_measurement = unit
    return cfg
  }

  safePublish(
    `${haPrefix}/climate/${id}/left/config`,
    JSON.stringify(climate('left')),
    RETAINED_QOS_0,
  )
  safePublish(
    `${haPrefix}/climate/${id}/right/config`,
    JSON.stringify(climate('right')),
    RETAINED_QOS_0,
  )
  safePublish(
    `${haPrefix}/sensor/${id}/water_level/config`,
    JSON.stringify(sensor('water_level', 'Water level', topic('state', 'water-level'), '{{ value_json.level }}')),
    RETAINED_QOS_0,
  )

  // Ambient temperature + humidity from bed_temp. Two HA sensor entities
  // sharing one state topic so a single retained payload feeds both.
  const ambientTopic = topic('state', 'environment', 'ambient')
  const ambientTemp = sensor(
    'ambient_temperature',
    'Ambient temperature',
    ambientTopic,
    '{{ value_json.temperature }}',
    '°C',
  )
  ambientTemp.device_class = 'temperature'
  safePublish(
    `${haPrefix}/sensor/${id}/ambient_temperature/config`,
    JSON.stringify(ambientTemp),
    RETAINED_QOS_0,
  )
  const ambientHumidity = sensor(
    'ambient_humidity',
    'Ambient humidity',
    ambientTopic,
    '{{ value_json.humidity }}',
    '%',
  )
  ambientHumidity.device_class = 'humidity'
  safePublish(
    `${haPrefix}/sensor/${id}/ambient_humidity/config`,
    JSON.stringify(ambientHumidity),
    RETAINED_QOS_0,
  )
  // Pump topics — one set per side. RPM + loop temp as measurement sensors;
  // stall / clog as binary sensors with the `problem` device_class so HA
  // renders them as red alert tiles.
  for (const side of ['left', 'right'] as const) {
    const rpmTopic = topic('pump', side, 'rpm')
    const loopTopic = topic('pump', side, 'loop_temp_c')
    const stallTopic = topic('pump', side, 'stall')
    const clogTopic = topic('pump', side, 'clog_detected')

    const pumpRpm = sensor(
      `pump_${side}_rpm`,
      `${side === 'left' ? 'Left' : 'Right'} pump RPM`,
      rpmTopic,
      '{{ value_json.rpm }}',
      'rpm',
    )
    safePublish(
      `${haPrefix}/sensor/${id}/pump_${side}_rpm/config`,
      JSON.stringify(pumpRpm),
      RETAINED_QOS_0,
    )
    const pumpLoop = sensor(
      `pump_${side}_loop_temp`,
      `${side === 'left' ? 'Left' : 'Right'} pump loop temp`,
      loopTopic,
      '{{ value_json.temperature }}',
      '°C',
    )
    pumpLoop.device_class = 'temperature'
    safePublish(
      `${haPrefix}/sensor/${id}/pump_${side}_loop_temp/config`,
      JSON.stringify(pumpLoop),
      RETAINED_QOS_0,
    )
    safePublish(
      `${haPrefix}/binary_sensor/${id}/pump_${side}_stall/config`,
      JSON.stringify({
        name: `${side === 'left' ? 'Left' : 'Right'} pump stall`,
        unique_id: `${id}_pump_${side}_stall`,
        availability_topic: availability,
        payload_available: 'online',
        payload_not_available: 'offline',
        state_topic: stallTopic,
        payload_on: 'on',
        payload_off: 'off',
        device_class: 'problem',
        device: dev,
      }),
      RETAINED_QOS_0,
    )
    safePublish(
      `${haPrefix}/binary_sensor/${id}/pump_${side}_clog/config`,
      JSON.stringify({
        name: `${side === 'left' ? 'Left' : 'Right'} pump clog detected`,
        unique_id: `${id}_pump_${side}_clog`,
        availability_topic: availability,
        payload_available: 'online',
        payload_not_available: 'offline',
        state_topic: clogTopic,
        payload_on: 'on',
        payload_off: 'off',
        device_class: 'problem',
        device: dev,
      }),
      RETAINED_QOS_0,
    )
  }

  for (const side of ['left', 'right'] as const) {
    safePublish(
      `${haPrefix}/sensor/${id}/${side}_heart_rate/config`,
      JSON.stringify(sensor(`${side}_heart_rate`, `${side === 'left' ? 'Left' : 'Right'} heart rate`,
        topic('state', 'biometrics', side), '{{ value_json.heartRate }}', 'bpm')),
      RETAINED_QOS_0,
    )
    safePublish(
      `${haPrefix}/sensor/${id}/${side}_breathing_rate/config`,
      JSON.stringify(sensor(`${side}_breathing_rate`, `${side === 'left' ? 'Left' : 'Right'} breathing rate`,
        topic('state', 'biometrics', side), '{{ value_json.breathingRate }}', 'br/min')),
      RETAINED_QOS_0,
    )
    safePublish(
      `${haPrefix}/sensor/${id}/${side}_hrv/config`,
      JSON.stringify(sensor(`${side}_hrv`, `${side === 'left' ? 'Left' : 'Right'} HRV`,
        topic('state', 'biometrics', side), '{{ value_json.hrv }}', 'ms')),
      RETAINED_QOS_0,
    )
  }
}

// ---------------------------------------------------------------------------
// State publication
// ---------------------------------------------------------------------------

async function publishState(): Promise<void> {
  if (!state.client?.connected) return

  const monitor = getDacMonitorIfRunning()
  const status = monitor?.getLastStatus()

  if (status) {
    safePublish(topic('state', 'device-status'), JSON.stringify({
      ts: Date.now(),
      leftSide: status.leftSide,
      rightSide: status.rightSide,
      waterLevel: status.waterLevel,
      isPriming: status.isPriming,
      podVersion: status.podVersion,
    }), RETAINED_QOS_0)

    safePublish(topic('state', 'water-level'), JSON.stringify({
      ts: Date.now(),
      level: status.waterLevel,
    }), RETAINED_QOS_0)
  }

  try {
    const sides = await db.select().from(deviceState)
    for (const row of sides) {
      const mode = row.isPowered ? 'heat' : 'off'
      safePublish(topic('state', row.side, 'climate'), JSON.stringify({
        ts: row.lastUpdated.getTime(),
        currentTemperature: row.currentTemperature,
        targetTemperature: row.targetTemperature,
        isPowered: row.isPowered,
        isAlarmVibrating: row.isAlarmVibrating,
        mode,
        waterLevel: row.waterLevel,
      }), RETAINED_QOS_0)
    }
  }
  catch (err) {
    console.warn('[mqtt] device_state publish failed:', err instanceof Error ? err.message : err)
  }

  for (const side of ['left', 'right'] as const) {
    try {
      const [latest] = await biometricsDb
        .select()
        .from(vitals)
        .where(eq(vitals.side, side))
        .orderBy(desc(vitals.timestamp))
        .limit(1)
      if (latest) {
        safePublish(topic('state', 'biometrics', side), JSON.stringify({
          ts: latest.timestamp.getTime(),
          heartRate: latest.heartRate,
          hrv: latest.hrv,
          breathingRate: latest.breathingRate,
        }), RETAINED_QOS_0)
      }
    }
    catch (err) {
      console.warn(`[mqtt] biometrics publish (${side}) failed:`, err instanceof Error ? err.message : err)
    }
  }

  try {
    const [latestEnv] = await biometricsDb
      .select({
        timestamp: bedTemp.timestamp,
        ambientTemp: bedTemp.ambientTemp,
        humidity: bedTemp.humidity,
      })
      .from(bedTemp)
      .orderBy(desc(bedTemp.timestamp))
      .limit(1)
    if (latestEnv) {
      safePublish(topic('state', 'environment', 'ambient'), JSON.stringify({
        ts: latestEnv.timestamp.getTime(),
        temperature: latestEnv.ambientTemp != null ? centiDegreesToC(latestEnv.ambientTemp) : null,
        humidity: latestEnv.humidity != null ? centiPercentToPercent(latestEnv.humidity) : null,
      }), RETAINED_QOS_0)
    }
  }
  catch (err) {
    console.warn('[mqtt] ambient environment publish failed:', err instanceof Error ? err.message : err)
  }

  try {
    const [latestFlow] = await biometricsDb
      .select()
      .from(flowReadings)
      .orderBy(desc(flowReadings.timestamp))
      .limit(1)
    if (latestFlow) {
      const ts = latestFlow.timestamp.getTime()
      safePublish(topic('pump', 'left', 'rpm'), JSON.stringify({
        ts,
        rpm: latestFlow.leftPumpRpm,
      }), RETAINED_QOS_0)
      safePublish(topic('pump', 'right', 'rpm'), JSON.stringify({
        ts,
        rpm: latestFlow.rightPumpRpm,
      }), RETAINED_QOS_0)
      safePublish(topic('pump', 'left', 'loop_temp_c'), JSON.stringify({
        ts,
        temperature: latestFlow.leftFlowrateCd != null ? latestFlow.leftFlowrateCd / 100 : null,
      }), RETAINED_QOS_0)
      safePublish(topic('pump', 'right', 'loop_temp_c'), JSON.stringify({
        ts,
        temperature: latestFlow.rightFlowrateCd != null ? latestFlow.rightFlowrateCd / 100 : null,
      }), RETAINED_QOS_0)
    }
  }
  catch (err) {
    console.warn('[mqtt] pump rpm publish failed:', err instanceof Error ? err.message : err)
  }

  // Stall + clog state per side. Clog stays 'off' until the nightly job
  // lands — that work is out of scope for this PR.
  for (const side of ['left', 'right'] as const) {
    safePublish(
      topic('pump', side, 'stall'),
      getPumpStallNotice(side) ? 'on' : 'off',
      RETAINED_QOS_0,
    )
    safePublish(topic('pump', side, 'clog_detected'), 'off', RETAINED_QOS_0)
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

// TODO: empty context is fine while every procedure is publicProcedure. Once
// protectedProcedure lands (see ADR 0019 follow-ups), this becomes a privilege
// escalation channel — MQTT commands would bypass auth. Replace with a
// dedicated bridge context that asserts least-privilege.
//
// Lazy import breaks a circular module init: appRouter -> mqttRouter ->
// mqttBridge -> appRouter triggers an ESM TDZ in the production bundle.
type AppCaller = Awaited<ReturnType<typeof loadCaller>>
let cachedCaller: AppCaller | null = null
async function loadCaller() {
  const { appRouter } = await import('@/src/server/routers/app')
  return appRouter.createCaller({})
}
async function getCaller(): Promise<AppCaller> {
  if (!cachedCaller) cachedCaller = await loadCaller()
  return cachedCaller
}

interface CommandPayload {
  side?: unknown
  temperature?: unknown
  duration?: unknown
  powered?: unknown
  vibrationIntensity?: unknown
  vibrationPattern?: unknown
}

function parsePayload(buf: Buffer): CommandPayload {
  const text = buf.toString('utf-8').trim()
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed as CommandPayload : {}
  }
  catch {
    return {}
  }
}

async function handleCommand(verb: string, payload: CommandPayload): Promise<void> {
  // Each branch hands the payload straight to the tRPC procedure — its Zod
  // schema rejects malformed input. No client-side validation duplicated here.
  const caller = await getCaller()
  switch (verb) {
    case 'set-temperature':
      await caller.device.setTemperature(payload as never)
      return
    case 'set-power':
      await caller.device.setPower(payload as never)
      return
    case 'set-alarm':
      await caller.device.setAlarm(payload as never)
      return
    case 'clear-alarm':
      await caller.device.clearAlarm(payload as never)
      return
    case 'start-priming':
      await caller.device.startPriming({})
      return
    default:
      console.warn(`[mqtt] unknown command verb: ${verb}`)
  }
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
  // Test connection resolves tlsInsecure through the same db-then-env
  // precedence as the running bridge (resolveConfig), so the "Test" button
  // surfaces the same cert-trust outcome — env-only reads disagreed with a
  // db-configured bridge. tlsEnabled on its own does not relax cert
  // verification — mqtt.js defaults to strict.
  const { config } = await resolveConfig()
  const tlsInsecure = config.tlsInsecure
  return new Promise((resolve) => {
    let settled = false
    const finalize = (result: TestConnectionResult) => {
      if (settled) return
      settled = true
      try {
        c.end(true)
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

    let c: MqttClient
    try {
      c = mqtt.connect(input.url, opts)
    }
    catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      return
    }

    c.once('connect', () => finalize({ ok: true }))
    c.once('error', (err: Error) => finalize({ ok: false, error: err.message }))
    setTimeout(() => finalize({ ok: false, error: 'connect timeout' }), TEST_CONNECT_TIMEOUT_MS + 500)
  })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startMqttBridge(): Promise<void> {
  if (state.runState !== 'stopped') return

  state.runState = 'starting'
  state.lastError = null

  const { config } = await resolveConfig()
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

  const id = deviceId()
  const availabilityTopic = topic('availability')
  const opts: IClientOptions = {
    clientId: `sleepypod-${id}-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: RECONNECT_PERIOD_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    keepalive: 30,
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

  const client: MqttClient = mqtt.connect(config.url, opts)
  state.client = client

  client.on('connect', () => {
    state.runState = 'connected'
    state.lastError = null
    console.log(`[mqtt] connected to ${config.url} (deviceId=${id}, prefix=${config.topicPrefix})`)
    safePublish(availabilityTopic, 'online', RETAINED_QOS_0)
    publishHaDiscovery()
    client.subscribe(topic('cmd', '+'), { qos: 0 }, (err: Error | null) => {
      if (err) console.warn('[mqtt] subscribe cmd/* failed:', err.message)
    })
    void publishState()
  })

  client.on('reconnect', () => {
    state.runState = 'reconnecting'
    console.log('[mqtt] reconnecting…')
  })

  client.on('error', (err: Error) => {
    state.lastError = err.message
    console.warn('[mqtt] client error:', err.message)
  })

  client.on('close', () => {
    if (state.runState === 'connected') state.runState = 'reconnecting'
  })

  client.on('message', (incomingTopic: string, payload: Buffer) => {
    const cmdPrefix = topic('cmd') + '/'
    if (!incomingTopic.startsWith(cmdPrefix)) return
    const verb = incomingTopic.slice(cmdPrefix.length)
    const parsed = parsePayload(payload)
    void handleCommand(verb, parsed).catch((err) => {
      console.warn(`[mqtt] command ${verb} failed:`, err instanceof Error ? err.message : err)
    })
  })

  state.publishTimer = setInterval(() => {
    void publishState()
  }, STATE_PUBLISH_INTERVAL_MS)

  // React to live status frames so HA sees temperature changes immediately
  // rather than waiting for the periodic re-publish.
  state.unsubscribeFrame = onServerFrame((frame) => {
    if (frame.type !== 'deviceStatus') return
    if (!state.client?.connected) return
    safePublish(topic('state', 'device-status'), JSON.stringify(frame), RETAINED_QOS_0)
  })
}

export async function shutdownMqttBridge(): Promise<void> {
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
  parsePayload,
  state,
}

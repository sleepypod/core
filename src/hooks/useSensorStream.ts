'use client'

import { useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { normalizeFrame } from '@/src/streaming/normalizeFrame'

// ---------------------------------------------------------------------------
// Sensor frame types (matching piezoStream.ts server output)
// ---------------------------------------------------------------------------

export const ALL_SENSOR_TYPES = [
  'piezo-dual', 'capSense', 'capSense2',
  'bedTemp', 'bedTemp2', 'frzTemp', 'frzTherm', 'frzHealth', 'log',
  'deviceStatus', 'gesture',
] as const

export type SensorType = typeof ALL_SENSOR_TYPES[number]

/** Piezo BCG frame — raw int32 waveform arrays for each side (~1 Hz). */
export interface PiezoDualFrame {
  type: 'piezo-dual'
  ts: number
  freq: number
  left1: number[]
  right1: number[]
  left2?: number[]
  right2?: number[]
}

/** Capacitive presence sensor frame (~2 Hz). */
export interface CapSenseFrame {
  type: 'capSense'
  ts: number
  left: number
  right: number
}

/** Capacitive presence sensor frame (newer pods, ~2 Hz). Normalized to arrays. */
export interface CapSense2Frame {
  type: 'capSense2'
  ts: number
  left: number[]
  right: number[]
  status?: string
}

/** Bed temperature frame (~0.06 Hz). Normalized from nested firmware structure. Values in Celsius. */
export interface BedTempFrame {
  type: 'bedTemp'
  ts: number
  ambientTemp: number | null
  mcuTemp: number | null
  humidity: number | null
  leftOuterTemp: number | null
  leftCenterTemp: number | null
  leftInnerTemp: number | null
  rightOuterTemp: number | null
  rightCenterTemp: number | null
  rightInnerTemp: number | null
}

/** Bed temperature frame (newer pods, ~0.06 Hz). Normalized from nested firmware structure. Values in Celsius. */
export interface BedTemp2Frame {
  type: 'bedTemp2'
  ts: number
  ambientTemp: number | null
  mcuTemp: number | null
  humidity: number | null
  leftOuterTemp: number | null
  leftCenterTemp: number | null
  leftInnerTemp: number | null
  rightOuterTemp: number | null
  rightCenterTemp: number | null
  rightInnerTemp: number | null
}

/** Freezer temperature frame (~0.06 Hz). Values normalized to Celsius. */
export interface FrzTempFrame {
  type: 'frzTemp'
  ts: number
  left: number | null
  right: number | null
  amb: number | null
  hs: number | null
}

/** Freezer thermal control status frame. */
export interface FrzThermFrame {
  type: 'frzTherm'
  ts: number
  left: number
  right: number
}

/** Freezer health frame — normalized from nested firmware structure. */
export interface FrzHealthFrame {
  type: 'frzHealth'
  ts: number
  left: { pumpRpm: number, pumpDuty: number, tecCurrent: number }
  right: { pumpRpm: number, pumpDuty: number, tecCurrent: number }
  fan: { rpm: number, duty: number }
}

/** Firmware log frame. */
export interface LogFrame {
  type: 'log'
  ts: number
  level: string
  msg: string
}

/** Gesture event frame — pushed when a tap gesture is detected. */
export interface GestureFrame {
  type: 'gesture'
  ts: number
  side: 'left' | 'right'
  tapType: string
}

/** Device status frame — pushed by dacMonitor every 2s. */
export interface DeviceStatusFrame {
  type: 'deviceStatus'
  ts: number
  leftSide: {
    currentTemperature: number
    targetTemperature: number
    currentLevel: number
    targetLevel: number
    isAlarmVibrating: boolean
  }
  rightSide: {
    currentTemperature: number
    targetTemperature: number
    currentLevel: number
    targetLevel: number
    isAlarmVibrating: boolean
  }
  waterLevel: 'low' | 'ok'
  isPriming: boolean
  primeCompletedNotification?: { timestamp: number }
  snooze: {
    left: { active: boolean, snoozeUntil: number | null } | null
    right: { active: boolean, snoozeUntil: number | null } | null
  }
}

/** Union of all sensor frame types. */
export type SensorFrame
  = | PiezoDualFrame
    | CapSenseFrame
    | CapSense2Frame
    | BedTempFrame
    | BedTemp2Frame
    | FrzTempFrame
    | FrzThermFrame
    | FrzHealthFrame
    | LogFrame
    | DeviceStatusFrame
    | GestureFrame

// ---------------------------------------------------------------------------
// Server → Client control messages
// ---------------------------------------------------------------------------

interface ErrorMessage { type: 'error', message: string }
interface SubscribedMessage { type: 'subscribed', sensors: string[] }
interface TimeRangeMessage { type: 'time_range', min: number, max: number, file: string | null }
interface SeekCompleteMessage { type: 'seek_complete' }

type ServerControlMessage
  = | ErrorMessage
    | SubscribedMessage
    | TimeRangeMessage
    | SeekCompleteMessage

type ServerMessage = SensorFrame | ServerControlMessage

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

/** Available time range for seeking (epoch seconds). */
export interface TimeRange {
  min: number
  max: number
}

export interface SensorStreamState {
  status: ConnectionStatus
  /** Latest frame per sensor type (for current-value displays). */
  latestFrames: Partial<Record<SensorType, SensorFrame>>
  /** Most recent error message from server or connection failure. */
  lastError: string | null
  /** Sensors currently subscribed to (null = all). */
  subscribedSensors: SensorType[] | null
  /** Frames per second (computed over rolling 2-second window). */
  fps: number
  /** Timestamp of the most recently received frame (epoch ms). */
  lastFrameTime: number | null
  /** Whether the client is currently receiving seek replay frames. */
  isSeeking: boolean
  /** Available time range for scrubbing (epoch seconds), or null if unknown. */
  timeRange: TimeRange | null
}

// ---------------------------------------------------------------------------
// External store (shared across hook consumers)
// Wrapped in globalThis to survive HMR module re-evaluation during development.
// ---------------------------------------------------------------------------

interface SensorStreamSingleton {
  state: SensorStreamState
  fpsTimestamps: number[]
  fpsUpdateTimer: ReturnType<typeof setInterval> | null
  listeners: Set<() => void>
  sensorListeners: Map<SensorType, Set<() => void>>
  frameCallbacks: Set<FrameCallback>
  ws: WebSocket | null
  reconnectTimeout: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  intentionalClose: boolean
  activeRefCount: number
  pendingSubscription: SensorType[] | null
  /** Per-hook active sensor requests. Keyed by a unique hook ID. */
  activeSubscriptions: Map<number, SensorType[] | null>
  /** Counter for generating unique hook subscription IDs. */
  nextSubscriptionId: number
  /** Pending resolvers for getTimeRange() promises. */
  timeRangeResolvers: Array<(range: TimeRange | null) => void>
}

const SINGLETON_KEY = '__sleepypod_sensorStream' as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
if (!g[SINGLETON_KEY]) {
  g[SINGLETON_KEY] = {
    state: {
      status: 'disconnected',
      latestFrames: {},
      lastError: null,
      subscribedSensors: null,
      fps: 0,
      lastFrameTime: null,
      isSeeking: false,
      timeRange: null,
    },
    fpsTimestamps: [],
    fpsUpdateTimer: null,
    listeners: new Set<() => void>(),
    sensorListeners: new Map<SensorType, Set<() => void>>(),
    frameCallbacks: new Set<FrameCallback>(),
    ws: null,
    reconnectTimeout: null,
    reconnectAttempt: 0,
    intentionalClose: false,
    activeRefCount: 0,
    pendingSubscription: null,
    activeSubscriptions: new Map<number, SensorType[] | null>(),
    nextSubscriptionId: 0,
    timeRangeResolvers: [],
  } satisfies SensorStreamSingleton
}
const singleton: SensorStreamSingleton = g[SINGLETON_KEY]

// Convenience aliases
let state = singleton.state
const fpsTimestamps = singleton.fpsTimestamps
const FPS_WINDOW_MS = 2_000

function trackFrame() {
  const now = Date.now()
  fpsTimestamps.push(now)
  // Trim old entries
  const cutoff = now - FPS_WINDOW_MS
  while (fpsTimestamps.length > 0 && fpsTimestamps[0] < cutoff) {
    fpsTimestamps.shift()
  }
}

function computeFps(): number {
  if (fpsTimestamps.length < 2) return 0
  const now = Date.now()
  const cutoff = now - FPS_WINDOW_MS
  const recent = fpsTimestamps.filter(t => t >= cutoff)
  if (recent.length < 2) return 0
  const elapsed = (recent[recent.length - 1] - recent[0]) / 1000
  return elapsed > 0 ? Math.round((recent.length - 1) / elapsed) : 0
}

function startFpsTimer() {
  stopFpsTimer()
  singleton.fpsUpdateTimer = setInterval(() => {
    const newFps = computeFps()
    if (newFps !== state.fps) {
      setState({ fps: newFps })
    }
  }, 500)
}

function stopFpsTimer() {
  if (singleton.fpsUpdateTimer) {
    clearInterval(singleton.fpsUpdateTimer)
    singleton.fpsUpdateTimer = null
  }
  fpsTimestamps.length = 0
}

const listeners = singleton.listeners
/** Per-sensor-type listeners for high-frequency selective re-renders. */
const sensorListeners = singleton.sensorListeners

function getSnapshot(): SensorStreamState {
  return state
}

function getServerSnapshot(): SensorStreamState {
  return state // SSR — always disconnected default
}

function setState(partial: Partial<SensorStreamState>) {
  state = { ...state, ...partial }
  singleton.state = state
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ---------------------------------------------------------------------------
// Frame callback registry (for components that need every frame, not just latest)
// ---------------------------------------------------------------------------

type FrameCallback = (frame: SensorFrame) => void
const frameCallbacks = singleton.frameCallbacks

// ---------------------------------------------------------------------------
// WebSocket connection manager (singleton)
// ---------------------------------------------------------------------------

const DEFAULT_WS_PORT = 3001
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

function getWsUrl(): string {
  if (typeof window === 'undefined') return ''
  const port = Number(process.env.NEXT_PUBLIC_PIEZO_WS_PORT ?? DEFAULT_WS_PORT)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.hostname}:${port}`
}

function scheduleReconnect() {
  if (singleton.intentionalClose || singleton.activeRefCount <= 0) return
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, singleton.reconnectAttempt), RECONNECT_MAX_MS)
  singleton.reconnectAttempt++
  setState({ status: 'reconnecting' })
  singleton.reconnectTimeout = setTimeout(() => {
    singleton.reconnectTimeout = null
    connect()
  }, delay)
}

// Frame normalization imported from @/src/streaming/normalizeFrame

function handleMessage(event: MessageEvent) {
  try {
    const msg: ServerMessage = JSON.parse(event.data)

    // Control messages
    if (msg.type === 'error') {
      setState({ lastError: (msg as ErrorMessage).message })
      return
    }
    if (msg.type === 'subscribed') {
      const sensors = (msg as SubscribedMessage).sensors as SensorType[]
      setState({ subscribedSensors: sensors })
      return
    }
    if (msg.type === 'time_range') {
      const tr = msg as TimeRangeMessage
      const range: TimeRange | null
        = tr.min === 0 && tr.max === 0 ? null : { min: tr.min, max: tr.max }
      setState({ timeRange: range })
      // Resolve any pending getTimeRange() promises
      for (const resolve of singleton.timeRangeResolvers) {
        resolve(range)
      }
      singleton.timeRangeResolvers.length = 0
      return
    }
    if (msg.type === 'seek_complete') {
      setState({ isSeeking: false })
      return
    }

    // Sensor frame — normalize nested firmware structures to flat schemas, then update
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const frame = normalizeFrame(msg as any) as unknown as SensorFrame
    trackFrame()
    const newLatest = { ...state.latestFrames, [frame.type]: frame }
    setState({ latestFrames: newLatest, lastFrameTime: Date.now() })

    // Notify per-sensor listeners
    const typedListeners = sensorListeners.get(frame.type as SensorType)
    if (typedListeners) {
      for (const cb of typedListeners) cb()
    }

    // Notify frame callbacks
    for (const cb of frameCallbacks) {
      try {
        cb(frame)
      }
      catch { /* consumer error */ }
    }
  }
  catch {
    // Non-JSON message — ignore
  }
}

function connect() {
  if (typeof window === 'undefined') return
  if (singleton.ws?.readyState === WebSocket.OPEN || singleton.ws?.readyState === WebSocket.CONNECTING) return

  const url = getWsUrl()
  if (!url) return

  setState({ status: 'connecting' })
  singleton.intentionalClose = false

  try {
    singleton.ws = new WebSocket(url)
  }
  catch {
    setState({ status: 'disconnected', lastError: 'Failed to create WebSocket' })
    scheduleReconnect()
    return
  }

  singleton.ws.onopen = () => {
    singleton.reconnectAttempt = 0
    setState({ status: 'connected', lastError: null })
    startFpsTimer()

    // Recompute and send merged subscription now that the connection is open
    recomputeAndSendSubscription()
  }

  singleton.ws.onmessage = handleMessage

  singleton.ws.onclose = () => {
    singleton.ws = null
    if (!singleton.intentionalClose) {
      scheduleReconnect()
    }
    else {
      setState({ status: 'disconnected' })
    }
  }

  singleton.ws.onerror = () => {
    // onclose will fire after onerror — reconnect handled there
    setState({ lastError: 'WebSocket connection error' })
  }
}

function disconnect() {
  singleton.intentionalClose = true
  stopFpsTimer()
  if (singleton.reconnectTimeout) {
    clearTimeout(singleton.reconnectTimeout)
    singleton.reconnectTimeout = null
  }
  singleton.reconnectAttempt = 0
  if (singleton.ws) {
    singleton.ws.close()
    singleton.ws = null
  }
  setState({ status: 'disconnected', latestFrames: {}, subscribedSensors: null, fps: 0, lastFrameTime: null, isSeeking: false, timeRange: null })
}

/**
 * Merge all active subscriptions and send the combined set to the server.
 * If any hook requests all sensors (null), subscribe to all.
 */
function recomputeAndSendSubscription() {
  let merged: SensorType[] | null = null

  for (const sensors of singleton.activeSubscriptions.values()) {
    if (sensors === null) {
      // One hook wants all sensors — subscribe to all
      merged = null
      break
    }
    if (merged === null) {
      merged = [...sensors]
    }
    else {
      for (const s of sensors) {
        if (!merged.includes(s)) merged.push(s)
      }
    }
  }

  // If no active subscriptions, default to empty
  if (singleton.activeSubscriptions.size === 0) {
    merged = []
  }

  singleton.pendingSubscription = merged
  if (singleton.ws?.readyState === WebSocket.OPEN) {
    singleton.ws.send(JSON.stringify({
      type: 'subscribe',
      sensors: merged ?? [],
    }))
  }
}

// ---------------------------------------------------------------------------
// Seek API (module-level functions, exposed via hooks)
// ---------------------------------------------------------------------------

/**
 * Send a seek request to the server. The server will replay frames from the
 * nearest indexed position at or before `timestamp` (epoch seconds).
 */
function sendSeek(timestamp: number): void {
  if (singleton.ws?.readyState === WebSocket.OPEN) {
    setState({ isSeeking: true })
    singleton.ws.send(JSON.stringify({ type: 'seek', timestamp }))
  }
}

/**
 * Request the available time range from the server. Returns a promise that
 * resolves when the server responds with a `time_range` message.
 */
function sendGetTimeRange(): Promise<TimeRange | null> {
  return new Promise<TimeRange | null>((resolve) => {
    if (singleton.ws?.readyState !== WebSocket.OPEN) {
      resolve(null)
      return
    }
    singleton.timeRangeResolvers.push(resolve)
    singleton.ws.send(JSON.stringify({ type: 'get_time_range' }))
    // Timeout after 5 seconds to avoid hanging promises
    setTimeout(() => {
      const idx = singleton.timeRangeResolvers.indexOf(resolve)
      if (idx !== -1) {
        singleton.timeRangeResolvers.splice(idx, 1)
        resolve(null)
      }
    }, 5_000)
  })
}

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

export interface UseSensorStreamOptions {
  /** Sensor types to subscribe to. Omit or pass null for all types. */
  sensors?: SensorType[] | null
  /** Whether to auto-connect on mount. Default: true. */
  enabled?: boolean
}

/**
 * React hook that connects to the piezoStream WebSocket server on port 3001,
 * manages connection lifecycle (open/close/reconnect with exponential backoff),
 * sends subscribe messages, and exposes typed sensor frames.
 *
 * Multiple components can use this hook simultaneously — the WebSocket
 * connection is shared (singleton) and ref-counted.
 *
 * @example
 * ```tsx
 * const { status, latestFrames } = useSensorStream({
 *   sensors: ['capSense', 'bedTemp'],
 * })
 * const presence = latestFrames.capSense as CapSenseFrame | undefined
 * ```
 */
export function useSensorStream(options: UseSensorStreamOptions = {}) {
  const { sensors = null, enabled = true } = options
  const sensorsKey = sensors ? sensors.slice().sort().join(',') : 'all'

  // Stable subscription ID for this hook instance
  const subIdRef = useRef<number | null>(null)
  if (subIdRef.current === null) {
    // eslint-disable-next-line react-hooks/immutability -- one-time init of external counter is intentional
    subIdRef.current = singleton.nextSubscriptionId++
  }

  // Ref-counted connection management
  useEffect(() => {
    if (!enabled) return

    singleton.activeRefCount++
    if (singleton.activeRefCount === 1) {
      connect()
    }

    return () => {
      singleton.activeRefCount--
      if (singleton.activeRefCount <= 0) {
        singleton.activeRefCount = 0
        disconnect()
      }
    }
  }, [enabled])

  // Subscription management — merge with other active hooks
  useEffect(() => {
    if (!enabled) return
    const id = subIdRef.current ?? 0
    singleton.activeSubscriptions.set(id, sensors ?? null)
    recomputeAndSendSubscription()

    return () => {
      singleton.activeSubscriptions.delete(id)
      recomputeAndSendSubscription()
    }
  }, [sensorsKey, enabled])

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  // Stable references for seek API (no deps — they use the singleton directly)
  const seek = useCallback((timestamp: number) => sendSeek(timestamp), [])
  const getTimeRange = useCallback(() => sendGetTimeRange(), [])

  return {
    ...snapshot,
    /** Send a seek request — server replays frames from the given timestamp (epoch seconds). */
    seek,
    /** Request the available time range for scrubbing. */
    getTimeRange,
  }
}

/**
 * Hook that returns only the latest frame for a specific sensor type.
 * Uses a per-sensor-type listener for minimal re-renders.
 *
 * @example
 * ```tsx
 * const frame = useSensorFrame('capSense')
 * // frame is CapSenseFrame | undefined
 * ```
 */
export function useSensorFrame<T extends SensorType>(
  sensorType: T
): Extract<SensorFrame, { type: T }> | undefined {
  const subscribeFn = useCallback(
    (listener: () => void) => {
      // Also subscribe to main store for connection state changes
      const unsub1 = subscribe(listener)

      if (!sensorListeners.has(sensorType)) {
        sensorListeners.set(sensorType, new Set())
      }
      sensorListeners.get(sensorType)?.add(listener)

      return () => {
        unsub1()
        sensorListeners.get(sensorType)?.delete(listener)
      }
    },
    [sensorType]
  )

  const getSnap = useCallback(
    () => state.latestFrames[sensorType] as Extract<SensorFrame, { type: T }> | undefined,
    [sensorType]
  )

  const getServerSnap = useCallback(
    () => undefined as Extract<SensorFrame, { type: T }> | undefined,
    [sensorType]
  )

  return useSyncExternalStore(subscribeFn, getSnap, getServerSnap)
}

/**
 * Register a callback that fires for every incoming sensor frame.
 * Useful for building waveform buffers or streaming to a canvas.
 *
 * The callback is NOT debounced — it fires at sensor frequency.
 */
export function useOnSensorFrame(callback: FrameCallback) {
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  })

  useEffect(() => {
    const handler: FrameCallback = frame => callbackRef.current(frame)
    frameCallbacks.add(handler)
    return () => {
      frameCallbacks.delete(handler)
    }
  }, [])
}

/**
 * Get the current WebSocket connection status without triggering
 * subscription management. Useful for status indicators.
 */
export function useSensorStreamStatus(): ConnectionStatus {
  const getSnap = useCallback(() => state.status, [])
  const getServerSnap = useCallback(() => 'disconnected' as ConnectionStatus, [])
  return useSyncExternalStore(subscribe, getSnap, getServerSnap)
}

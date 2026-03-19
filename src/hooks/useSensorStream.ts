'use client'

import { useEffect, useRef, useCallback, useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Sensor frame types (matching piezoStream.ts server output)
// ---------------------------------------------------------------------------

export const ALL_SENSOR_TYPES = [
  'piezo-dual', 'capSense', 'capSense2',
  'bedTemp', 'bedTemp2', 'frzTemp', 'frzTherm', 'frzHealth', 'log',
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

/** Capacitive presence sensor frame (newer pods, ~2 Hz). */
export interface CapSense2Frame {
  type: 'capSense2'
  ts: number
  left: number | number[]
  right: number | number[]
  status?: string
}

/** Bed temperature frame (~0.06 Hz). */
export interface BedTempFrame {
  type: 'bedTemp'
  ts: number
  ambientTemp?: number
  mcuTemp?: number
  humidity?: number
  leftOuterTemp?: number
  leftCenterTemp?: number
  leftInnerTemp?: number
  rightOuterTemp?: number
  rightCenterTemp?: number
  rightInnerTemp?: number
  [key: string]: unknown
}

/** Bed temperature frame (newer pods, ~0.06 Hz). */
export interface BedTemp2Frame {
  type: 'bedTemp2'
  ts: number
  ambientTemp?: number
  mcuTemp?: number
  humidity?: number
  leftOuterTemp?: number
  leftCenterTemp?: number
  leftInnerTemp?: number
  rightOuterTemp?: number
  rightCenterTemp?: number
  rightInnerTemp?: number
  [key: string]: unknown
}

/** Freezer temperature frame (~0.06 Hz). */
export interface FrzTempFrame {
  type: 'frzTemp'
  ts: number
  left: number
  right: number
  amb: number
  hs: number
}

/** Freezer thermal control status frame. */
export interface FrzThermFrame {
  type: 'frzTherm'
  ts: number
  left: number
  right: number
}

/** Freezer health frame. */
export interface FrzHealthFrame {
  type: 'frzHealth'
  ts: number
  left: number
  right: number
  fan: number
}

/** Firmware log frame. */
export interface LogFrame {
  type: 'log'
  ts: number
  level: string
  msg: string
}

/** Union of all sensor frame types. */
export type SensorFrame =
  | PiezoDualFrame
  | CapSenseFrame
  | CapSense2Frame
  | BedTempFrame
  | BedTemp2Frame
  | FrzTempFrame
  | FrzThermFrame
  | FrzHealthFrame
  | LogFrame

// ---------------------------------------------------------------------------
// Server → Client control messages
// ---------------------------------------------------------------------------

interface ErrorMessage { type: 'error'; message: string }
interface ClaimedMessage { type: 'claimed'; since: number }
interface ReleasedMessage { type: 'released' }
interface SubscribedMessage { type: 'subscribed'; sensors: string[] }

type ServerControlMessage = ErrorMessage | ClaimedMessage | ReleasedMessage | SubscribedMessage

type ServerMessage = SensorFrame | ServerControlMessage

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

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
}

// ---------------------------------------------------------------------------
// External store (shared across hook consumers)
// ---------------------------------------------------------------------------

let state: SensorStreamState = {
  status: 'disconnected',
  latestFrames: {},
  lastError: null,
  subscribedSensors: null,
  fps: 0,
  lastFrameTime: null,
}

// FPS tracking
const fpsTimestamps: number[] = []
const FPS_WINDOW_MS = 2_000
let fpsUpdateTimer: ReturnType<typeof setInterval> | null = null

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
  fpsUpdateTimer = setInterval(() => {
    const newFps = computeFps()
    if (newFps !== state.fps) {
      setState({ fps: newFps })
    }
  }, 500)
}

function stopFpsTimer() {
  if (fpsUpdateTimer) {
    clearInterval(fpsUpdateTimer)
    fpsUpdateTimer = null
  }
  fpsTimestamps.length = 0
}

const listeners = new Set<() => void>()
/** Per-sensor-type listeners for high-frequency selective re-renders. */
const sensorListeners = new Map<SensorType, Set<() => void>>()

function getSnapshot(): SensorStreamState {
  return state
}

function getServerSnapshot(): SensorStreamState {
  return state // SSR — always disconnected default
}

function setState(partial: Partial<SensorStreamState>) {
  state = { ...state, ...partial }
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
const frameCallbacks = new Set<FrameCallback>()

// ---------------------------------------------------------------------------
// WebSocket connection manager (singleton)
// ---------------------------------------------------------------------------

const DEFAULT_WS_PORT = 3001
const HEARTBEAT_INTERVAL_MS = 15_000 // send heartbeat every 15s (server timeout is 30s)
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

let ws: WebSocket | null = null
let heartbeatInterval: ReturnType<typeof setInterval> | null = null
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let intentionalClose = false
let activeRefCount = 0
let pendingSubscription: SensorType[] | null = null

function getWsUrl(): string {
  if (typeof window === 'undefined') return ''
  const port = Number(process.env.NEXT_PUBLIC_PIEZO_WS_PORT ?? DEFAULT_WS_PORT)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.hostname}:${port}`
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat' }))
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
}

function scheduleReconnect() {
  if (intentionalClose || activeRefCount <= 0) return
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS)
  reconnectAttempt++
  setState({ status: 'reconnecting' })
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null
    connect()
  }, delay)
}

function handleMessage(event: MessageEvent) {
  try {
    const msg: ServerMessage = JSON.parse(event.data)

    // Control messages
    if (msg.type === 'error') {
      setState({ lastError: (msg as ErrorMessage).message })
      return
    }
    if (msg.type === 'claimed' || msg.type === 'released') {
      return
    }
    if (msg.type === 'subscribed') {
      const sensors = (msg as SubscribedMessage).sensors as SensorType[]
      setState({ subscribedSensors: sensors })
      return
    }

    // Sensor frame — update latest + notify callbacks
    const frame = msg as SensorFrame
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
      try { cb(frame) } catch { /* consumer error */ }
    }
  } catch {
    // Non-JSON message — ignore
  }
}

function connect() {
  if (typeof window === 'undefined') return
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return

  const url = getWsUrl()
  if (!url) return

  setState({ status: 'connecting' })
  intentionalClose = false

  try {
    ws = new WebSocket(url)
  } catch {
    setState({ status: 'disconnected', lastError: 'Failed to create WebSocket' })
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    reconnectAttempt = 0
    setState({ status: 'connected', lastError: null })
    startHeartbeat()
    startFpsTimer()

    // Send subscription if one was requested before connection
    if (pendingSubscription && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', sensors: pendingSubscription }))
    }
  }

  ws.onmessage = handleMessage

  ws.onclose = () => {
    stopHeartbeat()
    ws = null
    if (!intentionalClose) {
      scheduleReconnect()
    } else {
      setState({ status: 'disconnected' })
    }
  }

  ws.onerror = () => {
    // onclose will fire after onerror — reconnect handled there
    setState({ lastError: 'WebSocket connection error' })
  }
}

function disconnect() {
  intentionalClose = true
  stopHeartbeat()
  stopFpsTimer()
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }
  reconnectAttempt = 0
  if (ws) {
    ws.close()
    ws = null
  }
  setState({ status: 'disconnected', latestFrames: {}, subscribedSensors: null, fps: 0, lastFrameTime: null })
}

function sendSubscribe(sensors: SensorType[] | null) {
  pendingSubscription = sensors
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'subscribe',
      sensors: sensors ?? [],
    }))
  }
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
 * sends subscribe/heartbeat messages, and exposes typed sensor frames.
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

  // Ref-counted connection management
  useEffect(() => {
    if (!enabled) return

    activeRefCount++
    if (activeRefCount === 1) {
      connect()
    }

    return () => {
      activeRefCount--
      if (activeRefCount <= 0) {
        activeRefCount = 0
        disconnect()
      }
    }
  }, [enabled])

  // Subscription management — update when sensors change
  useEffect(() => {
    if (!enabled) return
    sendSubscribe(sensors ?? null)
  }, [sensorsKey, enabled])

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  return snapshot
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
      sensorListeners.get(sensorType)!.add(listener)

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
  callbackRef.current = callback

  useEffect(() => {
    const handler: FrameCallback = (frame) => callbackRef.current(frame)
    frameCallbacks.add(handler)
    return () => { frameCallbacks.delete(handler) }
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

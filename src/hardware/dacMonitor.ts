import { EventEmitter } from 'events'
import { HardwareClient } from './client'
import { type DeviceStatus, type GestureData, type Side } from './types'

export type DacMonitorStatus = 'stopped' | 'starting' | 'running' | 'degraded'

export interface DacMonitorConfig {
  socketPath: string
  /** Poll interval in milliseconds. Defaults to 2000. */
  pollIntervalMs?: number
}

export interface GestureEvent {
  side: Side
  tapType: 'doubleTap' | 'tripleTap' | 'quadTap'
  timestamp: Date
}

export interface DacMonitorEvents {
  'status:updated': (status: DeviceStatus) => void
  'gesture:detected': (event: GestureEvent) => void
  'connection:established': () => void
  'connection:lost': () => void
  'error': (error: Error) => void
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface DacMonitor {
  on<K extends keyof DacMonitorEvents>(event: K, listener: DacMonitorEvents[K]): this
  off<K extends keyof DacMonitorEvents>(event: K, listener: DacMonitorEvents[K]): this
  emit<K extends keyof DacMonitorEvents>(event: K, ...args: Parameters<DacMonitorEvents[K]>): boolean
}

const DEFAULT_POLL_INTERVAL_MS = 2000
const TAP_TYPES = ['doubleTap', 'tripleTap', 'quadTap'] as const

/**
 * Polls the hardware daemon at a fixed interval and emits typed events.
 * No database access. No action execution. Observe and publish only.
 *
 * Lifecycle: stopped → starting → running ↔ degraded
 * `connection:established` fires both on initial connect and on recovery from
 * degraded. `connection:lost` fires once on the first failed poll.
 *
 * Concurrency: `isPollInFlight` ensures only one poll runs at a time even if
 * a hardware response is slower than the poll interval.
 *
 * Gesture counter reset: Pod firmware restarts reset tap counters to 0.
 * A counter decrease triggers silent re-baselining rather than a false gesture.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class DacMonitor extends EventEmitter {
  private readonly config: Required<DacMonitorConfig>
  private client: HardwareClient | null = null
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private monitorStatus: DacMonitorStatus = 'stopped'
  private lastStatus: DeviceStatus | null = null
  private lastGestures: GestureData | null = null
  private isFirstPoll = true
  private isPollInFlight = false

  constructor(config: DacMonitorConfig) {
    super()
    this.config = {
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      ...config,
    }
  }

  getStatus = (): DacMonitorStatus => this.monitorStatus

  getLastStatus = (): DeviceStatus | null => this.lastStatus

  start = async (): Promise<void> => {
    if (this.monitorStatus !== 'stopped') return

    this.monitorStatus = 'starting'
    this.isFirstPoll = true
    this.lastGestures = null
    this.isPollInFlight = false

    this.client = new HardwareClient({
      socketPath: this.config.socketPath,
      autoReconnect: true,
    })

    try {
      await this.client.connect()
      this.monitorStatus = 'running'
      this.emit('connection:established')
    }
    catch (error) {
      this.monitorStatus = 'degraded'
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    }

    // Start the interval regardless of initial connection state. If the daemon
    // was not available at startup it may start later; autoReconnect handles
    // reconnection transparently on the next poll attempt.
    this.intervalHandle = setInterval(() => {
      // Guard: skip if a previous poll is still in flight to prevent
      // concurrent polls racing on lastGestures / lastStatus.
      if (this.isPollInFlight) return
      this.isPollInFlight = true
      this.poll().finally(() => {
        this.isPollInFlight = false
      })
    }, this.config.pollIntervalMs)
  }

  stop = (): void => {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }

    if (this.client) {
      this.client.disconnect()
      this.client = null
    }

    this.monitorStatus = 'stopped'
    this.isPollInFlight = false
  }

  private poll = async (): Promise<void> => {
    if (!this.client) return

    try {
      const status = await this.client.getDeviceStatus()

      if (this.monitorStatus === 'degraded') {
        this.monitorStatus = 'running'
        this.emit('connection:established')
      }

      this.lastStatus = status
      this.emit('status:updated', status)

      if (status.gestures) {
        if (this.isFirstPoll) {
          // Establish baseline — do not emit gesture events for initial counts.
          this.lastGestures = this.extractGestureCounters(status.gestures)
        }
        else {
          this.detectGestures(status.gestures)
          this.lastGestures = this.extractGestureCounters(status.gestures)
        }
      }

      this.isFirstPoll = false
    }
    catch (error) {
      if (this.monitorStatus !== 'degraded') {
        this.monitorStatus = 'degraded'
        this.emit('connection:lost')
      }
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    }
  }

  private extractGestureCounters = (gestures: GestureData): GestureData => ({
    doubleTap: gestures.doubleTap ? { ...gestures.doubleTap } : undefined,
    tripleTap: gestures.tripleTap ? { ...gestures.tripleTap } : undefined,
    quadTap: gestures.quadTap ? { ...gestures.quadTap } : undefined,
  })

  private detectGestures = (current: GestureData): void => {
    const last = this.lastGestures
    if (!last) return

    for (const tapType of TAP_TYPES) {
      const currentCounts = current[tapType]
      const lastCounts = last[tapType]

      if (!currentCounts || !lastCounts) continue

      // Counter reset detection: pod firmware restart resets counters to 0.
      // If either side decreases we re-baseline without emitting a gesture.
      if (currentCounts.l < lastCounts.l || currentCounts.r < lastCounts.r) {
        console.warn(
          `[DacMonitor] Gesture counter reset for ${tapType} `
          + `(l: ${lastCounts.l}→${currentCounts.l}, r: ${lastCounts.r}→${currentCounts.r}); re-baselining`
        )
        this.lastGestures = this.extractGestureCounters(current)
        return
      }

      if (currentCounts.l > lastCounts.l) {
        this.emit('gesture:detected', { side: 'left', tapType, timestamp: new Date() })
      }

      if (currentCounts.r > lastCounts.r) {
        this.emit('gesture:detected', { side: 'right', tapType, timestamp: new Date() })
      }
    }
  }
}

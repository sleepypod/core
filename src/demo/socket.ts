import type * as SensorFrames from './sensorFrames'

type Frames = typeof SensorFrames

// Gated on the build-time flag so non-demo builds drop the frame generators entirely.
const loadFrames = (): Promise<Frames> => process.env.NEXT_PUBLIC_DEMO === '1'
  ? import('./sensorFrames')
  : Promise.reject(new Error('Demo mode is disabled'))

/**
 * Stands in for the piezoStream WebSocket. Emits firmware-shaped (wire) frames
 * so the real client-side normalizer runs exactly as it does against a pod.
 */
class DemoSensorSocket {
  readyState: number = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  private frames: Frames | null = null
  private timers: ReturnType<typeof setInterval>[] = []

  constructor() {
    loadFrames().then((frames) => {
      if (this.readyState !== 0) return
      this.frames = frames
      this.readyState = 1
      this.onopen?.()
    }, () => {
      this.onerror?.()
      this.close()
    })
  }

  send(raw: string) {
    const f = this.frames
    if (!f) return
    const msg = JSON.parse(raw) as { type: string, snapshot?: boolean, timestamp?: number, requestId?: number }
    switch (msg.type) {
      case 'subscribe':
        this.emit({ type: 'subscribed', sensors: f.ALL_SENSORS })
        if (msg.snapshot) this.emit(f.snapshotMessage())
        this.startStreaming(f)
        break
      case 'get_time_range':
        this.emit({ type: 'time_range', min: f.nowSec() - 6 * 3600, max: f.nowSec(), file: null })
        break
      case 'seek':
        this.emit({ type: 'seek_complete' })
        break
      case 'get_waveform': {
        const at = Math.floor(msg.timestamp ?? f.nowSec())
        const frames = Array.from({ length: 10 }, (_, i) => f.piezoFrame(at - 9 + i))
        setTimeout(() => this.emit({ type: 'waveform', requestId: msg.requestId, frames }), 200)
        break
      }
    }
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    setTimeout(() => this.onclose?.(), 0)
  }

  private emit(payload: unknown) {
    if (this.readyState !== 1) return
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  private startStreaming(f: Frames) {
    if (this.timers.length > 0) return
    const every = (ms: number, fn: () => void) => this.timers.push(setInterval(fn, ms))
    every(1000, () => this.emit(f.piezoFrame(f.nowSec())))
    every(500, () => this.emit(f.capSenseFrame(f.nowSec())))
    every(2000, () => this.emit(f.deviceStatusFrame()))
    every(1500, () => this.emit(f.logFrame(f.nowSec())))
    every(10_000, () => {
      const ts = f.nowSec()
      this.emit(f.bedTempFrame(ts))
      for (const frame of f.freezerFrames(ts)) this.emit(frame)
    })
  }
}

export function createDemoSocket(): WebSocket {
  return new DemoSensorSocket() as unknown as WebSocket
}

'use client'

import { useCallback, useRef, useEffect, useState } from 'react'
import { useOnSensorFrame } from '@/src/hooks/useSensorStream'

// Event types we track, with display config
const LANES = [
  { type: 'deviceStatus', label: 'Status', color: '#38bdf8', shortLabel: 'STS' },
  { type: 'piezo-dual', label: 'Piezo', color: '#a78bfa', shortLabel: 'PZO' },
  { type: 'capSense2', label: 'Presence', color: '#4ade80', shortLabel: 'CAP' },
  { type: 'bedTemp2', label: 'Bed Temp', color: '#fb923c', shortLabel: 'TMP' },
  { type: 'frzHealth', label: 'Freezer', color: '#60a5fa', shortLabel: 'FRZ' },
  { type: 'log', label: 'Log', color: '#fbbf24', shortLabel: 'LOG' },
  { type: 'gesture', label: 'Gesture', color: '#f472b6', shortLabel: 'TAP' },
] as const

type LaneType = (typeof LANES)[number]['type']

interface EventDot {
  type: LaneType
  ts: number
}

const WINDOW_MS = 30_000 // 30 seconds visible window
const MAX_EVENTS = 500

/**
 * Live event timeline — shows the cadence of all WS frame types as dots
 * on horizontal lanes, scrolling left in real time. Reveals the pod's
 * rhythm: 2s device status, ~1Hz piezo, ~2Hz capSense, etc.
 */
export function EventTimeline() {
  const eventsRef = useRef<EventDot[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const countsRef = useRef<Record<string, number>>({})

  // Accumulate events from all frame types
  useOnSensorFrame(useCallback((frame: { type: string }) => {
    const type = frame.type as LaneType
    if (!LANES.find(l => l.type === type)) return
    const now = Date.now()
    eventsRef.current.push({ type, ts: now })
    // Trim old events
    if (eventsRef.current.length > MAX_EVENTS) {
      eventsRef.current = eventsRef.current.slice(-MAX_EVENTS)
    }
    // Count
    countsRef.current[type] = (countsRef.current[type] ?? 0) + 1
  }, []))

  // Update displayed counts every second
  useEffect(() => {
    const interval = setInterval(() => {
      setCounts({ ...countsRef.current })
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // Canvas animation loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const draw = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)

      const W = rect.width
      const H = rect.height
      const laneH = H / LANES.length
      const now = Date.now()
      const windowStart = now - WINDOW_MS

      // Clear
      ctx.clearRect(0, 0, W, H)

      // Draw lane separators
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'
      ctx.lineWidth = 1
      for (let i = 1; i < LANES.length; i++) {
        ctx.beginPath()
        ctx.moveTo(0, i * laneH)
        ctx.lineTo(W, i * laneH)
        ctx.stroke()
      }

      // Draw time markers (every 5s)
      ctx.fillStyle = 'rgba(255,255,255,0.06)'
      ctx.font = '8px monospace'
      for (let t = 5; t < WINDOW_MS / 1000; t += 5) {
        const x = W - (t / (WINDOW_MS / 1000)) * W
        ctx.fillRect(x, 0, 1, H)
        if (t % 10 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.15)'
          ctx.fillText(`-${t}s`, x + 2, H - 2)
          ctx.fillStyle = 'rgba(255,255,255,0.06)'
        }
      }

      // Draw event dots
      const events = eventsRef.current
      for (const ev of events) {
        if (ev.ts < windowStart) continue
        const lane = LANES.findIndex(l => l.type === ev.type)
        if (lane === -1) continue

        const x = ((ev.ts - windowStart) / WINDOW_MS) * W
        const y = lane * laneH + laneH / 2
        const age = (now - ev.ts) / WINDOW_MS // 0 = new, 1 = old
        const alpha = Math.max(0.15, 1 - age * 0.8)
        const config = LANES[lane]

        // Glow
        ctx.beginPath()
        ctx.arc(x, y, age < 0.05 ? 5 : 3, 0, Math.PI * 2)
        ctx.fillStyle = config.color + Math.round(alpha * 40).toString(16).padStart(2, '0')
        ctx.fill()

        // Dot
        ctx.beginPath()
        ctx.arc(x, y, age < 0.05 ? 3 : 1.5, 0, Math.PI * 2)
        ctx.fillStyle = config.color + Math.round(alpha * 255).toString(16).padStart(2, '0')
        ctx.fill()
      }

      // Prune old events
      eventsRef.current = events.filter(ev => ev.ts >= windowStart)

      animRef.current = requestAnimationFrame(draw)
    }

    animRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animRef.current)
  }, [])

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-zinc-300">Event Bus</span>
        <span className="text-[9px] text-zinc-600 tabular-nums">30s window</span>
      </div>
      <div className="flex gap-1">
        {/* Lane labels */}
        <div className="flex flex-col justify-around shrink-0 w-8">
          {LANES.map(lane => (
            <div
              key={lane.type}
              className="text-[8px] font-mono leading-none"
              style={{ color: lane.color + 'aa' }}
            >
              {lane.shortLabel}
            </div>
          ))}
        </div>
        {/* Canvas */}
        <canvas
          ref={canvasRef}
          className="flex-1 rounded-lg bg-black/40"
          style={{ height: LANES.length * 18 }}
        />
        {/* Counts */}
        <div className="flex flex-col justify-around shrink-0 w-8">
          {LANES.map(lane => (
            <div
              key={lane.type}
              className="text-[8px] font-mono tabular-nums text-right leading-none text-zinc-600"
            >
              {counts[lane.type] ?? 0}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

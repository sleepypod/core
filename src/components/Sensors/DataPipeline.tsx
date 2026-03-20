'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOnSensorFrame, useSensorStreamStatus } from '@/src/hooks/useSensorStream'
import type { SensorFrame } from '@/src/hooks/useSensorStream'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONSUMER_NODES = [
  { key: 'piezo', label: 'Piezo', color: '#a78bfa', types: ['piezo-dual'] },
  { key: 'presence', label: 'Presence', color: '#4ade80', types: ['capSense', 'capSense2'] },
  { key: 'bedTemp', label: 'Bed Temp', color: '#fb923c', types: ['bedTemp', 'bedTemp2'] },
  { key: 'freezer', label: 'Freezer', color: '#60a5fa', types: ['frzTemp', 'frzHealth', 'frzTherm'] },
  { key: 'status', label: 'Device', color: '#38bdf8', types: ['deviceStatus'] },
  { key: 'log', label: 'Log', color: '#fbbf24', types: ['log'] },
] as const

type ConsumerKey = (typeof CONSUMER_NODES)[number]['key']

const TYPE_TO_CONSUMER = new Map<string, ConsumerKey>()
for (const node of CONSUMER_NODES) {
  for (const t of node.types) TYPE_TO_CONSUMER.set(t, node.key)
}

const TIMELINE_WINDOW_MS = 30_000
const MAX_EVENTS = 500
const RATE_WINDOW_MS = 10_000
const PULSE_DURATION_MS = 300

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TimelineDot {
  type: string
  consumer: ConsumerKey
  ts: number
}

function formatRate(count: number, windowSec: number): string {
  const rate = count / windowSec
  if (rate >= 1) return `${rate.toFixed(1)}/s`
  if (rate > 0) return `${(rate * 60).toFixed(0)}/m`
  return ''
}

/**
 * Unified data pipeline visualization:
 * - Top: DAG showing firmware → CBOR → WS → consumer nodes
 * - Edges pulse/highlight when frames flow through
 * - Bottom: scrolling timeline canvas showing frame cadence per lane
 */
export function DataPipeline() {
  const wsStatus = useSensorStreamStatus()
  const eventsRef = useRef<TimelineDot[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)

  // Per-consumer pulse state: timestamp of last frame (for glow decay)
  const lastPulseRef = useRef<Record<string, number>>({})
  const [pulseState, setPulseState] = useState<Record<string, number>>({})

  // Rate tracking
  const rateWindowRef = useRef<{ type: string; ts: number }[]>([])
  const [rates, setRates] = useState<Record<string, number>>({})
  const [totalCount, setTotalCount] = useState(0)

  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    const consumer = TYPE_TO_CONSUMER.get(frame.type)
    if (!consumer) return

    const now = Date.now()

    // Timeline event
    eventsRef.current.push({ type: frame.type, consumer, ts: now })
    if (eventsRef.current.length > MAX_EVENTS) {
      eventsRef.current = eventsRef.current.slice(-MAX_EVENTS)
    }

    // Pulse the consumer node
    lastPulseRef.current[consumer] = now

    // Rate tracking
    rateWindowRef.current.push({ type: frame.type, ts: now })
  }, []))

  // Update pulse state + rates every 100ms for smooth glow decay
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()

      // Pulse state
      const newPulse: Record<string, number> = {}
      for (const [key, ts] of Object.entries(lastPulseRef.current)) {
        const age = now - ts
        if (age < PULSE_DURATION_MS) {
          newPulse[key] = 1 - age / PULSE_DURATION_MS // 1 = just fired, 0 = faded
        }
      }
      setPulseState(newPulse)

      // Rates (every second)
      const cutoff = now - RATE_WINDOW_MS
      rateWindowRef.current = rateWindowRef.current.filter(e => e.ts >= cutoff)
      const perConsumer: Record<string, number> = {}
      for (const e of rateWindowRef.current) {
        const c = TYPE_TO_CONSUMER.get(e.type)
        if (c) perConsumer[c] = (perConsumer[c] ?? 0) + 1
      }
      setRates(perConsumer)
      setTotalCount(rateWindowRef.current.length)
    }, 100)
    return () => clearInterval(interval)
  }, [])

  // Canvas animation for timeline
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
      const laneH = H / CONSUMER_NODES.length
      const now = Date.now()
      const windowStart = now - TIMELINE_WINDOW_MS

      ctx.clearRect(0, 0, W, H)

      // Lane separators
      ctx.strokeStyle = 'rgba(255,255,255,0.03)'
      ctx.lineWidth = 1
      for (let i = 1; i < CONSUMER_NODES.length; i++) {
        ctx.beginPath()
        ctx.moveTo(0, i * laneH)
        ctx.lineTo(W, i * laneH)
        ctx.stroke()
      }

      // Time markers
      ctx.fillStyle = 'rgba(255,255,255,0.05)'
      ctx.font = '7px monospace'
      for (let t = 5; t < TIMELINE_WINDOW_MS / 1000; t += 5) {
        const x = W - (t / (TIMELINE_WINDOW_MS / 1000)) * W
        ctx.fillRect(x, 0, 1, H)
        if (t % 10 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.12)'
          ctx.fillText(`-${t}s`, x + 2, H - 2)
          ctx.fillStyle = 'rgba(255,255,255,0.05)'
        }
      }

      // Event dots
      const events = eventsRef.current
      for (const ev of events) {
        if (ev.ts < windowStart) continue
        const laneIdx = CONSUMER_NODES.findIndex(n => n.key === ev.consumer)
        if (laneIdx === -1) continue

        const x = ((ev.ts - windowStart) / TIMELINE_WINDOW_MS) * W
        const y = laneIdx * laneH + laneH / 2
        const age = (now - ev.ts) / TIMELINE_WINDOW_MS
        const alpha = Math.max(0.12, 1 - age * 0.85)
        const config = CONSUMER_NODES[laneIdx]

        // Glow for recent dots
        if (age < 0.02) {
          ctx.beginPath()
          ctx.arc(x, y, 6, 0, Math.PI * 2)
          ctx.fillStyle = config.color + '30'
          ctx.fill()
        }

        // Dot
        ctx.beginPath()
        ctx.arc(x, y, age < 0.02 ? 2.5 : 1.5, 0, Math.PI * 2)
        ctx.fillStyle = config.color + Math.round(alpha * 255).toString(16).padStart(2, '0')
        ctx.fill()
      }

      // Prune
      eventsRef.current = events.filter(ev => ev.ts >= windowStart)

      animRef.current = requestAnimationFrame(draw)
    }

    animRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animRef.current)
  }, [])

  const windowSec = RATE_WINDOW_MS / 1000
  const totalRate = formatRate(totalCount, windowSec)
  const wsColor = wsStatus === 'connected' ? '#22c55e' : wsStatus === 'connecting' ? '#eab308' : '#ef4444'

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">Data Pipeline</span>
        <span className="text-[9px] tabular-nums text-zinc-600">
          {totalRate && `${totalRate} total · `}30s window
        </span>
      </div>

      {/* DAG: source → WS → consumers */}
      <div className="mb-2 space-y-1">
        {/* Source row */}
        <div className="flex items-center justify-center gap-1">
          <PipeNode label="Firmware" sub="dac.sock + RAW" color="#52525b" />
          <PipeArrow color="#52525b" />
          <PipeNode
            label="WebSocket"
            sub={`:3001 · ${wsStatus}`}
            color={wsColor}
            intensity={wsStatus === 'connected' ? 0.3 : 0}
          />
        </div>

        {/* Fan-out edges + consumer nodes — grid-aligned */}
        <div className={`grid gap-1`} style={{ gridTemplateColumns: `repeat(${CONSUMER_NODES.length}, 1fr)` }}>
          {/* SVG edges spanning the full grid — one column per consumer */}
          <div className="col-span-full relative" style={{ height: 28 }}>
            <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
              {CONSUMER_NODES.map((node, i) => {
                const n = CONSUMER_NODES.length
                // Center of each grid column as a fraction (0-1)
                const cx = (i + 0.5) / n
                const centerX = 0.5 // WS node is centered above
                const intensity = pulseState[node.key] ?? 0
                return (
                  <g key={node.key}>
                    {/* Trunk: center top → rail */}
                    <line x1={`${centerX * 100}%`} y1="0" x2={`${centerX * 100}%`} y2="35%" stroke="#333" strokeWidth="1" />
                    {/* Horizontal rail segment: center → this column */}
                    <line x1={`${Math.min(centerX, cx) * 100}%`} y1="35%" x2={`${Math.max(centerX, cx) * 100}%`} y2="35%" stroke="#333" strokeWidth="1" />
                    {/* Drop line: rail → bottom */}
                    <line x1={`${cx * 100}%`} y1="35%" x2={`${cx * 100}%`} y2="100%" stroke="#333" strokeWidth="1" />

                    {/* Pulse overlays */}
                    {intensity > 0 && (
                      <>
                        <line x1={`${centerX * 100}%`} y1="0" x2={`${centerX * 100}%`} y2="35%" stroke={node.color} strokeWidth="2" strokeOpacity={intensity * 0.4} />
                        <line x1={`${Math.min(centerX, cx) * 100}%`} y1="35%" x2={`${Math.max(centerX, cx) * 100}%`} y2="35%" stroke={node.color} strokeWidth="2" strokeOpacity={intensity * 0.6} />
                        <line x1={`${cx * 100}%`} y1="35%" x2={`${cx * 100}%`} y2="100%" stroke={node.color} strokeWidth="2" strokeOpacity={intensity * 0.8} />
                        <circle cx={`${cx * 100}%`} cy="100%" r="4" fill={node.color} fillOpacity={intensity * 0.35} />
                      </>
                    )}
                  </g>
                )
              })}
            </svg>
          </div>

          {/* Consumer nodes — one per grid column, aligned under their drop line */}
          {CONSUMER_NODES.map(node => {
            const intensity = pulseState[node.key] ?? 0
            const rate = formatRate(rates[node.key] ?? 0, windowSec)
            return (
              <div key={node.key} className="flex justify-center">
                <PipeNode
                  label={node.label}
                  sub={rate}
                  color={node.color}
                  intensity={intensity}
                  small
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* Timeline canvas */}
      <div className="flex gap-1">
        <div className="flex flex-col justify-around shrink-0 w-7">
          {CONSUMER_NODES.map(node => (
            <div
              key={node.key}
              className="text-[7px] font-mono leading-none"
              style={{ color: node.color + 'aa' }}
            >
              {node.label.slice(0, 3).toUpperCase()}
            </div>
          ))}
        </div>
        <canvas
          ref={canvasRef}
          className="flex-1 rounded-lg bg-black/40"
          style={{ height: CONSUMER_NODES.length * 16 }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PipeNode({
  label, sub, color, intensity = 0, small,
}: {
  label: string
  sub: string
  color: string
  intensity?: number
  small?: boolean
}) {
  return (
    <div
      className={[
        'relative flex flex-col items-center rounded-md border transition-all duration-150',
        small ? 'min-w-[40px] px-1 py-0.5' : 'min-w-[70px] px-1.5 py-1',
      ].join(' ')}
      style={{
        borderColor: `${color}${Math.round((0.2 + intensity * 0.6) * 255).toString(16).padStart(2, '0')}`,
        boxShadow: intensity > 0 ? `0 0 ${4 + intensity * 8}px ${color}${Math.round(intensity * 0.3 * 255).toString(16).padStart(2, '0')}` : 'none',
      }}
    >
      {intensity > 0 && (
        <div
          className="absolute inset-0 rounded-md transition-opacity duration-150"
          style={{ backgroundColor: color, opacity: intensity * 0.12 }}
        />
      )}
      <span
        className={`relative font-medium leading-tight ${small ? 'text-[7px]' : 'text-[9px]'}`}
        style={{ color }}
      >
        {label}
      </span>
      {sub && (
        <span className={`relative leading-tight text-zinc-600 ${small ? 'text-[6px]' : 'text-[7px]'}`}>
          {sub}
        </span>
      )}
    </div>
  )
}

function PipeArrow({ color }: { color: string }) {
  return (
    <svg width="16" height="8" viewBox="0 0 16 8" className="shrink-0">
      <line x1="0" y1="4" x2="11" y2="4" stroke={color} strokeWidth="1" />
      <path d="M9 1 L14 4 L9 7" fill="none" stroke={color} strokeWidth="1" />
    </svg>
  )
}

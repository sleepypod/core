'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  BackgroundVariant,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
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

// ---------------------------------------------------------------------------
// Custom ReactFlow node — static, no dynamic data
// ---------------------------------------------------------------------------

interface PipelineNodeData {
  label: string
  sub: string
  color: string
  [key: string]: unknown
}

function PipelineNode({ data }: { data: PipelineNodeData }) {
  const { label, sub, color } = data
  return (
    <div
      className="flex flex-col rounded-md border px-2 py-1.5"
      style={{
        minWidth: 130,
        borderColor: '#333',
        borderLeftWidth: 1,
        borderLeftColor: color,
        background: '#0a0a0a',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden', width: 0, height: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden', width: 0, height: 0 }} />
      <span className="text-[10px] font-medium leading-tight" style={{ color }}>
        {label}
      </span>
      {sub && (
        <span className="text-[8px] leading-tight text-zinc-500">
          {sub}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline dot type
// ---------------------------------------------------------------------------

interface TimelineDot {
  type: string
  consumer: ConsumerKey
  ts: number
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Data pipeline visualization: static ReactFlow DAG + live canvas timeline.
 *
 * ReactFlow renders a static DAG (no dynamic node data) to avoid infinite
 * render loops from its internal zustand store. All live data (rates, activity)
 * is rendered via the canvas timeline only.
 */
export function DataPipeline() {
  const wsStatus = useSensorStreamStatus()
  const eventsRef = useRef<TimelineDot[]>([])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)

  // Track frames via ref only — no React state for high-frequency data
  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    const consumer = TYPE_TO_CONSUMER.get(frame.type)
    if (!consumer) return
    eventsRef.current.push({ type: frame.type, consumer, ts: Date.now() })
    if (eventsRef.current.length > MAX_EVENTS) {
      eventsRef.current = eventsRef.current.slice(-MAX_EVENTS)
    }
  }, []))

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

        if (age < 0.02) {
          ctx.beginPath()
          ctx.arc(x, y, 6, 0, Math.PI * 2)
          ctx.fillStyle = config.color + '30'
          ctx.fill()
        }

        ctx.beginPath()
        ctx.arc(x, y, age < 0.02 ? 2.5 : 1.5, 0, Math.PI * 2)
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

  // ---------------------------------------------------------------------------
  // Static ReactFlow DAG — no dynamic data in nodes to avoid render loops
  // ---------------------------------------------------------------------------

  const nodeTypes = useMemo(() => ({ pipeline: PipelineNode }), [])

  const CX = 130
  const LX = 0
  const RX = 260
  const RY = 80

  const wsColor = wsStatus === 'connected' ? '#22c55e' : wsStatus === 'connecting' ? '#eab308' : '#ef4444'

  const nodes = useMemo<Node[]>(() => [
    { id: 'firmware', type: 'pipeline', position: { x: CX, y: 0 },
      data: { label: 'Firmware', sub: 'frankenfirmware', color: '#71717a' } },
    { id: 'raw', type: 'pipeline', position: { x: LX, y: RY },
      data: { label: 'RAW Files', sub: 'CBOR on disk', color: '#71717a' } },
    { id: 'dac-transport', type: 'pipeline', position: { x: CX, y: RY },
      data: { label: 'dacTransport', sub: 'dac.sock', color: '#a1a1aa' } },
    { id: 'piezo-stream', type: 'pipeline', position: { x: LX, y: RY * 2 },
      data: { label: 'piezoStream', sub: 'tails + parses', color: '#8b5cf6' } },
    { id: 'dac-monitor', type: 'pipeline', position: { x: CX, y: RY * 2 },
      data: { label: 'DacMonitor', sub: 'polls 2s', color: '#3b82f6' } },
    { id: 'trpc', type: 'pipeline', position: { x: RX, y: RY * 2 },
      data: { label: 'tRPC :3000', sub: 'mutations', color: '#f97316' } },
    { id: 'broadcast', type: 'pipeline', position: { x: LX + 65, y: RY * 3 },
      data: { label: 'broadcastFrame()', sub: 'event bus', color: '#a78bfa' } },
    { id: 'ws', type: 'pipeline', position: { x: LX + 65, y: RY * 4 },
      data: { label: 'WebSocket :3001', sub: wsStatus, color: wsColor } },
    { id: 'browser', type: 'pipeline', position: { x: CX, y: RY * 5 },
      data: { label: 'Browser', sub: 'React UI', color: '#e2e8f0' } },
  ], [wsStatus, wsColor])

  const edges = useMemo<Edge[]>(() => [
    { id: 'fw-raw', source: 'firmware', target: 'raw', animated: true, style: { stroke: '#52525b' } },
    { id: 'fw-dt', source: 'firmware', target: 'dac-transport', animated: true, style: { stroke: '#a1a1aa' } },
    { id: 'raw-ps', source: 'raw', target: 'piezo-stream', animated: true, style: { stroke: '#8b5cf6' } },
    { id: 'dt-dm', source: 'dac-transport', target: 'dac-monitor', animated: true, style: { stroke: '#3b82f6' } },
    { id: 'ps-bc', source: 'piezo-stream', target: 'broadcast', animated: true, style: { stroke: '#8b5cf6' } },
    { id: 'dm-bc', source: 'dac-monitor', target: 'broadcast', animated: true, style: { stroke: '#3b82f6' } },
    { id: 'bc-ws', source: 'broadcast', target: 'ws', animated: true, style: { stroke: '#a78bfa' } },
    { id: 'ws-browser', source: 'ws', target: 'browser', animated: true, style: { stroke: wsColor } },
    { id: 'browser-trpc', source: 'browser', target: 'trpc', animated: true, style: { stroke: '#f97316', strokeDasharray: '5 3' } },
    { id: 'trpc-dt', source: 'trpc', target: 'dac-transport', animated: true, style: { stroke: '#f97316', strokeDasharray: '5 3' } },
  ], [wsColor])

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">Data Pipeline</span>
        <div className="flex items-center gap-2 text-[8px] text-zinc-600">
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-px bg-blue-400" /> read &darr;</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-px bg-orange-400" style={{ borderBottom: '1px dashed #f97316' }} /> write &uarr;</span>
        </div>
      </div>

      {/* ReactFlow DAG — static nodes, no dynamic data */}
      <div className="mb-2 rounded-lg" style={{ height: 340, background: '#0a0a0a' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          nodesDraggable={false}
          nodesConnectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          preventScrolling={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={0.5} color="#222" />
        </ReactFlow>
      </div>

      {/* Timeline canvas with lane labels */}
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
        <div className="relative flex-1">
          <canvas
            ref={canvasRef}
            className="w-full rounded-lg bg-black/40"
            style={{ height: CONSUMER_NODES.length * 16 }}
          />
          <span className="absolute bottom-1 right-2 text-[8px] tabular-nums text-zinc-600">
            30s
          </span>
        </div>
      </div>
    </div>
  )
}

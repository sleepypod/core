'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOnSensorFrame, useSensorStreamStatus } from '@/src/hooks/useSensorStream'
import type { SensorFrame } from '@/src/hooks/useSensorStream'

/**
 * Live data flow DAG — shows the real-time pipeline from firmware through
 * the WS event bus to browser consumers. Each node shows frames/sec.
 *
 * Pipeline:
 *   dac.sock → RAW files → CBOR decode → WebSocket :3001 → Browser
 *                                              ↓
 *                        ┌──────────┬──────────┼──────────┬──────────┐
 *                      piezo    capSense    bedTemp    frzHealth   status
 */

interface NodeRate {
  total: number
  perType: Record<string, number>
}

const TYPE_GROUPS: Record<string, { label: string, color: string, types: string[] }> = {
  piezo: { label: 'Piezo BCG', color: '#a78bfa', types: ['piezo-dual'] },
  presence: { label: 'Presence', color: '#4ade80', types: ['capSense', 'capSense2'] },
  bedTemp: { label: 'Bed Temp', color: '#fb923c', types: ['bedTemp', 'bedTemp2'] },
  freezer: { label: 'Freezer', color: '#60a5fa', types: ['frzTemp', 'frzHealth', 'frzTherm'] },
  status: { label: 'Device', color: '#38bdf8', types: ['deviceStatus'] },
  log: { label: 'Firmware', color: '#fbbf24', types: ['log'] },
}

function formatRate(count: number, windowSec: number): string {
  const rate = count / windowSec
  if (rate >= 1) return `${rate.toFixed(1)}/s`
  if (rate > 0) return `${(rate * 60).toFixed(0)}/m`
  return '—'
}

export function DataFlowDag() {
  const wsStatus = useSensorStreamStatus()
  const countsRef = useRef<Record<string, number>>({})
  const windowRef = useRef<{ type: string, ts: number }[]>([])
  const [rates, setRates] = useState<NodeRate>({ total: 0, perType: {} })

  const RATE_WINDOW_MS = 10_000

  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    countsRef.current[frame.type] = (countsRef.current[frame.type] ?? 0) + 1
    windowRef.current.push({ type: frame.type, ts: Date.now() })
  }, []))

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      const cutoff = now - RATE_WINDOW_MS
      windowRef.current = windowRef.current.filter(e => e.ts >= cutoff)

      const perType: Record<string, number> = {}
      for (const e of windowRef.current) {
        perType[e.type] = (perType[e.type] ?? 0) + 1
      }
      setRates({ total: windowRef.current.length, perType })
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const windowSec = RATE_WINDOW_MS / 1000
  const totalRate = formatRate(rates.total, windowSec)

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">Data Flow</span>
        <span className="text-[9px] tabular-nums text-zinc-600">
          {totalRate}
          {' '}
          total
        </span>
      </div>

      {/* Pipeline visualization */}
      <div className="space-y-1.5">
        {/* Source row */}
        <div className="flex items-center justify-center gap-1.5">
          <DagNode label="Firmware" sub="dac.sock" color="#71717a" />
          <Arrow />
          <DagNode label="RAW Files" sub="/persistent" color="#71717a" />
          <Arrow />
          <DagNode label="CBOR Decode" sub="piezoStream" color="#71717a" />
          <Arrow />
          <DagNode
            label="WebSocket"
            sub={`:3001 · ${wsStatus}`}
            color={wsStatus === 'connected' ? '#22c55e' : wsStatus === 'connecting' ? '#eab308' : '#ef4444'}
            pulse={wsStatus === 'connected'}
          />
        </div>

        {/* Fan-out arrow */}
        <div className="flex justify-center">
          <svg width="200" height="16" viewBox="0 0 200 16" className="text-zinc-700">
            <line x1="100" y1="0" x2="100" y2="8" stroke="currentColor" strokeWidth="1" />
            <line x1="16" y1="8" x2="184" y2="8" stroke="currentColor" strokeWidth="1" />
            {[16, 52, 88, 124, 148, 184].map(x => (
              <line key={x} x1={x} y1="8" x2={x} y2="16" stroke="currentColor" strokeWidth="1" />
            ))}
          </svg>
        </div>

        {/* Consumer row */}
        <div className="flex items-start justify-center gap-1">
          {Object.entries(TYPE_GROUPS).map(([key, group]) => {
            const count = group.types.reduce((sum, t) => sum + (rates.perType[t] ?? 0), 0)
            return (
              <DagNode
                key={key}
                label={group.label}
                sub={formatRate(count, windowSec)}
                color={group.color}
                pulse={count > 0}
                small
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function DagNode({
  label, sub, color, pulse, small,
}: {
  label: string
  sub: string
  color: string
  pulse?: boolean
  small?: boolean
}) {
  return (
    <div
      className={[
        'relative flex flex-col items-center rounded-md border px-1.5 py-1',
        small ? 'min-w-[48px]' : 'min-w-[60px]',
        pulse ? 'border-opacity-40' : 'border-opacity-20',
      ].join(' ')}
      style={{ borderColor: color }}
    >
      {pulse && (
        <div
          className="absolute inset-0 rounded-md opacity-10"
          style={{ backgroundColor: color }}
        />
      )}
      <span
        className={`font-medium leading-tight ${small ? 'text-[8px]' : 'text-[9px]'}`}
        style={{ color }}
      >
        {label}
      </span>
      <span className="text-[7px] leading-tight text-zinc-600">{sub}</span>
    </div>
  )
}

function Arrow() {
  return (
    <svg width="12" height="8" viewBox="0 0 12 8" className="shrink-0 text-zinc-700">
      <line x1="0" y1="4" x2="8" y2="4" stroke="currentColor" strokeWidth="1" />
      <path d="M6 1 L10 4 L6 7" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

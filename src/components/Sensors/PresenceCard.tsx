'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSensorFrame, useOnSensorFrame } from '@/src/hooks/useSensorStream'
import type { CapSenseFrame, CapSense2Frame, SensorFrame } from '@/src/hooks/useSensorStream'
import { Brain, PersonStanding, Footprints } from 'lucide-react'

/**
 * Variance-based presence detection.
 * Maintains a sliding window of capSense readings per side and computes
 * per-channel standard deviation. Max variance > threshold = occupied.
 * Matches iOS SensorStreamService.isOccupied() logic.
 */

const VARIANCE_WINDOW = 20
const PRESENCE_THRESHOLD = 0.05 // variance threshold matching iOS
const ACTIVITY_NORMALIZE = 0.5  // max variance for 100% bar fill

interface VarianceState {
  leftHistory: number[][] // [frame][channel]
  rightHistory: number[][]
  leftVariance: number[]
  rightVariance: number[]
  leftOccupied: boolean
  rightOccupied: boolean
}

function computeVariance(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sq = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(sq)
}

function formatTimestamp(ts: number | undefined): string {
  if (!ts) return '--'
  const date = new Date(ts * 1000)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface ZoneRowProps {
  zone: number
  label: string
  icon: React.ReactNode
  leftVariance: number[]
  rightVariance: number[]
}

function ZoneActivityRow({ zone, label, icon, leftVariance, rightVariance }: ZoneRowProps) {
  // Each zone maps to 2 channels (zone*2, zone*2+1)
  const leftVar = Math.max(leftVariance[zone * 2] ?? 0, leftVariance[zone * 2 + 1] ?? 0)
  const rightVar = Math.max(rightVariance[zone * 2] ?? 0, rightVariance[zone * 2 + 1] ?? 0)
  const leftPct = Math.min(leftVar / ACTIVITY_NORMALIZE, 1)
  const rightPct = Math.min(rightVar / ACTIVITY_NORMALIZE, 1)

  return (
    <div className="flex h-5 items-center gap-0">
      {/* Left activity bar — grows from right to left */}
      <div className="relative flex-1 h-full">
        <div className="absolute inset-0 rounded-sm bg-zinc-800/30" />
        <div
          className="absolute inset-y-0 right-0 rounded-sm transition-all duration-300"
          style={{
            width: `${leftPct * 100}%`,
            backgroundColor: `rgba(74, 158, 255, ${leftPct > 0.05 ? 0.2 + leftPct * 0.6 : 0.03})`,
          }}
        />
        <span className={`absolute left-1 top-1/2 -translate-y-1/2 font-mono text-[7px] ${
          leftPct > 0.1 ? 'text-[#4a9eff]' : 'text-zinc-600'
        }`}>
          {leftVar.toFixed(2)}
        </span>
      </div>

      {/* Center label */}
      <div className="flex w-9 flex-col items-center justify-center">
        <span className="text-zinc-500">{icon}</span>
        <span className="text-[7px] font-semibold text-zinc-500">{label}</span>
      </div>

      {/* Right activity bar — grows from left to right */}
      <div className="relative flex-1 h-full">
        <div className="absolute inset-0 rounded-sm bg-zinc-800/30" />
        <div
          className="absolute inset-y-0 left-0 rounded-sm transition-all duration-300"
          style={{
            width: `${rightPct * 100}%`,
            backgroundColor: `rgba(64, 224, 208, ${rightPct > 0.05 ? 0.2 + rightPct * 0.6 : 0.03})`,
          }}
        />
        <span className={`absolute right-1 top-1/2 -translate-y-1/2 font-mono text-[7px] ${
          rightPct > 0.1 ? 'text-[#40e0d0]' : 'text-zinc-600'
        }`}>
          {rightVar.toFixed(2)}
        </span>
      </div>
    </div>
  )
}

/**
 * Shows real-time bed presence from capacitive sensors with zone activity bars.
 * Displays left/right side occupied status with head/torso/legs activity breakdown.
 * Matches iOS BedSensorScreen presenceCard layout.
 */
export function PresenceCard() {
  const capSense = useSensorFrame('capSense')
  const capSense2 = useSensorFrame('capSense2')
  const frame: CapSenseFrame | CapSense2Frame | undefined = capSense2 ?? capSense

  // Variance tracking state
  const [variance, setVariance] = useState<VarianceState>({
    leftHistory: [],
    rightHistory: [],
    leftVariance: [],
    rightVariance: [],
    leftOccupied: false,
    rightOccupied: false,
  })

  // Track variance from incoming capSense frames
  useOnSensorFrame(useCallback((f: SensorFrame) => {
    if (f.type !== 'capSense' && f.type !== 'capSense2') return

    const leftChannels = Array.isArray(f.left) ? f.left : [f.left]
    const rightChannels = Array.isArray(f.right) ? f.right : [f.right]

    setVariance(prev => {
      const newLeftHistory = [...prev.leftHistory, leftChannels].slice(-VARIANCE_WINDOW)
      const newRightHistory = [...prev.rightHistory, rightChannels].slice(-VARIANCE_WINDOW)

      // Compute per-channel variance (excluding REF channels 6,7)
      const numChannels = Math.max(leftChannels.length, 6)
      const leftVar: number[] = []
      const rightVar: number[] = []

      for (let ch = 0; ch < numChannels; ch++) {
        const leftVals = newLeftHistory.map(h => h[ch] ?? 0)
        const rightVals = newRightHistory.map(h => h[ch] ?? 0)
        leftVar.push(computeVariance(leftVals))
        rightVar.push(computeVariance(rightVals))
      }

      // Occupied = max variance > threshold
      const maxLeft = Math.max(...leftVar.slice(0, 6))
      const maxRight = Math.max(...rightVar.slice(0, 6))

      return {
        leftHistory: newLeftHistory,
        rightHistory: newRightHistory,
        leftVariance: leftVar,
        rightVariance: rightVar,
        leftOccupied: maxLeft > PRESENCE_THRESHOLD,
        rightOccupied: maxRight > PRESENCE_THRESHOLD,
      }
    })
  }, []))

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-purple-400">👤</span>
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Bed Presence
          </h3>
        </div>
        {frame && (
          <span className="text-[9px] text-zinc-600">
            {formatTimestamp(frame.ts)}
          </span>
        )}
      </div>

      {/* Status row — left and right occupied indicators */}
      <div className="flex items-center">
        <PresenceStatus
          label="Left"
          occupied={variance.leftOccupied}
          color="#4a9eff"
        />
        <div className="w-9" /> {/* spacer matching zone labels */}
        <PresenceStatus
          label="Right"
          occupied={variance.rightOccupied}
          color="#40e0d0"
        />
      </div>

      {/* Zone activity bars */}
      {variance.leftVariance.length > 0 && (
        <div className="space-y-1">
          <ZoneActivityRow
            zone={0}
            label="Head"
            icon={<Brain size={8} />}
            leftVariance={variance.leftVariance}
            rightVariance={variance.rightVariance}
          />
          <ZoneActivityRow
            zone={1}
            label="Torso"
            icon={<PersonStanding size={8} />}
            leftVariance={variance.leftVariance}
            rightVariance={variance.rightVariance}
          />
          <ZoneActivityRow
            zone={2}
            label="Legs"
            icon={<Footprints size={8} />}
            leftVariance={variance.leftVariance}
            rightVariance={variance.rightVariance}
          />
        </div>
      )}

      {/* No data state */}
      {!frame && (
        <div className="flex h-20 items-center justify-center rounded-xl bg-zinc-800/50">
          <span className="text-xs text-zinc-600">Waiting for presence data...</span>
        </div>
      )}
    </div>
  )
}

function PresenceStatus({
  label,
  occupied,
  color,
}: {
  label: string
  occupied: boolean
  color: string
}) {
  return (
    <div className="flex flex-1 items-center justify-center gap-1">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          backgroundColor: occupied ? color : 'rgba(113,113,122,0.2)',
          boxShadow: occupied ? `0 0 4px ${color}99` : 'none',
        }}
      />
      <span
        className="text-[10px] font-bold uppercase tracking-wider"
        style={{ color: occupied ? color : '#71717a' }}
      >
        {label}
      </span>
      <span className="text-[8px] text-zinc-600">
        {occupied ? 'Occupied' : 'Empty'}
      </span>
    </div>
  )
}

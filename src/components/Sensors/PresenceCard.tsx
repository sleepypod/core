'use client'

import { SensorAge } from './SensorAge'

import { useCallback, useState } from 'react'
import { useSensorFrame, useOnSensorFrame } from '@/src/hooks/useSensorStream'
import type { CapSenseFrame, CapSense2Frame, SensorFrame } from '@/src/hooks/useSensorStream'
import { useSideNames } from '@/src/hooks/useSideNames'
import { trpc } from '@/src/utils/trpc'
import { Card, SectionLabel, Skeleton, StatusDot } from '@/src/components/ds'

/**
 * Bed presence card.
 *
 * The in bed / empty label is driven by the shared virtual sensor on the
 * server (`trpc.biometrics.getOccupancy`) so HomeKit and the web app always
 * agree on bed state. The head/torso/legs bars are a live visualization of
 * capSense channel variance — useful for seeing what the sensor is doing
 * right now, but NOT the source of truth for occupancy.
 */

const VARIANCE_WINDOW = 20
const ACTIVITY_NORMALIZE = 0.5 // max variance for 100% bar fill
const OCCUPANCY_POLL_MS = 3_000
const ZONES = ['head', 'torso', 'legs'] as const

interface VarianceState {
  leftHistory: number[][]
  rightHistory: number[][]
  leftVariance: number[]
  rightVariance: number[]
}

function computeVariance(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sq = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(sq)
}

/** Zone activity 0..1 — each zone maps to 2 channels (zone*2, zone*2+1). */
export function zoneActivity(variance: number[], zone: number): number {
  const v = Math.max(variance[zone * 2] ?? 0, variance[zone * 2 + 1] ?? 0)
  return Math.min(v / ACTIVITY_NORMALIZE, 1)
}

export function PresenceCard() {
  const capSense = useSensorFrame('capSense')
  const capSense2 = useSensorFrame('capSense2')
  const frame: CapSenseFrame | CapSense2Frame | undefined = capSense2 ?? capSense
  const { sideName } = useSideNames()

  const occupancyQuery = trpc.biometrics.getOccupancy.useQuery(undefined, {
    refetchInterval: OCCUPANCY_POLL_MS,
    refetchOnWindowFocus: false,
  })

  // Zone activity bars: track per-channel variance over a sliding window of
  // live frames. This is purely a visualization — NOT used for the
  // in bed / empty judgement.
  const [variance, setVariance] = useState<VarianceState>({
    leftHistory: [],
    rightHistory: [],
    leftVariance: [],
    rightVariance: [],
  })

  useOnSensorFrame(useCallback((f: SensorFrame) => {
    if (f.type !== 'capSense' && f.type !== 'capSense2') return

    const leftChannels = Array.isArray(f.left) ? f.left : [f.left]
    const rightChannels = Array.isArray(f.right) ? f.right : [f.right]

    setVariance((prev) => {
      const newLeftHistory = [...prev.leftHistory, leftChannels].slice(-VARIANCE_WINDOW)
      const newRightHistory = [...prev.rightHistory, rightChannels].slice(-VARIANCE_WINDOW)

      const numChannels = Math.max(leftChannels.length, 6)
      const leftVar: number[] = []
      const rightVar: number[] = []
      for (let ch = 0; ch < numChannels; ch++) {
        const leftVals = newLeftHistory.map(h => h[ch] ?? 0)
        const rightVals = newRightHistory.map(h => h[ch] ?? 0)
        leftVar.push(computeVariance(leftVals))
        rightVar.push(computeVariance(rightVals))
      }

      return {
        leftHistory: newLeftHistory,
        rightHistory: newRightHistory,
        leftVariance: leftVar,
        rightVariance: rightVar,
      }
    })
  }, []))

  return (
    <Card className="gap-2.5 px-4 py-3.5">
      <SectionLabel right={<SensorAge timestamp={frame?.ts} />}>Presence</SectionLabel>
      {occupancyQuery.isLoading
        ? (
            <div className="grid grid-cols-2 gap-3" data-testid="presence-loading">
              <Skeleton className="h-[92px]" />
              <Skeleton className="h-[92px]" />
            </div>
          )
        : (
            <div className="grid grid-cols-2 gap-3">
              {(['left', 'right'] as const).map((side) => {
                const occ = occupancyQuery.data?.[side]
                return (
                  <PresenceSide
                    key={side}
                    name={sideName(side)}
                    side={side}
                    occupied={occ?.occupied ?? false}
                    known={occ !== undefined}
                    sub={occ ? (occ.available ? (occ.movement.active ? 'moving' : 'still') : 'sensor n/a') : '--'}
                    variance={side === 'left' ? variance.leftVariance : variance.rightVariance}
                    hasFrames={!!frame}
                  />
                )
              })}
            </div>
          )}
    </Card>
  )
}

function PresenceSide({ name, side, occupied, known, sub, variance, hasFrames }: {
  name: string
  side: 'left' | 'right'
  occupied: boolean
  known: boolean
  sub: string
  variance: number[]
  hasFrames: boolean
}) {
  const accent = side === 'left' ? 'var(--accent-cool)' : 'var(--accent-warm)'
  const activity = ZONES.map((_, zone) => zoneActivity(variance, zone))
  const peak = Math.max(...activity)

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={`presence-${side}`}>
      <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
        <StatusDot tone={occupied ? 'ok' : 'muted'} />
        <span className="truncate">{`${name} · ${known ? (occupied ? 'in bed' : 'empty') : '--'}`}</span>
      </span>
      <span className="font-mono text-[11px] text-fg-2">{sub}</span>
      <div className="flex h-[34px] items-end gap-1" aria-label={`${name} zone activity`}>
        {ZONES.map((zone, i) => (
          <span
            key={zone}
            data-zone={zone}
            className="flex-1 rounded-[2px] transition-[height] duration-300"
            title={`${zone} ${variance.length ? Math.max(variance[i * 2] ?? 0, variance[i * 2 + 1] ?? 0).toFixed(2) : '--'}`}
            style={{
              height: `${Math.max(hasFrames ? 8 : 6, activity[i] * 100)}%`,
              background: hasFrames && activity[i] > 0 && activity[i] === peak
                ? accent
                : `color-mix(in srgb, ${accent} ${hasFrames ? 32 : 14}%, var(--surface-card))`,
            }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-fg-3">
        {ZONES.map(z => <span key={z}>{z}</span>)}
      </div>
    </div>
  )
}

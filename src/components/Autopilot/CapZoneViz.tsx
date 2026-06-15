/**
 * Live capacitive-zone visualization for the rule editor.
 *
 * The `{side}.cap.*` signals reduce the capacitive *presence* matrix — per-zone
 * body-contact load across head/torso/legs, NOT temperature. "Zone" is opaque as
 * a number, so when a rule references a pressure signal we render the live matrix
 * the same way the Sensors page PresenceCard does: per-channel variance over a
 * sliding window, paired into the three zones (channels `z*2` / `z*2+1`), with
 * the most-active zone highlighted. Live-only — there is no granular history, so
 * this is not part of the backtest.
 */
'use client'

import { useCallback, useMemo, useState } from 'react'
import { useOnSensorFrame, useSensorFrame } from '@/src/hooks/useSensorStream'
import type { SensorFrame } from '@/src/hooks/useSensorStream'
import { Icon } from './icons'
import { Card } from './primitives'

const WINDOW = 20 // frames of history for the variance estimate
const NORMALIZE = 0.5 // variance mapped to a full-intensity cell
const ZONES = [{ i: 0, label: 'Head' }, { i: 1, label: 'Torso' }, { i: 2, label: 'Legs' }] as const

function variance(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
}

/** Per-zone activity = the louder of its two paired channels. */
function zoneActivity(channelVar: number[], zone: number): number {
  return Math.max(channelVar[zone * 2] ?? 0, channelVar[zone * 2 + 1] ?? 0)
}

function fmtTs(ts: number | undefined): string {
  if (!ts) return '--'
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function CapZoneViz({ side }: { side: 'left' | 'right' | 'both' }) {
  const capSense = useSensorFrame('capSense')
  const capSense2 = useSensorFrame('capSense2')
  const frame = capSense2 ?? capSense

  const [hist, setHist] = useState<{ left: number[][], right: number[][] }>({ left: [], right: [] })
  useOnSensorFrame(useCallback((f: SensorFrame) => {
    if (f.type !== 'capSense' && f.type !== 'capSense2') return
    const l = Array.isArray(f.left) ? f.left : [f.left]
    const r = Array.isArray(f.right) ? f.right : [f.right]
    setHist(prev => ({
      left: [...prev.left, l].slice(-WINDOW),
      right: [...prev.right, r].slice(-WINDOW),
    }))
  }, []))

  const channelVar = useMemo(() => {
    const calc = (frames: number[][]): number[] => {
      const n = Math.max(6, ...frames.map(h => h.length))
      return Array.from({ length: n }, (_, ch) => variance(frames.map(h => h[ch] ?? 0)))
    }
    return { left: calc(hist.left), right: calc(hist.right) }
  }, [hist])

  const sides = side === 'both' ? (['left', 'right'] as const) : ([side] as const)

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon.Activity size={13} className="text-zinc-500" />
          <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Bed pressure · live zones</span>
        </div>
        {frame && <span className="mono text-[10px] text-zinc-600">{fmtTs(frame.ts)}</span>}
      </div>

      {!frame
        ? <div className="grid h-24 place-items-center text-[12px] text-zinc-600">Waiting for live capacitive data…</div>
        : (
            <div className="flex gap-3">
              {sides.map((s) => {
                const act = ZONES.map(z => zoneActivity(channelVar[s], z.i))
                const peak = act.indexOf(Math.max(...act))
                return (
                  <div key={s} className="flex-1">
                    <div className="mb-1.5 text-center text-[10px] uppercase tracking-wide text-zinc-500">{s}</div>
                    <div className="flex flex-col gap-1">
                      {ZONES.map((z, i) => {
                        const pct = Math.min(act[i] / NORMALIZE, 1)
                        const isPeak = i === peak && act[i] > 0.02
                        return (
                          <div
                            key={z.i}
                            className="relative h-9 overflow-hidden rounded-md border"
                            style={{ borderColor: isPeak ? 'var(--accent)' : 'rgba(63,63,70,0.5)' }}
                          >
                            <div className="absolute inset-0" style={{ background: 'var(--accent)', opacity: 0.06 + pct * 0.5 }} />
                            <div className="absolute inset-0 flex items-center justify-between px-2.5">
                              <span className="text-[11px] text-zinc-200">{z.label}</span>
                              <span className="mono text-[10px] text-zinc-400">{act[i].toFixed(2)}</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

      <div className="mt-3 text-[11px] leading-relaxed text-zinc-600">
        Capacitive presence sensing — body-contact load across head/torso/legs (not temperature). Brighter = more contact; the outlined band is the most-active zone. Live only, not part of the backtest.
      </div>
    </Card>
  )
}

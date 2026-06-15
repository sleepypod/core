/**
 * Capacitive-zone visualization for the rule editor.
 *
 * The `{side}.cap.*` signals reduce the capacitive *presence* matrix — per-zone
 * body-contact load across head/torso/legs, NOT temperature. "Zone" is opaque as
 * a number, so when a rule references a pressure signal we render the matrix
 * spatially the way the Sensors page PresenceCard does.
 *
 * Two modes:
 *  - **Live** — per-channel variance over a sliding window off the live stream,
 *    paired into the three zones, most-active zone highlighted.
 *  - **Replay** — the downsampled [head, torso, legs] zone loads persisted to
 *    `cap_sense_frames` for the backtested night, scrubbable (and auto-playable)
 *    so a recent night can be inspected zone-by-zone alongside the backtest.
 */
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOnSensorFrame, useSensorFrame } from '@/src/hooks/useSensorStream'
import type { SensorFrame } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'
import { Icon } from './icons'
import { Card, Segmented } from './primitives'

const WINDOW = 20 // frames of history for the variance estimate
const NORMALIZE = 0.5 // variance mapped to a full-intensity cell
const ZONES = [{ i: 0, label: 'Head' }, { i: 1, label: 'Torso' }, { i: 2, label: 'Legs' }] as const
const PLAY_MS = 350 // replay frame interval

function variance(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
}

/** Per-zone activity = the louder of its two paired channels. */
function zoneActivity(channelVar: number[], zone: number): number {
  return Math.max(channelVar[zone * 2] ?? 0, channelVar[zone * 2 + 1] ?? 0)
}

function fmtClock(ts: number | undefined): string {
  if (!ts) return '--'
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Three stacked zone bars; `pct[i]` is 0..1 fill, `peak` outlines the modal zone. */
function ZoneBars({ pct, vals, peak }: { pct: number[], vals: number[], peak: number }) {
  return (
    <div className="flex flex-col gap-1">
      {ZONES.map((z, i) => {
        const isPeak = i === peak && (vals[i] ?? 0) > 0
        return (
          <div
            key={z.i}
            className="relative h-9 overflow-hidden rounded-md border"
            style={{ borderColor: isPeak ? 'var(--accent)' : 'rgba(63,63,70,0.5)' }}
          >
            <div className="absolute inset-0" style={{ background: 'var(--accent)', opacity: 0.06 + Math.min(pct[i] ?? 0, 1) * 0.5 }} />
            <div className="absolute inset-0 flex items-center justify-between px-2.5">
              <span className="text-[11px] text-zinc-200">{z.label}</span>
              <span className="mono text-[10px] text-zinc-400">{(vals[i] ?? 0).toFixed(2)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LiveZones({ side }: { side: 'left' | 'right' | 'both' }) {
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
    <>
      <div className="mb-2 flex justify-end">
        {frame && <span className="mono text-[10px] text-zinc-600">{frame.ts ? fmtClock(frame.ts * 1000) : '--'}</span>}
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
                    <ZoneBars pct={act.map(a => a / NORMALIZE)} vals={act} peak={act.some(a => a > 0.02) ? peak : -1} />
                  </div>
                )
              })}
            </div>
          )}
      <div className="mt-3 text-[11px] leading-relaxed text-zinc-600">
        Live capacitive presence — body-contact load across head/torso/legs (not temperature). Brighter = more contact; the outlined band is the most-active zone.
      </div>
    </>
  )
}

function ReplayZones({ side, nightId }: { side: 'left' | 'right', nightId: number | null }) {
  const q = trpc.automations.capZoneReplay.useQuery(
    { side, sleepRecordId: nightId ?? undefined },
    { enabled: nightId != null, placeholderData: prev => prev },
  )
  const frames = useMemo(() => q.data?.frames ?? [], [q.data])
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)

  // Keep the cursor in range as the night's frame count changes.
  const clamped = frames.length === 0 ? 0 : Math.min(idx, frames.length - 1)
  useEffect(() => {
    if (!playing || frames.length === 0) return
    const t = setInterval(() => setIdx(i => (i + 1) % frames.length), PLAY_MS)
    return () => clearInterval(t)
  }, [playing, frames.length])

  // Stable scale across the night so the scrub doesn't re-normalize per frame.
  const scale = useMemo(() => Math.max(0.01, ...frames.flatMap(f => f.zones)), [frames])

  if (q.isLoading && frames.length === 0) {
    return <div className="grid h-24 place-items-center text-[12px] text-zinc-600">Loading replay…</div>
  }
  if (frames.length === 0) {
    return <div className="grid h-24 place-items-center text-center text-[12px] text-zinc-600">No spatial presence history for this night.</div>
  }

  const cur = frames[clamped]
  const vals = cur.zones
  const peak = cur.peakZone ?? vals.indexOf(Math.max(...vals))

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setPlaying(p => !p)}
          className="grid h-6 w-6 place-items-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {playing ? <Icon.Pause size={13} /> : <Icon.Play size={13} />}
        </button>
        <span className="mono text-[10px] text-zinc-600">{`${fmtClock(cur.tMs)} · ${clamped + 1}/${frames.length}`}</span>
      </div>
      <input
        type="range"
        min={0}
        max={frames.length - 1}
        value={clamped}
        onChange={(e) => {
          setPlaying(false)
          setIdx(Number(e.target.value))
        }}
        className="mb-3 w-full accent-[var(--accent)]"
      />
      <div className="mx-auto max-w-[200px]">
        <div className="mb-1.5 text-center text-[10px] uppercase tracking-wide text-zinc-500">{side}</div>
        <ZoneBars pct={vals.map(v => v / scale)} vals={vals} peak={peak} />
      </div>
      <div className="mt-3 text-[11px] leading-relaxed text-zinc-600">
        Replaying recorded zone loads for the backtested night (~5s windows). Scrub or play to see where contact sat over the night.
      </div>
    </>
  )
}

export function CapZoneViz({ side, backtestSide, nightId }: { side: 'left' | 'right' | 'both', backtestSide?: 'left' | 'right', nightId?: number | null }) {
  const canReplay = backtestSide != null && nightId != null
  const [mode, setMode] = useState<'live' | 'replay'>('live')
  const active = canReplay ? mode : 'live'

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon.Activity size={13} className="text-zinc-500" />
          <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-zinc-400">{`Bed pressure · ${active === 'replay' ? 'night replay' : 'live zones'}`}</span>
        </div>
        {canReplay && (
          <Segmented
            size="sm"
            value={mode}
            options={[{ value: 'live', label: 'Live' }, { value: 'replay', label: 'Replay' }]}
            onChange={setMode}
          />
        )}
      </div>

      {active === 'replay' && backtestSide != null
        ? <ReplayZones side={backtestSide} nightId={nightId ?? null} />
        : <LiveZones side={side} />}
    </Card>
  )
}

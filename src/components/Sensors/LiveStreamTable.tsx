'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOnSensorFrame } from '@/src/hooks/useSensorStream'
import type { SensorFrame } from '@/src/hooks/useSensorStream'
import { StatusDot } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { STREAM_GROUPS, fmtSeen, groupForType } from './streamGroups'

const WINDOW_MS = 60_000
const MAX_EVENTS = 1200
const REDRAW_MS = 500

interface Tick {
  group: string
  ts: number
}

const COLS = 'grid grid-cols-[76px_minmax(0,1fr)_28px_40px] items-center gap-2.5 @min-[640px]:gap-3 @min-[640px]:grid-cols-[130px_110px_minmax(0,1fr)_56px_64px]'

/**
 * One row per stream this page receives: every frame in the last 60 s as a
 * tick, frames per minute and time since the last one. Frames are collected
 * in a ref and folded into state twice a second.
 */
export function LiveStreamTable() {
  const eventsRef = useRef<Tick[]>([])
  const lastRef = useRef<Record<string, { ts: number, type: string }>>({})
  const [snap, setSnap] = useState<{ now: number, events: Tick[], last: Record<string, { ts: number, type: string }> }>({ now: 0, events: [], last: {} })

  useOnSensorFrame(useCallback((frame: SensorFrame) => {
    const group = groupForType(frame.type)
    if (!group) return
    const ts = Date.now()
    eventsRef.current.push({ group, ts })
    if (eventsRef.current.length > MAX_EVENTS) eventsRef.current = eventsRef.current.slice(-MAX_EVENTS)
    lastRef.current[group] = { ts, type: frame.type }
  }, []))

  useEffect(() => {
    const tick = () => {
      const now = Date.now()
      eventsRef.current = eventsRef.current.filter(e => e.ts >= now - WINDOW_MS)
      setSnap({ now, events: eventsRef.current.slice(), last: { ...lastRef.current } })
    }
    tick()
    const interval = setInterval(tick, REDRAW_MS)
    return () => clearInterval(interval)
  }, [])

  const start = snap.now - WINDOW_MS

  return (
    <div className="flex flex-col" data-testid="live-streams">
      <div className={cn(COLS, 'pb-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-fg-3')}>
        <span>Stream</span>
        <span className="hidden @min-[640px]:block" />
        <span className="flex justify-between">
          <span>−60 s</span>
          <span>−30 s</span>
          <span>now</span>
        </span>
        <span className="text-right">/min</span>
        <span className="text-right">Last</span>
      </div>
      {STREAM_GROUPS.map((g) => {
        const ticks = snap.events.filter(e => e.group === g.key)
        const receiving = ticks.length > 0
        const last = snap.last[g.key]
        return (
          <div key={g.key} className={cn(COLS, 'min-h-[38px]')} data-testid={`stream-${g.key}`} data-receiving={receiving}>
            <span className="flex min-w-0 items-center gap-2.5 text-[13px]">
              <StatusDot tone={receiving ? 'ok' : 'muted'} />
              <span className="truncate">{g.label}</span>
            </span>
            <span className="hidden truncate font-mono text-xs text-fg-2 @min-[640px]:block">{last?.type ?? g.types[0]}</span>
            <div className="relative h-[18px] overflow-hidden rounded-[4px] border border-active bg-app" data-testid={`raster-${g.key}`}>
              {receiving
                ? ticks.map((e, i) => (
                    <span
                      key={`${e.ts}-${i}`}
                      className="absolute inset-y-[3px] w-0.5 rounded-[1px] bg-fg/85"
                      style={{ left: `calc(${Math.min(100, ((e.ts - start) / WINDOW_MS) * 100)}% - 3px)` }}
                    />
                  ))
                : <span className="absolute inset-y-0 left-2.5 flex items-center truncate font-mono text-[11px] text-fg-3">nothing in the last 60 s</span>}
              <span className="absolute inset-y-0 right-0 w-px bg-fg-3/60" />
            </div>
            <span className={cn('text-right font-mono text-[13px]', !receiving && 'text-fg-3')}>{ticks.length}</span>
            <span className={cn('text-right font-mono text-[13px]', receiving ? 'text-fg-2' : 'text-fg-3')}>
              {receiving && last ? fmtSeen(snap.now - last.ts) : '—'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

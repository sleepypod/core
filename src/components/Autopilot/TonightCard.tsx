/**
 * "Who controls the bed tonight" — one now card per side (the owner by
 * TemperatureController precedence, with a sentence explaining it) above a
 * 6 PM → 9 AM timeline. Each side gets two lanes: SCHED (the schedule's set
 * points as temperature-coloured blocks, with any manual hold overlaid) and
 * AUTO (each rule's active window — hatched amber in dry-run, green outline
 * when active — with its fire events as dots).
 */
'use client'

import { useState, type CSSProperties, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { HoverMark, Skeleton } from '@/src/components/ds'
import { useNowMinute } from '@/src/components/Schedule/CurveChart'
import { tempTone, TONE_VAR } from '@/src/components/Schedule/scheduleFormat'
import { tonightWindow } from '@/src/components/diagnostics/dashboardLogic'
import { nightCurve, type CurvePoint } from '@/src/components/TempScreen/timelineLogic'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useShownSides } from '@/src/providers/SideProvider'
import { formatSetpointF, type TempUnit } from '@/src/lib/tempUtils'
import type { Condition } from '@/src/automation/types'
import { trpc } from '@/src/utils/trpc'
import { clock, ownerView, ruleWindow, scheduleBands, scheduleBlocks, type Owner, type RuleMode, type SideTonight } from './automationsLogic'

type Side = 'left' | 'right'
const HOUR = 3_600_000
const LANE_H = 16

export interface TimelineRule {
  id: number
  name: string
  mode: RuleMode
  side: Side | null
  conditions: Condition
  missing: string[]
}

export interface FireMark { ruleId: number, at: number, outcome: string, sides: Side[] }

export const OWNER_TONE: Record<Owner, string> = {
  'manual': 'text-link',
  'run-once': 'text-cool',
  'autopilot': 'text-ok',
  'schedule': 'text-fg-icon',
  'off': 'text-fg-3',
}

export const HATCH: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, color-mix(in srgb, var(--status-warn) 45%, transparent) 0 1px, transparent 1px 7px)',
}

export function TonightCard({ rules, tonight, fires, unit }: {
  rules: TimelineRule[]
  tonight: { now: number, sides: Record<Side, SideTonight> } | undefined
  fires: FireMark[]
  unit: TempUnit
}) {
  const nowMinute = useNowMinute()
  const { sideName } = useSideNames()
  // One side away: tonight is just the sleeper's side.
  const shown = useShownSides()
  const left = trpc.schedules.getAll.useQuery({ side: 'left' }, { staleTime: 60_000 })
  const right = trpc.schedules.getAll.useQuery({ side: 'right' }, { staleTime: 60_000 })
  // One hover across every lane: the moment under the pointer (epoch ms).
  const [hoverT, setHoverT] = useState<number | null>(null)

  if (nowMinute == null) return <Skeleton className="h-[420px]" />
  const now = nowMinute * 60_000
  const win = tonightWindow(new Date(now))
  const start = new Date(win.midnight.getFullYear(), win.midnight.getMonth(), win.midnight.getDate(), 18).getTime()
  const end = win.end
  const pct = (t: number) => ((Math.min(Math.max(t, start), end) - start) / (end - start)) * 100
  const fmt = (f: number) => formatSetpointF(f, unit, { includeUnit: false })
  const curves: Record<Side, CurvePoint[]> = {
    left: nightCurve(left.data?.temperature, win.midnight),
    right: nightCurve(right.data?.temperature, win.midnight),
  }
  const ticks: number[] = []
  for (let t = start; t <= end; t += 3 * HOUR) ticks.push(t)
  const nowIn = now >= start && now <= end
  const blocks: Record<Side, ReturnType<typeof scheduleBlocks>> = {
    left: scheduleBlocks(curves.left, start, end, fmt),
    right: scheduleBlocks(curves.right, start, end, fmt),
  }

  // Lanes start after the 64px name and 40px lane-label columns plus two 8px gaps.
  const LANE_LEFT = 120
  const onLanesPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - LANE_LEFT
    const w = rect.width - LANE_LEFT
    setHoverT(x < 0 || w <= 0 ? null : start + Math.min(1, x / w) * (end - start))
  }
  // What each side is set to at the hovered moment: a manual hold wins over the schedule.
  const readoutAt = (side: Side, t: number) => {
    const hold = tonight?.sides[side].hold
    if (hold && t >= hold.startedAt && t <= hold.expiresAt) return `${fmt(hold.temperature)} hold`
    const b = blocks[side].find(x => t >= x.start && t < x.end)
    return b ? fmt(b.temperature) : '—'
  }

  return (
    <div className="@container flex min-w-0 flex-col gap-4 rounded-card border border-line bg-surface px-[18px] py-4" data-testid="tonight-card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-medium">Who controls the bed tonight</span>
        <span className="font-mono text-xs text-fg-2">6 PM → 9 AM</span>
        <div className="ml-auto flex items-center gap-4 font-mono text-[11px] text-fg-2">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-3.5 rounded-[2px] border border-link bg-link/30" />
            manual hold
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-3.5 rounded-[2px] border border-warn/60" style={HATCH} />
            dry-run
          </span>
        </div>
      </div>

      <div className={cn('grid gap-2.5', shown.length > 1 && '@min-[640px]:grid-cols-2')}>
        {shown.map((side) => {
          const o = ownerView(tonight?.sides[side], curves[side], now, fmt)
          return (
            <div key={side} className="flex flex-col gap-1 rounded-ctl border border-line px-4 py-3" data-testid={`owner-${side}`}>
              <div className="flex items-center gap-2">
                <span className="text-sm">
                  {sideName(side)}
                  <span className="text-fg-2"> · now</span>
                </span>
                <span className={cn('ml-auto flex items-center gap-1.5 font-mono text-xs', OWNER_TONE[o.owner])}>
                  <span className="size-1.5 rounded-full bg-current" />
                  {o.label}
                </span>
              </div>
              <span className="text-[13px] text-fg-2">{tonight ? o.detail : 'Loading…'}</span>
            </div>
          )
        })}
      </div>

      <div className="-mx-[18px] overflow-x-auto px-[18px]">
        <div
          className="relative grid min-w-[560px] grid-cols-[64px_40px_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5"
          data-testid="tonight-lanes"
          onPointerMove={onLanesPointerMove}
          onPointerLeave={() => setHoverT(null)}
        >
          {shown.map(side => (
            <SideLanes
              key={side}
              side={side}
              name={sideName(side)}
              blocks={blocks[side]}
              hold={tonight?.sides[side].hold ?? null}
              rules={rules.filter(r => r.mode !== 'off' && (r.side == null || r.side === side))}
              fires={fires.filter(f => f.sides.length === 0 || f.sides.includes(side))}
              midnight={win.midnight}
              start={start}
              end={end}
              pct={pct}
              fmt={fmt}
            />
          ))}

          <span />
          <span />
          <div className="relative h-5 font-mono text-[10px] text-fg-3">
            {ticks.map(t => (
              <span key={t} className="absolute top-1 -translate-x-1/2 whitespace-nowrap" style={{ left: `${pct(t)}%` }}>
                {clock(t).replace(':00', '')}
              </span>
            ))}
            {nowIn && (
              <span className="absolute top-0.5 -translate-x-1/2 rounded-tag bg-fg px-1.5 py-px text-inverse" style={{ left: `${pct(now)}%` }}>now</span>
            )}
          </div>

          {/* Hour grid and now line across every lane. */}
          <div aria-hidden className="pointer-events-none absolute top-0 right-0 bottom-5 left-[120px]">
            {ticks.map(t => <span key={t} className="absolute inset-y-0 w-px bg-grid" style={{ left: `${pct(t)}%` }} />)}
            {nowIn && <span className="absolute inset-y-0 w-px bg-fg" style={{ left: `${pct(now)}%` }} data-testid="tonight-now" />}
            {hoverT != null && (
              <HoverMark
                pct={pct(hoverT)}
                label={`${clock(hoverT)} · ${shown.map(s => `${sideName(s)} ${readoutAt(s, hoverT)}`).join(' · ')}`}
                className="-top-5"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SideLanes({ side, name, blocks, hold, rules, fires, midnight, start, end, pct, fmt }: {
  side: Side
  name: string
  blocks: ReturnType<typeof scheduleBlocks>
  hold: SideTonight['hold']
  rules: TimelineRule[]
  fires: FireMark[]
  midnight: Date
  start: number
  end: number
  pct: (t: number) => number
  fmt: (f: number) => string
}) {
  const span = (a: number, b: number): CSSProperties => ({ left: `${pct(a)}%`, width: `${pct(b) - pct(a)}%` })
  const holdSpan = hold && hold.expiresAt > start && hold.startedAt < end ? hold : null
  return (
    <>
      <div className="row-span-2 flex flex-col self-start pt-0.5">
        <span className="truncate text-[13px]">{name}</span>
        <span className="font-mono text-[10px] text-fg-3 uppercase">{side}</span>
      </div>
      <span className="text-right font-mono text-[10px] text-fg-2">SCHED</span>
      <div className="relative rounded-[2px] bg-active/60" style={{ height: LANE_H }} data-testid={`lane-${side}-sched`}>
        {scheduleBands(blocks, tempTone).map((band) => {
          const lo = fmt(band.lo)
          const hi = fmt(band.hi)
          return (
            <span
              key={band.start}
              className="@container absolute inset-y-0 overflow-hidden border-l border-app px-1 font-mono text-[10px] leading-4 whitespace-nowrap text-fg"
              style={{ ...span(band.start, band.end), background: `color-mix(in srgb, ${TONE_VAR[band.tone]} 70%, transparent)` }}
            >
              {/* Too narrow for the number: the colour and each step's tooltip carry it. */}
              <span className="@max-[24px]:invisible">{lo === hi ? lo : `${lo.replace('°', '')}–${hi}`}</span>
            </span>
          )
        })}
        {blocks.map(b => (
          <span
            key={b.start}
            className="absolute inset-y-0"
            style={span(b.start, b.end)}
            title={`${fmt(b.temperature)} · ${clock(b.start)} – ${clock(b.end)}`}
          />
        ))}
        {holdSpan && (
          <span
            className="absolute inset-y-0 overflow-hidden rounded-[2px] border border-link bg-link/30 px-1 font-mono text-[10px] leading-[14px] whitespace-nowrap text-fg"
            style={span(holdSpan.startedAt, holdSpan.expiresAt)}
            data-testid={`hold-${side}`}
          >
            {fmt(holdSpan.temperature)}
          </span>
        )}
      </div>

      <span className="text-right font-mono text-[10px] text-fg-2">AUTO</span>
      <div className="relative mb-3 rounded-[2px] bg-active/60" style={{ height: LANE_H }} data-testid={`lane-${side}-auto`}>
        {rules.map((r) => {
          const w = ruleWindow(r.conditions, midnight, start, end)
          if (!w) return null
          const state = r.missing.length ? `no ${r.missing[0]} signal` : 'armed'
          const label = r.mode === 'dryrun' ? `${r.name} · dry-run · ${state}` : r.missing.length ? `${r.name} · ${state}` : r.name
          return (
            <span
              key={r.id}
              className={cn(
                'absolute inset-y-0 overflow-hidden rounded-[2px] border px-1.5 font-mono text-[10px] leading-[14px] whitespace-nowrap',
                r.mode === 'dryrun' ? 'border-warn/60 text-warn' : 'border-ok text-ok',
              )}
              style={{ ...span(w.start, w.end), ...(r.mode === 'dryrun' ? HATCH : {}) }}
              title={label}
            >
              {label}
            </span>
          )
        })}
        {fires.filter(f => f.at >= start && f.at <= end).map(f => (
          <span
            key={`${f.ruleId}-${f.at}`}
            className={cn('absolute top-1/2 size-2 -translate-1/2 rounded-full border border-app', f.outcome === 'dry_run' ? 'bg-warn' : 'bg-ok')}
            style={{ left: `${pct(f.at)}%` }}
            title={`${clock(f.at)} · ${f.outcome === 'dry_run' ? 'would fire' : 'fired'}`}
          />
        ))}
      </div>
    </>
  )
}

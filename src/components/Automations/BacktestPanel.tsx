/**
 * Backtest panel — the transparency centerpiece. Renders the server's replay of
 * a rule against real recorded history: the compared signal trace, its windowed
 * average, the threshold, fire/suppressed markers, and the resulting clamped
 * setpoint. Hand-built multi-layer SVG (ported from the design) for precise
 * control over the overlay. Two modes: edge-triggered and continuous policy.
 */
'use client'

import { Icon } from './icons'

import type { BacktestResult } from '@/src/automation/backtest'

export interface NightOption { sleepRecordId: number, label: string, date: string }

function minToClock(m: number): string {
  const h = Math.floor((m / 60) % 24)
  const mm = Math.floor(m % 60)
  const ap = h < 12 ? 'a' : 'p'
  let hh = h % 12
  if (hh === 0) hh = 12
  return `${hh}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${ap}`
}

function Stat({ label, value, tone = 'zinc' }: { label: string, value: string, tone?: 'zinc' | 'red' | 'accent' }) {
  const color = tone === 'red' ? '#f87171' : tone === 'accent' ? 'var(--accent)' : '#e4e4e7'
  return (
    <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.1em] text-zinc-500">{label}</div>
      <div className="mono text-[15px] font-medium mt-0.5" style={{ color }}>{value}</div>
    </div>
  )
}

function NightPicker({ nights, nightId, onNight }: { nights: NightOption[], nightId: number | null, onNight: (id: number) => void }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {nights.map(n => (
        <button
          key={n.sleepRecordId}
          type="button"
          onClick={() => onNight(n.sleepRecordId)}
          style={n.sleepRecordId === nightId ? { background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' } : undefined}
          className={`rounded-md border px-2 py-1 text-[12px] transition-colors ${n.sleepRecordId === nightId ? '' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
        >
          {n.label}
          {' '}
          <span className="text-[10px] opacity-60">{n.date}</span>
        </button>
      ))}
    </div>
  )
}

function Chart({ r }: { r: BacktestResult }) {
  const N = r.clockMin.length
  if (N < 2) return <div className="text-[12px] text-zinc-500 px-2 py-8 text-center">Not enough data in this window to replay.</div>

  const W = 660, H = 188, mL = 38, mR = 42, mT = 14, mB = 22
  const iw = W - mL - mR, ih = H - mT - mB
  const x = (i: number) => mL + (i / (N - 1)) * iw

  // Policy overlays ambient + setpoint on one shared temperature scale.
  const policy = r.mode === 'policy'
  const primA = r.primaryAxis
  const tempA = r.tempAxis ?? { min: 60, max: 80 }
  const sharedMin = policy ? Math.min(primA?.min ?? tempA.min, tempA.min) : tempA.min
  const sharedMax = policy ? Math.max(primA?.max ?? tempA.max, tempA.max) : tempA.max

  const yPrimary = (v: number) => {
    const a = policy ? { min: sharedMin, max: sharedMax } : (primA ?? { min: 0, max: 1 })
    return mT + ih - ((v - a.min) / (a.max - a.min || 1)) * ih
  }
  const yTemp = (v: number) => {
    const lo = policy ? sharedMin : tempA.min
    const hi = policy ? sharedMax : tempA.max
    return mT + ih - ((v - lo) / (hi - lo || 1)) * ih
  }

  const linePath = (arr: (number | null)[], yf: (v: number) => number) => {
    let d = ''
    let pen = false
    arr.forEach((v, i) => {
      if (v == null) {
        pen = false
        return
      }
      d += `${pen ? 'L' : 'M'} ${x(i).toFixed(1)} ${yf(v).toFixed(1)} `
      pen = true
    })
    return d.trim()
  }
  // setpoint as a step line
  const stepPath = (() => {
    let d = ''
    let prev: number | null = null
    r.setpoint.forEach((v, i) => {
      if (v == null) {
        prev = null
        return
      }
      const px = x(i).toFixed(1)
      if (prev == null) d += `M ${px} ${yTemp(v).toFixed(1)} `
      else d += `L ${px} ${yTemp(prev).toFixed(1)} L ${px} ${yTemp(v).toFixed(1)} `
      prev = v
    })
    return d.trim()
  })()

  // time ticks at ~6 even index positions
  const tickIdx = Array.from({ length: 6 }, (_, k) => Math.round((k / 5) * (N - 1)))

  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        {[0, 0.25, 0.5, 0.75, 1].map((g, i) => (
          <line key={i} x1={mL} x2={W - mR} y1={mT + ih * g} y2={mT + ih * g} stroke="#1c1c20" strokeWidth="1" />
        ))}
        {tickIdx.map((idx, i) => (
          <g key={i}>
            <line x1={x(idx)} x2={x(idx)} y1={mT} y2={mT + ih} stroke="#18181b" strokeWidth="1" />
            <text x={x(idx)} y={H - 6} textAnchor="middle" className="mono" style={{ fontSize: 9, fill: '#71717a' }}>{minToClock(r.clockMin[idx])}</text>
          </g>
        ))}

        {/* time-window shade */}
        {r.timeWindow && (() => {
          const win = r.timeWindow
          if (!win) return null
          const inWin = r.clockMin.map(m => isIn(m, win))
          // draw contiguous shaded spans
          const spans: Array<[number, number]> = []
          let s = -1
          inWin.forEach((on, i) => {
            if (on && s < 0) s = i
            if (!on && s >= 0) {
              spans.push([s, i - 1])
              s = -1
            }
          })
          if (s >= 0) spans.push([s, N - 1])
          return spans.map(([a, b], i) => (
            <rect key={i} x={x(a)} y={mT} width={Math.max(1, x(b) - x(a))} height={ih} fill="rgba(255,255,255,0.02)" />
          ))
        })()}

        {/* policy clamp band */}
        {policy && r.clamp && (
          <>
            <rect x={mL} y={yTemp(r.clamp.max)} width={iw} height={Math.max(0, yTemp(r.clamp.min) - yTemp(r.clamp.max))} fill="color-mix(in srgb, var(--accent) 12%, transparent)" />
            <line x1={mL} x2={W - mR} y1={yTemp(r.clamp.max)} y2={yTemp(r.clamp.max)} stroke="var(--accent)" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
            <line x1={mL} x2={W - mR} y1={yTemp(r.clamp.min)} y2={yTemp(r.clamp.min)} stroke="var(--accent)" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
            <text x={mL + 3} y={yTemp(r.clamp.max) - 3} className="mono" style={{ fontSize: 8, fill: 'var(--accent)', opacity: 0.7 }}>
              clamp
              {Math.round(r.clamp.min)}
              –
              {Math.round(r.clamp.max)}
              °
            </text>
          </>
        )}

        {/* threshold (edge) */}
        {!policy && r.threshold != null && r.primaryAxis && (
          <>
            <line x1={mL} x2={W - mR} y1={yPrimary(r.threshold)} y2={yPrimary(r.threshold)} stroke="#ef4444" strokeWidth="1.2" strokeDasharray="4 3" opacity="0.8" />
            <text x={W - mR + 3} y={yPrimary(r.threshold) + 3} className="mono" style={{ fontSize: 9, fill: '#ef4444' }}>{r.threshold}</text>
          </>
        )}

        {/* primary raw trace */}
        {r.primary && <path d={linePath(r.primary.values, yPrimary)} fill="none" stroke="#3f3f46" strokeWidth="1.3" />}
        {/* policy raw (pre-clamp) ghost */}
        {policy && r.setpointRaw && <path d={linePath(r.setpointRaw, yTemp)} fill="none" stroke="#52525b" strokeWidth="1" strokeDasharray="3 3" />}
        {/* windowed avg (edge) */}
        {r.avg && <path d={linePath(r.avg.values, yPrimary)} fill="none" stroke="#d4d4d8" strokeWidth="1.8" />}

        {/* setpoint */}
        <path d={policy ? linePath(r.setpoint, yTemp) : stepPath} fill="none" stroke="var(--accent)" strokeWidth="2.1" />

        {/* suppressed markers */}
        {!policy && r.suppressed.map((i, k) => {
          const av = r.avg?.values[i]
          return (
            <g key={`s${k}`}>
              <line x1={x(i)} x2={x(i)} y1={mT} y2={mT + ih} stroke="#52525b" strokeWidth="1" strokeDasharray="2 3" opacity="0.5" />
              {av != null && <circle cx={x(i)} cy={yPrimary(av)} r="2.5" fill="#52525b" />}
            </g>
          )
        })}
        {/* fire markers */}
        {!policy && r.fires.map((i, k) => {
          const yv = r.avg?.values[i] ?? r.primary?.values[i] ?? null
          return (
            <g key={`f${k}`}>
              <line x1={x(i)} x2={x(i)} y1={mT} y2={mT + ih} stroke="#ef4444" strokeWidth="1" opacity="0.45" />
              {yv != null && <circle cx={x(i)} cy={yPrimary(yv)} r="4" fill="#ef4444" stroke="#0a0a0b" strokeWidth="1.5" />}
            </g>
          )
        })}

        {/* axes labels */}
        {!policy && r.primaryAxis && (
          <>
            <text x={mL - 5} y={yPrimary(r.primaryAxis.max) + 3} textAnchor="end" className="mono" style={{ fontSize: 9, fill: '#52525b' }}>{Math.round(r.primaryAxis.max)}</text>
            <text x={mL - 5} y={yPrimary(r.primaryAxis.min) - 1} textAnchor="end" className="mono" style={{ fontSize: 9, fill: '#52525b' }}>{Math.round(r.primaryAxis.min)}</text>
          </>
        )}
        <text x={W - mR + 3} y={yTemp(policy ? sharedMax : tempA.max) + 8} className="mono" style={{ fontSize: 9, fill: 'var(--accent)' }}>
          {Math.round(policy ? sharedMax : tempA.max)}
          °
        </text>
        <text x={W - mR + 3} y={yTemp(policy ? sharedMin : tempA.min)} className="mono" style={{ fontSize: 9, fill: 'var(--accent)' }}>
          {Math.round(policy ? sharedMin : tempA.min)}
          °
        </text>
      </svg>
    </div>
  )
}

function isIn(nowMin: number, w: { startMin: number, endMin: number }): boolean {
  if (w.startMin === w.endMin) return false
  if (w.startMin < w.endMin) return nowMin >= w.startMin && nowMin < w.endMin
  return nowMin >= w.startMin || nowMin < w.endMin
}

export function BacktestPanel({
  result, loading, message, nights, nightId, onNight,
}: {
  result: BacktestResult | null
  loading: boolean
  message?: string
  nights: NightOption[]
  nightId: number | null
  onNight: (id: number) => void
}) {
  const r = result
  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Icon.Flask size={14} className="text-zinc-500" />
          <span className="text-[12px] font-semibold tracking-[0.12em] uppercase text-zinc-400">
            Backtest
            {r ? (r.mode === 'policy' ? ' · policy' : ' · edge') : ''}
          </span>
        </div>
        <NightPicker nights={nights} nightId={nightId} onNight={onNight} />
      </div>

      {loading && <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2 h-[160px] grid place-items-center text-[12px] text-zinc-600">Replaying…</div>}
      {!loading && message && <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-4 text-[12px] text-zinc-500">{message}</div>}
      {!loading && !message && r && (
        <>
          <Chart r={r} />
          <div className="mt-3 flex items-center gap-3 flex-wrap text-[11px] text-zinc-400">
            {r.avg && <Legend swatch="#d4d4d8">{r.avg.label}</Legend>}
            {r.primary && <Legend swatch="#3f3f46">{r.mode === 'policy' ? r.primary.label.toLowerCase() : `raw ${r.primary.label.toLowerCase()}`}</Legend>}
            {r.mode === 'policy' && r.setpointRaw && <Legend dashed swatch="#52525b">pre-clamp</Legend>}
            {r.mode === 'policy' && r.clamp && <Legend band swatch="var(--accent)">clamp band</Legend>}
            {r.mode === 'edge' && r.threshold != null && <Legend dashed swatch="#ef4444">threshold</Legend>}
            <Legend swatch="var(--accent)">setpoint</Legend>
            {r.mode === 'edge' && (
              <>
                <Dot color="#ef4444">fired</Dot>
                <Dot color="#52525b">suppressed</Dot>
              </>
            )}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {r.mode === 'policy'
              ? (
                  <>
                    <Stat label="Mode" value="Continuous" tone="accent" />
                    <Stat label="Clamp hits" value={`${r.summary.clampHits}×`} tone={r.summary.clampHits ? 'red' : 'zinc'} />
                    <Stat label="Setpoint range" value={r.summary.setpointRange ? `${Math.round(r.summary.setpointRange[0])}–${Math.round(r.summary.setpointRange[1])}°F` : '—'} />
                  </>
                )
              : (
                  <>
                    <Stat label="Would fire" value={`${r.summary.wouldFire}×`} tone="red" />
                    <Stat label="Suppressed (cooldown)" value={`${r.summary.suppressed}×`} />
                    <Stat label="Net effect" value={r.summary.netEffect ?? '—'} tone="accent" />
                  </>
                )}
          </div>
        </>
      )}
    </div>
  )
}

function Legend({ swatch, dashed, band, children }: { swatch: string, dashed?: boolean, band?: boolean, children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {band
        ? <span className="h-2.5 w-4 rounded-sm border" style={{ borderColor: `color-mix(in srgb, ${swatch} 70%, transparent)`, background: `color-mix(in srgb, ${swatch} 12%, transparent)` }} />
        : <span className={`h-0.5 w-4 rounded ${dashed ? 'border-t border-dashed' : ''}`} style={dashed ? { borderColor: swatch } : { background: swatch }} />}
      {children}
    </span>
  )
}
function Dot({ color, children }: { color: string, children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {children}
    </span>
  )
}

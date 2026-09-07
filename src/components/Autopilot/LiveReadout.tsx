/** Shared live signal readout for the compact rule row and expanded Live card. */
import type { LiveReading } from '@/src/automation/live'
import { SIGNALS } from './builderModel'

export function LiveReadout({ live }: { live?: LiveReading | null }) {
  if (!live) return <div className="text-xs text-zinc-500">Live data unavailable</div>
  const def = SIGNALS.find(s => s.id.replace('{side}', 'left') === live.signal || s.id.replace('{side}', 'right') === live.signal)
  const label = def?.label ?? live.signal
  const unit = def?.unit ?? ''
  const fmt = (v: number) => `${Number(v.toFixed(1))}${unit}`
  const threshold = live.threshold
  const value = live.value
  // A shared signed domain keeps negative thresholds and below-comparisons honest.
  const lo = Math.min(0, value ?? 0, threshold ?? 0)
  const hi = Math.max(0, value ?? 0, threshold ?? 0)
  const padding = (hi - lo || 1) * 0.2
  const percent = (v: number) => 100 * (v - lo + padding) / (hi - lo + padding * 2)
  return (
    <div className="min-w-0 space-y-1" aria-label="Live signal">
      <div className="truncate text-[10px] uppercase tracking-widest text-zinc-500" title={live.signal}>
        {label}
        {live.aggregation ? ` ${live.aggregation} (${live.windowMin}m)` : ''}
      </div>
      <div className="mono text-xs text-zinc-300">
        {value === null ? 'Unavailable' : fmt(value)}
        {threshold !== null && (
          <span className="text-zinc-500">
            {' '}
            /
            {live.op}
            {' '}
            {fmt(threshold)}
          </span>
        )}
      </div>
      {value !== null && threshold !== null && (
        <div className="relative h-1 rounded-full bg-zinc-800" role="meter" aria-label={`${label} versus threshold`} aria-valuemin={lo - padding} aria-valuemax={hi + padding} aria-valuenow={value} aria-valuetext={`${fmt(value)} / ${live.op} ${fmt(threshold)}; comparison ${live.matched ? 'met' : 'not met'}`}>
          <div className="h-full rounded-full" style={{ width: `${percent(value)}%`, background: live.matched ? '#f59e0b' : 'var(--accent)' }} />
          <span className="absolute -top-1 h-3 w-px bg-zinc-400" style={{ left: `${percent(threshold)}%` }} />
        </div>
      )}
    </div>
  )
}

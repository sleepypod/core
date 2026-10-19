import { useState } from 'react'
import type { flashInsights } from '@/src/lib/flashInsights'

type Insights = ReturnType<typeof flashInsights>
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`
const coverage = (hours: number) => `${hours.toFixed(1)} h measured`

export function FlashWrites({ insights }: { insights: Insights }) {
  const [selected, setSelected] = useState(23)
  const point = insights.history[selected]
  const max = Math.max(1, ...insights.history.map(p => p.bytesPerDay ?? 0))
  const labels = ['Last hour', 'Last 24 hours', 'Last 7 days']
  return (
    <div className="flex flex-col gap-4 border-t border-line pt-4">
      <div className="grid grid-cols-1 gap-3 @min-[480px]:grid-cols-3">
        {insights.windows.map((w, i) => (
          <div key={w.hours} className="rounded-lg bg-active p-3">
            <p className="text-xs text-fg-2">{labels[i]}</p>
            <p className="mt-1 font-mono text-lg tabular-nums">
              {w.bytesPerDay == null ? 'Measuring…' : `${gb(w.bytesPerDay)}/day`}
            </p>
            <p className="mt-1 text-xs text-fg-2">
              {coverage(w.coveredHours)}
              {w.coveredHours < w.hours - 0.01 ? ' · partial' : ''}
            </p>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-2 flex justify-between gap-2 text-xs text-fg-2">
          <span>Write rate · last 24 hours</span>
          <span>{`${gb(max)}/day peak scale`}</span>
        </div>
        <div role="group" aria-label="Hourly flash write rates" className="flex h-24 items-end gap-1 border-b border-line">
          {insights.history.map((p, i) => {
            const label = `${24 - i} to ${23 - i} hours ago: ${p.bytesPerDay == null ? 'insufficient coverage' : `${gb(p.bytesPerDay)}/day`}`
            return (
              <button
                key={i}
                type="button"
                aria-label={label}
                aria-pressed={selected === i}
                title={label}
                onClick={() => setSelected(i)}
                className="flex h-full min-w-0 flex-1 items-end rounded-t focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg"
              >
                <span className={`block w-full rounded-t ${p.bytesPerDay == null ? 'border border-dashed border-line-2' : selected === i ? 'bg-fg' : 'bg-[var(--chart-1)]'}`} style={{ height: `${p.bytesPerDay == null ? 8 : Math.max(2, p.bytesPerDay / max * 100)}%` }} />
              </button>
            )
          })}
        </div>
        <div className="mt-1 flex justify-between text-xs text-fg-3">
          <span>24 hours ago</span>
          <span>Now</span>
        </div>
        {point && (
          <p aria-live="polite" className="mt-2 text-xs text-fg-2">
            {`${24 - selected}–${23 - selected} h ago · ${coverage(point.coveredHours)} · ${point.bytesPerDay == null ? 'Not enough data for a rate' : `${gb(point.bytes)} written (estimated)`}`}
          </p>
        )}
      </div>
      <p className="text-xs text-fg-2 text-pretty">
        Daily rates are projections, not daily totals. Hourly samples capture firmware, sleepypod and OS writes together.
        Reboots, counter resets and long sampling gaps are excluded; missing data is not zero writes.
        Window boundaries are estimated between samples. GB uses 1,000,000,000 bytes.
      </p>
      <p className="text-xs text-fg-2 text-pretty">
        Keeping transient data in RAM, saving only changed values and batching database updates can reduce writes.
        Smaller log or archive retention limits mainly reclaim space: deleting data does not undo its writes.
        RAM buffers lose unflushed data on power loss. Compare full 24-hour windows with similar usage;
        updates and archive jobs can cause short bursts. These counters do not measure the flash chip’s internal write amplification.
      </p>
    </div>
  )
}

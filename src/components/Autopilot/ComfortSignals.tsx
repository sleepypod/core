import type { ComfortSignals as Signals } from '@/src/comfort/signals'

/** Only displays evaluated evidence; enabling this guard never activates hardware. */
export function ComfortSignals({ signals }: { signals: Signals | null | undefined }) {
  const labels = { learning: 'Building your baseline', stale: 'Waiting for evidence', review: 'Proposal held', ready: 'Comparison ready' }
  return (
    <div className="rounded-ctl border border-line p-4 text-sm" aria-label="Personal Pod baseline">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Your Pod baseline</h3>
        <span className="text-xs text-fg-2">{signals ? labels[signals.state] : 'Waiting for evaluation'}</span>
      </div>
      <p className="mt-2 text-fg-2">{signals?.reason ?? 'No current sensor evaluation is available yet.'}</p>
      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-fg-2">Qualified days</dt>
          <dd className="mt-1 font-medium">{signals ? `${signals.baselineDays} / 7 minimum` : 'Unavailable'}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-2">Personal heart-rate baseline</dt>
          <dd className="mt-1 font-medium">{signals?.baselineHeartRate == null ? 'Learning' : `${Math.round(signals.baselineHeartRate)} bpm`}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-2">Recent five-minute summaries</dt>
          <dd className="mt-1 font-medium">{signals?.recentHeartRates.length === 2 ? `${signals.recentHeartRates.map(value => Math.round(value)).join(' → ')} bpm` : 'Incomplete'}</dd>
        </div>
      </dl>
      <p className="mt-4 text-xs text-fg-2">
        Each summary needs five qualified minute estimates. A baseline day needs twelve summaries; days carry equal weight.
        {' '}
        Apple Health stays a separate comparison source. These estimates do not diagnose sleep or medical conditions.
      </p>
    </div>
  )
}

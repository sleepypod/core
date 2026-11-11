import type { JournalContextPatterns as ContextPatterns } from '@/src/journal/contextPatterns'

export function JournalContextPatterns({ patterns }: { patterns: ContextPatterns }) {
  return (
    <div className="space-y-4 border-t border-line pt-4">
      <div className="max-w-prose space-y-1">
        <h3 className="font-medium">Habits and feeling too warm</h3>
        <p className="text-sm text-fg-2">Compare your own comfort check-ins. A result appears after five usable dates in each group.</p>
      </div>
      {!patterns.cohorts.length && <p className="text-sm text-fg-2">Log a little context with your morning check-in to begin.</p>}
      {patterns.cohorts.map(cohort => (
        <div key={`${cohort.side}:${cohort.origin}:${cohort.timeZone}`} className="space-y-3 text-sm">
          <p className="break-words text-fg-2">
            {cohort.dates}
            {' '}
            distinct dates ·
            {' '}
            {cohort.origin === 'sleepypod' ? 'Core journal' : 'Imported journal'}
            {' '}
            ·
            {' '}
            {cohort.side}
            {' '}
            side ·
            {' '}
            {cohort.timeZone}
          </p>
          {cohort.comparisons.filter((comparison): comparison is typeof comparison & { warmRateDifferencePoints: number } => comparison.warmRateDifferencePoints !== null).map(comparison => (
            <div key={comparison.id} className="max-w-prose space-y-1 border-t border-line py-3">
              <h4 className="font-medium">{comparison.label}</h4>
              <p>
                {comparison.withLabel}
                : too warm on
                {' '}
                {comparison.withWarmCount}
                {' '}
                of
                {' '}
                {comparison.withCount}
                {' '}
                dates.
                {' '}
                {comparison.withoutLabel}
                : too warm on
                {' '}
                {comparison.withoutWarmCount}
                {' '}
                of
                {' '}
                {comparison.withoutCount}
                {' '}
                dates.
              </p>
              <p className="text-fg-2">
                {comparison.warmRateDifferencePoints === 0
                  ? 'No difference at this precision (0 percentage points)'
                  : `${Math.abs(comparison.warmRateDifferencePoints)} percentage points ${comparison.warmRateDifferencePoints < 0 ? 'lower' : 'higher'} in the first group`}
                {' · '}
                {' '}
                {comparison.excludedCount}
                {' '}
                entries excluded. Association only.
              </p>
            </div>
          ))}
          {!cohort.comparisons.some(comparison => comparison.warmRateDifferencePoints !== null) && <p>No comparison has enough usable dates yet.</p>}
          <details>
            <summary className="min-h-11 cursor-pointer content-center">Comparison definitions and counts</summary>
            <dl className="space-y-3 pt-2">
              {cohort.comparisons.map(comparison => (
                <div key={comparison.id} className="grid gap-1 border-b border-line pb-3 sm:grid-cols-2">
                  <dt>{comparison.label}</dt>
                  <dd className="text-fg-2">
                    {comparison.withLabel}
                    :
                    {' '}
                    {comparison.withCount}
                    {' '}
                    ·
                    {' '}
                    {comparison.withoutLabel}
                    :
                    {' '}
                    {comparison.withoutCount}
                    {' '}
                    · Excluded:
                    {' '}
                    {comparison.excludedCount}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      ))}
      <p className="max-w-prose text-xs leading-relaxed text-fg-2">{patterns.note}</p>
    </div>
  )
}

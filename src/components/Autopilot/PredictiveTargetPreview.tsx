'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/src/components/ds'
import type { Side } from '@/src/hardware/types'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { trpc } from '@/src/utils/trpc'
import { predictiveTargetPreviewSchema } from '@/src/comfort/predictive-contract'

/** Explicit, short-lived research reads. There is deliberately no Apply action. */
export function PredictiveTargetPreview({ side }: { side: Side }) {
  const [requested, setRequested] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const query = trpc.comfort.predictiveTargetPreview.useQuery({ side }, {
    enabled: false, retry: false, refetchOnWindowFocus: false,
  })
  const { formatTemp } = useTemperatureUnit()
  const temperature = (fahrenheit: number) => formatTemp((fahrenheit - 32) * 5 / 9)
  const parsed = predictiveTargetPreviewSchema.safeParse(query.data)
  const expiresAt = parsed.success ? parsed.data.expiresAt ?? parsed.data.generatedAt + 15_000 : null
  useEffect(() => {
    if (!requested) return
    const refreshClock = () => setNow(Date.now())
    const timer = setTimeout(refreshClock, Math.max(0, (expiresAt ?? Date.now()) - Date.now()) + 1)
    document.addEventListener('visibilitychange', refreshClock)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', refreshClock)
    }
  }, [expiresAt, requested, query.dataUpdatedAt])
  const data = requested && parsed.success && !query.error && !query.isFetching
    && parsed.data.side === side && parsed.data.generatedAt <= now && expiresAt !== null && expiresAt > now
    ? parsed.data
    : null
  const title = data?.disposition === 'candidate' && data.proposedTargetF !== null
    ? `${temperature(data.proposedTargetF)} is an experiment candidate`
    : data?.disposition === 'hold' && data.currentTargetF !== null
      ? `Keep ${temperature(data.currentTargetF)} in this comparison`
      : 'A comparison is not ready yet'
  return (
    <section aria-label="Predictive target comparison" className="space-y-4 border-t border-line pt-5">
      <div className="space-y-2">
        <h4 className="text-base font-medium">Compare a small change with holding</h4>
        <p className="max-w-prose text-sm text-fg-2">Check whether a nearby target could track your bounded overnight plan more closely. This compares water estimates for the next 15 and 30 minutes. Your bed keeps following its current plan.</p>
      </div>
      <Button
        variant="secondary"
        className="min-h-11 w-full min-w-0 max-w-full whitespace-normal text-sm sm:w-auto"
        disabled={query.isFetching}
        onClick={() => {
          setRequested(true)
          setNow(Date.now())
          void query.refetch().finally(() => setNow(Date.now()))
        }}
      >
        {query.isFetching ? 'Comparing current readings…' : requested ? 'Refresh target comparison' : 'Compare with holding'}
      </Button>
      {data && (
        <div className="space-y-4">
          <div className="space-y-2" role="status">
            <h5 className="text-base font-medium">{title}</h5>
            <p className="max-w-prose text-sm text-fg-2">{data.reason}</p>
            {data.desiredWaterF !== null && <p className="text-sm">{`Tracking objective: ${temperature(data.desiredWaterF)} water, within your overnight limits.`}</p>}
          </div>
          {data.comparisons.length > 0 && (
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer py-3 font-medium">See the alternatives and their uncertainty</summary>
              <div className="divide-y divide-line">
                {data.comparisons.map(comparison => (
                  <div key={comparison.targetF} className="space-y-2 py-4">
                    <p className="font-medium">{`${comparison.kind === 'hold' ? 'Hold' : 'Target'} ${temperature(comparison.targetF)} · ${comparison.targetF === data.proposedTargetF ? 'Research choice' : 'Alternative'}`}</p>
                    {comparison.predictions.map(prediction => (
                      <p key={prediction.minutes} className="text-fg-2 tabular-nums">{`${prediction.minutes} min: ${temperature(prediction.lowerF)}–${temperature(prediction.upperF)} water`}</p>
                    ))}
                    {comparison.predictions.length === 0 && <p className="text-fg-2">{comparison.reason}</p>}
                  </div>
                ))}
              </div>
            </details>
          )}
          <p className="max-w-prose text-sm text-fg-2">A change must beat holding at both horizons after allowing for prediction error and a cost for changing. These are conditional estimates, not proof of better comfort. No adjustment was sent.</p>
        </div>
      )}
      {requested && !data && (
        <p role={query.error ? 'alert' : 'status'} className="max-w-prose text-sm text-fg-2">
          {query.isFetching
            ? 'Reading fresh conditions and checking both models…'
            : query.error
              ? 'The comparison could not be read. Check the connection and update Core if this feature is unavailable, then refresh.'
              : 'This comparison has expired or could not be verified. Refresh to use current readings.'}
        </p>
      )}
    </section>
  )
}

'use client'

import { useState } from 'react'
import { Button } from '@/src/components/ds'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import type { Side } from '@/src/hardware/types'
import { predictiveOutcomeSchema, predictiveOutcomeReasons } from '@/src/comfort/predictive-outcome-contract'
import { trpc } from '@/src/utils/trpc'

/** Observed water accuracy stays distinct from an unapplied suggestion or a comfort improvement. */
export function PredictiveOutcomeReview({ side }: { side: Side }) {
  const [requestedSide, setRequestedSide] = useState<Side | null>(null)
  const [completedSide, setCompletedSide] = useState<Side | null>(null)
  const [checkedAt, setCheckedAt] = useState(() => Date.now())
  const requested = requestedSide === side
  const { unit, formatConverted } = useTemperatureUnit()
  const delta = (fahrenheit: number) => formatConverted(unit === 'C' ? fahrenheit * 5 / 9 : fahrenheit)
  const query = trpc.comfort.predictiveOutcomes.useQuery({ side }, { enabled: false, retry: false, refetchOnWindowFocus: false })
  const parsed = predictiveOutcomeSchema.safeParse(query.data)
  const data = requested && completedSide === side && parsed.success && parsed.data.side === side && parsed.data.generatedAt <= checkedAt
    && !query.error && !query.isFetching
    ? parsed.data
    : null
  return (
    <section aria-label="Forecast accuracy" className="space-y-3 border-t border-line pt-4">
      <h5 className="text-sm font-medium">How close were the forecasts?</h5>
      <p className="max-w-prose text-sm text-fg-2">Compare saved water estimates with later measurements from reviewed nights. Only periods where the target stayed unchanged can answer this question.</p>
      <Button
        variant="secondary"
        className="min-h-11 w-full min-w-0 whitespace-normal text-sm sm:w-auto"
        disabled={query.isFetching}
        onClick={() => {
          setRequestedSide(side)
          setCompletedSide(null)
          const complete = () => {
            setCheckedAt(Date.now())
            setCompletedSide(side)
          }
          void query.refetch().then(complete, complete)
        }}
      >
        {query.isFetching ? 'Checking observed outcomes…' : requested ? 'Refresh forecast accuracy' : 'Check forecast accuracy'}
      </Button>
      {data && (
        <div className="space-y-4">
          <p role="status" className="text-sm font-medium">{`${data.scored} comparisons checked · ${data.pending} awaiting the end of the night · ${data.withheld} excluded`}</p>
          {data.models.length === 0 && <p className="text-sm text-fg-2">No forecast has a complete, reviewed comparison yet. Keep using Preview and review completed nights; missing observations are never scored as zero error.</p>}
          {data.models.map((model, index) => (
            <div key={`${model.artifactId}:${model.datasetHash}:${model.configuration}`} className="space-y-3 border-t border-line py-4 sm:rounded-lg sm:border-0 sm:bg-bg-2 sm:p-4">
              <h6 className="text-sm font-medium">{`Forecast version ${index + 1} · ${model.reviewedNights} reviewed nights`}</h6>
              <p className="text-sm text-fg-2">Each night has equal weight. Lower error means a closer water estimate.</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {model.horizons.map(horizon => (
                  <div key={horizon.minutes} className="min-w-0 space-y-2 text-sm tabular-nums">
                    <p className="font-medium">{`${horizon.minutes} minutes ahead`}</p>
                    <p>{`Forecast error: ${delta(horizon.meanNightErrorF)}`}</p>
                    <p className="text-fg-2">{`If water had stayed the same: ${delta(horizon.meanNightPersistenceErrorF)} error`}</p>
                    <p className="text-fg-2">{`${Math.round(horizon.meanNightRangeCoverage * 100)}% inside the forecast range`}</p>
                  </div>
                ))}
              </div>
              <details className="text-xs text-fg-2">
                <summary className="min-h-11 cursor-pointer py-3">Source details</summary>
                <p className="break-all">{`Model ${model.artifactId}; dataset ${model.datasetHash}; configuration ${model.configuration}.`}</p>
                <p>{`${model.comparisons} overlapping comparisons; these are not independent nights.`}</p>
              </details>
            </div>
          ))}
          {data.exclusions.length > 0 && (
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer py-3 font-medium">Why comparisons were excluded</summary>
              <ul className="list-disc space-y-2 pl-5 text-fg-2">
                {data.exclusions.map(item => <li key={item.code}>{`${item.count}: ${predictiveOutcomeReasons[item.code]}`}</li>)}
              </ul>
            </details>
          )}
          <p className="max-w-prose text-sm text-fg-2">{data.notice}</p>
          <p className="text-xs text-fg-3">{`Checked ${new Date(data.generatedAt).toLocaleString()}. This does not enable temperature changes.`}</p>
        </div>
      )}
      {requested && !data && !query.isFetching && <p role="alert" className="text-sm text-fg-2">Forecast accuracy could not be verified. Another background read may be running; refresh after checking the connection and Core version.</p>}
    </section>
  )
}
